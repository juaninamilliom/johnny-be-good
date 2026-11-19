import { resolve } from "node:path";
import { runAssertion, type AssertionResult } from "../assertions/assertions.js";
import { loadTrace, hasRecordedTokenUsage } from "../importers/index.js";
import { runCascade, type RubricResult } from "../judges/cascade.js";
import type { Judge, JudgeUsage } from "../judges/types.js";
import { SuiteSchema, type Case, type Suite } from "../suite.js";
import { TraceSchema, type Trace, type Usage } from "../trace/schema.js";
import type { ArtifactStore, FileArtifact } from "./artifacts.js";

export type Status = "pass" | "fail" | "unjudged" | "error";

export interface RunResult {
  run: number;
  traceId?: string;
  traceArtifact?: FileArtifact;
  status: Status;
  error?: string;
  assertions: AssertionResult[];
  rubric: RubricResult[];
  agentUsage?: Usage;
  /** Whether token counters were supplied by the trace producer, rather than schema defaults. */
  agentUsageRecorded?: boolean;
  judgeUsage: Record<string, JudgeUsage>;
  durationMs?: number;
}

export interface CaseResult {
  id: string;
  status: Status;
  runs: RunResult[];
  /** Fraction of runs that passed. */
  passRate: number;
  /** True when every run passed. With k runs this is pass^k for the case. */
  allPassed: boolean;
}

export interface SuiteResult {
  suite: string;
  startedAt: string;
  mode: "offline" | "online";
  judges: string[];
  cases: CaseResult[];
  summary: Summary;
  artifacts?: { manifest: string; report: string };
}

export interface Summary {
  cases: number;
  passed: number;
  failed: number;
  unjudged: number;
  errored: number;
  runs: number;
  /** Mean per-case pass rate: the chance one run of a random case passes. */
  passAt1: number;
  /** Fraction of cases whose every run passed. */
  passHatK: number;
  /** Uniform trial count, or 0 for mixed trial counts. */
  k: number;
  uniformK?: boolean;
  trialCounts?: number[];
  byTrialCount?: Array<{ k: number; cases: number; allPassed: number; passRate: number }>;
  agentTokens: number;
  agentUsageRecordedRuns?: number;
  agentCostRecordedRuns?: number;
  agentCostUsd?: number;
  judgeCostUsd?: number;
  /** How many rubric questions each tier decided. */
  decidedByTier: Record<string, number>;
  rubricQuestions: number;
}

/** Produces the trace for one run of one case. */
export type TraceProvider = (c: Case, run: number) => Promise<Trace>;

export interface RunOptions {
  judges?: Judge[];
  provider: TraceProvider;
  mode: "offline" | "online";
  /** Runs per case when the case does not say. */
  runs?: number;
  only?: string[];
  concurrency?: number;
  onRun?: (caseId: string, r: RunResult) => void;
  /** Opt-in archive of full responses and tool payloads. */
  artifacts?: ArtifactStore;
}

/** Offline provider: reads `trace` or `traces[run]` relative to the suite file's directory. */
export function recordedTraces(baseDir: string): TraceProvider {
  return async (c, run) => {
    const paths = c.traces ?? (c.trace ? [c.trace] : []);
    const p = paths[run];
    if (!p) throw new Error(`case "${c.id}" has no recorded trace for run ${run + 1}`);
    return loadTrace(resolve(baseDir, p));
  };
}

export function runsFor(c: Case, suite: Suite, mode: "offline" | "online", fallback?: number): number {
  if (mode === "offline") return Math.max(1, (c.traces ?? (c.trace ? [c.trace] : [])).length);
  return c.runs ?? fallback ?? suite.runs;
}

