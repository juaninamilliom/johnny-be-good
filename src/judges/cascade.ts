import type { Rubric } from "../suite.js";
import type { Trace } from "../trace/schema.js";
import { passes, type Judge, type JudgeUsage, type Verdict } from "./types.js";

export type RubricStatus = "pass" | "fail" | "unjudged";

export interface RubricResult {
  id: string;
  status: RubricStatus;
  decidedBy?: string;
  /** Every answer any tier gave, in tier order, including the ones that escalated. */
  verdicts: Verdict[];
  /** Tiers that failed to answer, with the reason. */
  failures: Array<{ tier: string; error: string }>;
}

export interface CascadeResult {
  rubric: RubricResult[];
  usageByTier: Record<string, JudgeUsage>;
}

/**
 * Runs rubric questions through the judges in order. Each tier sees only the questions
 * that earlier tiers left undecided, so a cheap confident tier keeps the expensive tier
 * idle. A question no tier decides is `unjudged`, and the report lists it. Unjudged counts
 * against a pass.
 */
export async function runCascade(trace: Trace, rubrics: Rubric[], judges: Judge[]): Promise<CascadeResult> {
  const results = new Map<string, RubricResult>(rubrics.map((r) => [r.id, { id: r.id, status: "unjudged", verdicts: [], failures: [] }]));
  const usageByTier: Record<string, JudgeUsage> = {};
  let pending = rubrics;

  for (const judge of judges) {
    if (pending.length === 0) break;
    let response;
    try {
      response = await judge.judge(trace, pending);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const r of pending) results.get(r.id)!.failures.push({ tier: judge.tier, error });
      continue;
    }
    usageByTier[judge.tier] = addUsage(usageByTier[judge.tier], response.usage);
    const byId = new Map(response.verdicts.map((v) => [v.rubricId, v]));
    const next: Rubric[] = [];
    for (const r of pending) {
      const res = results.get(r.id)!;
      const v = byId.get(r.id);
      if (!v) {
        res.failures.push({ tier: judge.tier, error: "returned no answer for this question" });
        next.push(r);
        continue;
      }
      res.verdicts.push(v);
      if (v.decided) {
        res.status = passes(r, v.value) ? "pass" : "fail";
        res.decidedBy = judge.tier;
      } else next.push(r);
    }
    pending = next;
  }
  return { rubric: rubrics.map((r) => results.get(r.id)!), usageByTier };
}

function addUsage(a: JudgeUsage | undefined, b: JudgeUsage): JudgeUsage {
  const costUsd = a?.costUsd !== undefined || b.costUsd !== undefined ? (a?.costUsd ?? 0) + (b.costUsd ?? 0) : undefined;
  return { inputTokens: (a?.inputTokens ?? 0) + b.inputTokens, outputTokens: (a?.outputTokens ?? 0) + b.outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) };
}
