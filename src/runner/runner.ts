import { resolve } from "node:path";
import { runAssertion, type AssertionResult } from "../assertions/assertions.js";
import { loadTrace } from "../importers/index.js";
import { runCascade, type RubricResult } from "../judges/cascade.js";
import type { Judge, JudgeUsage } from "../judges/types.js";
import type { Case, Suite } from "../suite.js";
import type { Trace, Usage } from "../trace/schema.js";

export type Status = "pass" | "fail" | "unjudged" | "error";

export interface RunResult {
  run: number;
  traceId?: string;
  status: Status;
  error?: string;
  assertions: AssertionResult[];
  rubric: RubricResult[];
  agentUsage?: Usage;
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
  k: number;
  agentTokens: number;
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
  const judges = opts.judges ?? [];
  const startedAt = new Date().toISOString();
  const cases = suite.cases.filter((c) => !opts.only?.length || opts.only.includes(c.id));
  const jobs: Array<{ c: Case; run: number }> = [];
  for (const c of cases) for (let run = 0; run < runsFor(c, suite, opts.mode, opts.runs); run++) jobs.push({ c, run });

  const byCase = new Map<string, RunResult[]>(cases.map((c) => [c.id, []]));
  await pool(jobs, opts.concurrency ?? 4, async ({ c, run }) => {
    const r = await runOne(suite, c, run, opts.provider, judges);
    byCase.get(c.id)!.push(r);
    opts.onRun?.(c.id, r);
  });

  const caseResults = cases.map((c) => caseResult(c.id, byCase.get(c.id)!.sort((a, b) => a.run - b.run)));
  return { suite: suite.suite, startedAt, mode: opts.mode, judges: judges.map((j) => j.tier), cases: caseResults, summary: summarize(caseResults) };
}

async function runOne(suite: Suite, c: Case, run: number, provider: TraceProvider, judges: Judge[]): Promise<RunResult> {
  const t0 = Date.now();
  let trace: Trace;
  try {
    trace = await provider(c, run);
  } catch (err) {
    return { run, status: "error", error: err instanceof Error ? err.message : String(err), assertions: [], rubric: [], judgeUsage: {}, durationMs: Date.now() - t0 };
  }
  if (c.task && !trace.task) trace = { ...trace, task: c.task };

  const assertions = [...(suite.defaults?.expect ?? []), ...c.expect].map((a) => runAssertion(trace, a));
  const rubrics = [...(suite.defaults?.rubric ?? []), ...c.rubric];
  const cascade = rubrics.length ? await runCascade(trace, rubrics, judges) : { rubric: [], usageByTier: {} };

  const failed = assertions.some((a) => !a.passed) || cascade.rubric.some((r) => r.status === "fail");
  const unjudged = cascade.rubric.some((r) => r.status === "unjudged");
  return {
    run,
    traceId: trace.id,
    status: failed ? "fail" : unjudged ? "unjudged" : "pass",
    assertions,
    rubric: cascade.rubric,
    agentUsage: trace.usage,
    judgeUsage: cascade.usageByTier,
    durationMs: trace.durationMs ?? Date.now() - t0,
  };
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
  return {
    cases: cases.length,
    passed: count("pass"),
    failed: count("fail"),
    unjudged: count("unjudged"),
    errored: count("error"),
    runs: runs.length,
    passAt1: cases.length ? cases.reduce((s, c) => s + c.passRate, 0) / cases.length : 0,
    passHatK: cases.length ? cases.filter((c) => c.allPassed).length / cases.length : 0,
    k: cases.length ? Math.max(...cases.map((c) => c.runs.length)) : 0,
    agentTokens,
    ...(agentCostSeen ? { agentCostUsd: agentCost } : {}),
    ...(judgeCostSeen ? { judgeCostUsd: judgeCost } : {}),
    decidedByTier,
    rubricQuestions,
  };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
