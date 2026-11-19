import { Terminal, seg, syntax, type TerminalOptions } from "./terminal.js";
import type { AssertionResult } from "../assertions/assertions.js";
import type { CaseResult, Status, SuiteResult } from "../runner/runner.js";

export interface CaseDiff {
  id: string;
  before?: Status;
  after?: Status;
  beforeRate?: number;
  afterRate?: number;
  change: "regressed" | "fixed" | "new" | "removed" | "same" | "rate-down" | "rate-up";
}

export interface BaselineDiff {
  regressions: CaseDiff[];
  fixes: CaseDiff[];
  all: CaseDiff[];
}

/**
 * Compares a run with a saved result. A case regresses when it passed before and does
 * not now, or when its pass rate across runs dropped. Unjudged and errored cases count
 * as not passing, so a judge outage shows up as a regression.
 */
export function diffBaseline(before: SuiteResult, after: SuiteResult): BaselineDiff {
  const prev = new Map(before.cases.map((c) => [c.id, c]));
  const next = new Map(after.cases.map((c) => [c.id, c]));
  const all: CaseDiff[] = [];
  for (const [id, a] of next) {
    const b = prev.get(id);
    if (!b) {
      all.push({ id, after: a.status, afterRate: a.passRate, change: "new" });
      continue;
    }
    const base = { id, before: b.status, after: a.status, beforeRate: b.passRate, afterRate: a.passRate };
    if (b.status === "pass" && a.status !== "pass") all.push({ ...base, change: "regressed" });
    else if (b.status !== "pass" && a.status === "pass") all.push({ ...base, change: "fixed" });
    else if (a.passRate < b.passRate) all.push({ ...base, change: "rate-down" });
    else if (a.passRate > b.passRate) all.push({ ...base, change: "rate-up" });
    else all.push({ ...base, change: "same" });
  }
  for (const [id, b] of prev) if (!next.has(id)) all.push({ id, before: b.status, beforeRate: b.passRate, change: "removed" });
  return {
    regressions: all.filter((d) => d.change === "regressed" || d.change === "rate-down"),
    fixes: all.filter((d) => d.change === "fixed" || d.change === "rate-up"),
    all,
  };
}

const ICON: Record<Status, string> = { pass: "✓", fail: "✗", unjudged: "?", error: "!" };
export interface ReportOptions extends TerminalOptions { verbose?: boolean; diff?: BaselineDiff; judgesDisabled?: boolean }

export function formatResult(result: SuiteResult, opts: ReportOptions = {}): string {
  const t = new Terminal(opts);
  const out = ["", t.line([seg("tracecheck", "cyan"), seg(`  /  ${result.suite}`, "bold")]),
    t.line([seg(result.mode === "offline" ? "OFFLINE REPLAY" : "ONLINE RUN", "muted"), seg(`    ${result.summary.cases} ${result.summary.cases === 1 ? "case" : "cases"} · ${result.summary.runs} ${result.summary.runs === 1 ? "run" : "runs"}    `, "muted"), seg(opts.judgesDisabled ? "JUDGES OFF" : `JUDGES ${result.judges.join(" → ") || "NONE"}`, result.judges.length ? "cyan" : "unjudged")]),
    "", t.rule()];
  for (const c of result.cases) out.push("", ...formatCase(c, t, opts));
  const s = result.summary;
  const runs = result.cases.flatMap(c => c.runs);
  const counts = (status: Status) => runs.filter(r => r.status === status).length;
  const checks = runs.flatMap(r => r.assertions);
  const undecided = runs.flatMap(r => r.rubric).filter(q => q.status === "unjudged").length;
  out.push("", t.rule(), "", t.line([seg("RESULT  ", "bold"), seg(`${s.passed}/${s.cases} cases passed`, "bold"),
    seg(` · ${s.failed} failed`, s.failed ? "fail" : "muted"), seg(` · ${s.unjudged} unjudged`, s.unjudged ? "unjudged" : "muted"), seg(` · ${s.errored} errored`, s.errored ? "error" : "muted")]));
  out.push(t.line([seg("RUNS    ", "muted"), seg(`${counts("pass")} passed`, "pass"), seg(" · ", "muted"), seg(`${counts("fail")} failed`, counts("fail") ? "fail" : "muted"), seg(" · ", "muted"), seg(`${counts("unjudged")} unjudged`, counts("unjudged") ? "unjudged" : "muted"), seg(` · ${counts("error")} errored`, counts("error") ? "error" : "muted")]));
  out.push(t.line([seg("CHECKS  ", "muted"), seg(checks.length ? `${checks.filter(a => a.passed).length}/${checks.length} exact checks passed` : "No exact checks configured", !checks.length ? "muted" : checks.some(a => !a.passed) ? "fail" : "pass"), ...(s.rubricQuestions ? [seg(` · ${undecided}/${s.rubricQuestions} rubric questions unjudged`, undecided ? "unjudged" : "muted")] : [])]));
  if (s.k > 1) out.push(t.line([seg("RELIABILITY  ", "muted"), seg(`pass@1 ${pct(s.passAt1)} · pass^${s.k} ${pct(s.passHatK)} over ${s.runs} runs`)]));
  if (Object.keys(s.decidedByTier).length) out.push(t.line([seg("JUDGES  ", "muted"), seg(Object.entries(s.decidedByTier).map(([tier, n]) => `${tier}: ${n} decided`).join(" · "), "cyan")]));
  const costs = [`${s.agentTokens.toLocaleString("en-US")} ${result.mode === "offline" ? "tokens in recorded traces" : "agent tokens"}${s.agentCostUsd !== undefined ? ` ($${s.agentCostUsd.toFixed(4)})` : ""}`];
  if (s.judgeCostUsd !== undefined) costs.push(`judges $${s.judgeCostUsd.toFixed(5)}`);
  if (opts.judgesDisabled) costs.push("no model judge calls this run");
  out.push(t.line([seg("USAGE   ", "muted"), seg(costs.join(" · "), "muted")]));
  if (undecided) out.push("", t.line([seg(opts.judgesDisabled ? "Judges are off: passing exact checks does not mean the full eval passed." : "Unjudged questions prevent a pass. Check judge configuration and failures above.", "unjudged")]));
  if (opts.diff) {
    out.push("", t.line([seg("BASELINE", "bold")]));
    if (!opts.diff.regressions.length && !opts.diff.fixes.length) out.push(t.line([seg("No changes", "muted")], 2));
    for (const d of opts.diff.regressions) out.push(t.line([seg(`REGRESSED ${d.id}`, "fail"), seg(`: ${d.before} → ${d.after} (pass rate ${pct(d.beforeRate ?? 0)} → ${pct(d.afterRate ?? 0)})`)], 2));
    for (const d of opts.diff.fixes) out.push(t.line([seg(`FIXED ${d.id}`, "pass"), seg(`: ${d.before} → ${d.after} (pass rate ${pct(d.beforeRate ?? 0)} → ${pct(d.afterRate ?? 0)})`)], 2));
  }
  out.push("");
  return out.join("\n");
}