export async function runSuite(suite: Suite, opts: RunOptions): Promise<SuiteResult> {
  suite = SuiteSchema.parse(suite);
  if (opts.mode !== "online" && opts.mode !== "offline") throw new Error("mode must be online or offline");
  for (const [name, value] of [["concurrency", opts.concurrency], ["runs", opts.runs]] as const) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive safe integer`);
  if (opts.only && (!opts.only.length || opts.only.some(id => !suite.cases.some(c => c.id === id)))) throw new Error("Case selection must contain existing case IDs");
  const judges = opts.judges ?? [];
  if (new Set(judges.map(j => j.tier)).size !== judges.length) throw new Error("Judge tier names must be unique");
  const startedAt = new Date().toISOString();
  const cases = suite.cases.filter(c => !opts.only || opts.only.includes(c.id));
  const jobs: Array<{ c: Case; run: number }> = [];
  for (const c of cases) {
    const count = runsFor(c, suite, opts.mode, opts.runs);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Case runs must be a positive safe integer");
    for (let run = 0; run < count; run++) jobs.push({ c, run });
  }
  if (opts.artifacts) await opts.artifacts.begin(suite, opts.mode, { judges: judges.map(j => j.tier), cases: cases.map(c => ({ id: c.id, runs: runsFor(c, suite, opts.mode, opts.runs) })), concurrency: opts.concurrency ?? 4 });
  try {
    const byCase = new Map<string, RunResult[]>(cases.map(c => [c.id, []]));
    await pool(jobs, opts.concurrency ?? 4, async ({ c, run }) => {
      const r = await runOne(suite, c, run, opts.provider, judges, opts.artifacts);
      if (opts.artifacts) await opts.artifacts.saveResult(c.id, r);
      byCase.get(c.id)!.push(r); opts.onRun?.(c.id, r);
    });
    const caseResults = cases.map(c => caseResult(c.id, byCase.get(c.id)!.sort((a, b) => a.run - b.run)));
    const result: SuiteResult = { suite: suite.suite, startedAt, mode: opts.mode, judges: judges.map(j => j.tier), cases: caseResults, summary: summarize(caseResults), ...(opts.artifacts ? { artifacts: { manifest: "manifest.json", report: "report.json" } } : {}) };
    if (opts.artifacts) await opts.artifacts.finalize(result);
    return result;
  } catch (error) {
    if (opts.artifacts) {
      try { await opts.artifacts.abort(error); }
      catch (persistenceError) { throw new AggregateError([error, persistenceError], "Experiment failed and its incomplete manifest could not be updated"); }
    }
    throw error;
  }
}

async function runOne(suite: Suite, c: Case, run: number, provider: TraceProvider, judges: Judge[], artifacts?: ArtifactStore): Promise<RunResult> {
  const t0 = Date.now();
  let trace: Trace;
  try {
    const provided = await provider(c, run);
    trace = TraceSchema.parse(provided);
    trace.meta = { ...trace.meta, usageProvided: hasRecordedTokenUsage(provided) };
  } catch (err) {
    return { run, status: "error", error: err instanceof Error ? err.message : String(err), assertions: [], rubric: [], judgeUsage: {}, durationMs: Date.now() - t0 };
  }
  if (c.task && !trace.task) trace = { ...trace, task: c.task };

  const traceArtifact = artifacts ? await artifacts.saveTrace(c.id, run, trace) : undefined;
  if (trace.meta && Object.prototype.hasOwnProperty.call(trace.meta, "exitCode") && trace.meta.exitCode !== 0) {
    return { run, traceId: trace.id, ...(traceArtifact ? { traceArtifact } : {}), status: "error", error: `Target process exited unsuccessfully (${String(trace.meta.exitCode)})`, assertions: [], rubric: [], agentUsage: trace.usage, agentUsageRecorded: trace.meta?.usageProvided !== false, judgeUsage: {}, durationMs: trace.durationMs ?? Date.now() - t0 };
  }
  try {
  const assertions = [...(suite.defaults?.expect ?? []), ...c.expect].map((a) => runAssertion(trace, a));
  const rubrics = [...(suite.defaults?.rubric ?? []), ...c.rubric];
  const cascade = rubrics.length ? await runCascade(trace, rubrics, judges) : { rubric: [], usageByTier: {} };

  const failed = assertions.some((a) => !a.passed) || cascade.rubric.some((r) => r.status === "fail");
  const unjudged = cascade.rubric.some((r) => r.status === "unjudged");
  return {
    run,
    traceId: trace.id,
    ...(traceArtifact ? { traceArtifact } : {}),
    status: failed ? "fail" : unjudged ? "unjudged" : "pass",
    assertions,
    rubric: cascade.rubric,
    agentUsage: trace.usage,
    agentUsageRecorded: trace.meta?.usageProvided !== false,
    judgeUsage: cascade.usageByTier,
    durationMs: trace.durationMs ?? Date.now() - t0,
  };
  } catch (error) {
    return { run, traceId: trace.id, ...(traceArtifact ? { traceArtifact } : {}), status: "error", error: error instanceof Error ? error.message : String(error), assertions: [], rubric: [], agentUsage: trace.usage, agentUsageRecorded: trace.meta?.usageProvided !== false, judgeUsage: {}, durationMs: Date.now() - t0 };
  }
}

function caseResult(id: string, runs: RunResult[]): CaseResult {
  const passed = runs.filter((r) => r.status === "pass").length;
  const status: Status = runs.some((r) => r.status === "fail")
    ? "fail"
    : runs.some((r) => r.status === "error")
      ? "error"
      : runs.some((r) => r.status === "unjudged")
        ? "unjudged"
        : "pass";
  return { id, status, runs, passRate: runs.length ? passed / runs.length : 0, allPassed: runs.length > 0 && passed === runs.length };
}

export function summarize(cases: CaseResult[]): Summary {
  const runs = cases.flatMap((c) => c.runs);
  const decidedByTier: Record<string, number> = {};
  let rubricQuestions = 0;
  let agentCost = 0;
  let agentCostSeen = false;
  let judgeCost = 0;
  let judgeCostSeen = false;
  let agentTokens = 0;
  for (const r of runs) {
    for (const q of r.rubric) {
      rubricQuestions++;
      if (q.decidedBy) decidedByTier[q.decidedBy] = (decidedByTier[q.decidedBy] ?? 0) + 1;
    }
    if (r.agentUsage) {
      agentTokens += r.agentUsage.inputTokens + r.agentUsage.outputTokens + r.agentUsage.cacheReadTokens + r.agentUsage.cacheWriteTokens;
      if (r.agentUsage.costUsd !== undefined) {
        agentCost += r.agentUsage.costUsd;
        agentCostSeen = true;
      }
    }
    for (const u of Object.values(r.judgeUsage)) {
      if (u.costUsd !== undefined) {
        judgeCost += u.costUsd;
        judgeCostSeen = true;
      }
    }
  }
  const count = (s: Status) => cases.filter((c) => c.status === s).length;
  const trialCounts = [...new Set(cases.map(c => c.runs.length))].sort((a, b) => a - b);
  const byTrialCount = trialCounts.map(k => {
    const group = cases.filter(c => c.runs.length === k), allPassed = group.filter(c => c.allPassed).length;
    return { k, cases: group.length, allPassed, passRate: group.length ? allPassed / group.length : 0 };
  });
  return {
    cases: cases.length,
    passed: count("pass"),
    failed: count("fail"),
    unjudged: count("unjudged"),
    errored: count("error"),
    runs: runs.length,
    passAt1: cases.length ? cases.reduce((s, c) => s + c.passRate, 0) / cases.length : 0,
    passHatK: cases.length ? cases.filter((c) => c.allPassed).length / cases.length : 0,
    k: trialCounts.length === 1 ? trialCounts[0]! : 0,
    uniformK: trialCounts.length === 1,
    trialCounts,
    byTrialCount,
    agentTokens,
    agentUsageRecordedRuns: runs.filter(r => r.agentUsage && r.agentUsageRecorded !== false).length,
    agentCostRecordedRuns: runs.filter(r => r.agentUsage?.costUsd !== undefined).length,
    ...(agentCostSeen ? { agentCostUsd: agentCost } : {}),
    ...(judgeCostSeen ? { judgeCostUsd: judgeCost } : {}),
    decidedByTier,
    rubricQuestions,
  };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0, stopped = false;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const item = items[next++]!;
      try { await fn(item); }
      catch (error) { stopped = true; throw error; }
    }
  });
  // Drain already-started work before finalizing an incomplete manifest. No artifact writes continue after rejection.
  const settled = await Promise.allSettled(workers);
  const errors = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason as unknown);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Several experiment workers failed");
}
