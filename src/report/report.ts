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

export function formatResult(result: SuiteResult, opts: { verbose?: boolean; diff?: BaselineDiff } = {}): string {
  const out: string[] = [];
  out.push(`tracecheck · ${result.suite} · ${result.mode} · judges: ${result.judges.join(" → ") || "none"}`);
  out.push("");
  for (const c of result.cases) out.push(...formatCase(c, opts.verbose ?? false));
  const s = result.summary;
  out.push("");
  out.push(`${s.passed}/${s.cases} cases passed` + (s.failed ? ` · ${s.failed} failed` : "") + (s.unjudged ? ` · ${s.unjudged} unjudged` : "") + (s.errored ? ` · ${s.errored} errored` : ""));
  if (s.k > 1) out.push(`pass@1 ${pct(s.passAt1)} · pass^${s.k} ${pct(s.passHatK)} over ${s.runs} runs`);
  if (s.rubricQuestions) {
    const tiers = Object.entries(s.decidedByTier).map(([t, n]) => `${t} ${n}`).join(", ");
    const undecided = s.rubricQuestions - Object.values(s.decidedByTier).reduce((a, b) => a + b, 0);
    out.push(`rubric: ${s.rubricQuestions} questions · decided by ${tiers || "no tier"}${undecided ? ` · ${undecided} unjudged` : ""}`);
  }
  const costs = [`agent ${s.agentTokens.toLocaleString("en-US")} tokens${s.agentCostUsd !== undefined ? ` ($${s.agentCostUsd.toFixed(4)})` : ""}`];
  if (s.judgeCostUsd !== undefined) costs.push(`judges $${s.judgeCostUsd.toFixed(5)}`);
  out.push(`cost: ${costs.join(" · ")}`);
  if (opts.diff) {
    out.push("");
    if (!opts.diff.regressions.length && !opts.diff.fixes.length) out.push("baseline: no changes");
    for (const d of opts.diff.regressions) out.push(`REGRESSED ${d.id}: ${d.before} → ${d.after} (pass rate ${pct(d.beforeRate ?? 0)} → ${pct(d.afterRate ?? 0)})`);
    for (const d of opts.diff.fixes) out.push(`fixed     ${d.id}: ${d.before} → ${d.after} (pass rate ${pct(d.beforeRate ?? 0)} → ${pct(d.afterRate ?? 0)})`);
  }
  return out.join("\n");
}

function formatCase(c: CaseResult, verbose: boolean): string[] {
  const rate = c.runs.length > 1 ? `  ${c.runs.filter((r) => r.status === "pass").length}/${c.runs.length} runs` : "";
  const lines = [`${ICON[c.status]} ${c.id}${rate}`];
  for (const r of c.runs) {
    const prefix = c.runs.length > 1 ? `    run ${r.run + 1}: ` : "    ";
    if (r.error) lines.push(`${prefix}error: ${r.error}`);
    for (const a of r.assertions) {
      if (!a.passed || verbose) lines.push(`${prefix}${a.passed ? "✓" : "✗"} ${a.label}${a.detail && (!a.passed || verbose) ? ` — ${a.detail}` : ""}`);
    }
    for (const q of r.rubric) {
      if (q.status === "pass" && !verbose) continue;
      const last = q.verdicts.at(-1);
      const how = q.decidedBy
        ? `${q.decidedBy}: ${fmtValue(last?.value)}${last?.confidence !== undefined ? ` @ ${last.confidence.toFixed(2)}` : ""}`
        : q.verdicts.length
          ? `undecided (${q.verdicts.map((v) => `${v.tier} ${fmtValue(v.value)}`).join(", ")})`
          : "no judge answered";
      const fails = q.failures.length ? `; ${q.failures.map((f) => `${f.tier} failed: ${f.error}`).join("; ")}` : "";
      lines.push(`${prefix}${ICON[q.status]} rubric ${q.id} — ${how}${fails}`);
    }
  }
  return lines;
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