function formatCase(c: CaseResult, t: Terminal, opts: ReportOptions): string[] {
  const lines = [t.line([seg(`${c.status.toUpperCase()}  `, c.status), seg(c.id, "bold")])];
  for (const r of c.runs) {
    const passed = r.assertions.filter(a => a.passed).length;
    lines.push("", t.line([seg(`RUN ${String(r.run + 1).padStart(2, "0")}  `, "bold"), seg(r.status.toUpperCase(), r.status), seg(r.assertions.length ? ` · ${passed}/${r.assertions.length} exact checks passed` : " · no exact checks configured", "muted")], 2));
    if (r.error) lines.push(t.line([seg("! ", "error"), seg(r.error, "fail")], 4));
    for (const a of r.assertions) {
      if (!a.passed || opts.verbose) {
        lines.push(t.line([seg(`${a.passed ? "✓" : "✗"} `, a.passed ? "pass" : "fail"), seg(assertionName(a), a.passed ? "normal" : "fail")], 4));
        if (a.diagnostic) {
          if (!a.passed) lines.push(t.line([seg("expected  ", "muted"), ...syntax(a.diagnostic.expected)], 6));
          lines.push(t.line([seg(a.passed ? "" : "actual    ", "muted"), ...syntax(a.diagnostic.actual)], 6));
        }
        if (a.detail) lines.push(t.line([seg(a.detail, "muted")], 6));
      }
    }
    if (!opts.verbose && passed) lines.push(t.line([seg("✓ ", "pass"), seg(`${passed} exact checks passed (use --verbose for details)`, "muted")], 4));
    for (const q of r.rubric) {
      if (q.status === "pass" && !opts.verbose) continue;
      const last = q.verdicts.at(-1);
      const how = q.decidedBy ? `${q.decidedBy}: ${fmtValue(last?.value)}${last?.confidence !== undefined ? ` @ ${last.confidence.toFixed(2)}` : ""}`
        : opts.judgesDisabled ? "judges are disabled" : q.verdicts.length ? `undecided (${q.verdicts.map(v => `${v.tier} ${fmtValue(v.value)}`).join(", ")})` : "no judge answered";
      lines.push(t.line([seg(`${ICON[q.status]} `, q.status), seg(q.id, q.status), seg(` · ${how}`, "muted")], 4));
      for (const f of q.failures) lines.push(t.line([seg(`${f.tier} failed: ${f.error}`, "fail")], 6));
    }
  }
  return lines;
}
function assertionName(a: AssertionResult): string {
  const names: Record<string, string> = { maxToolCalls: "Tool budget", maxSteps: "Step budget", maxTokens: "Token budget", maxCostUsd: "Cost budget", noToolErrors: "Tool results", toolCalled: "Required tool", toolNotCalled: "Forbidden tool", toolOrder: "Tool order", final: "Answer format", expectedFindings: "Expected findings" };
  if (a.kind === "toolCalled" && a.diagnostic) return "Required tool";
  if (a.kind === "noToolErrors") return a.passed ? "Tool results · no errors" : "Tool results · errors found";
  if (a.kind === "toolNotCalled") return `Forbidden tool · ${a.label.replace(/^toolNotCalled /, "")} ${a.passed ? "was not called" : "was called"}`;
  if (a.kind === "maxToolCalls") return `Tool budget · max ${a.label.replace(/^maxToolCalls /, "")} calls`;
  return `${names[a.kind] || a.kind} · ${a.label}`;
}

function fmtValue(v: number | string | undefined): string {
  return typeof v === "number" ? v.toFixed(2) : String(v);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

/** 0 all passed, 1 a failure, error or regression, 2 only unjudged cases kept it from passing. */
export function exitCode(result: SuiteResult, diff?: BaselineDiff): number {
  if (result.summary.failed || result.summary.errored || diff?.regressions.length) return 1;
  if (result.summary.unjudged) return 2;
  return 0;
}
