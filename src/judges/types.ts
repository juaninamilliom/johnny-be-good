import type { Rubric } from "../suite.js";
import type { Trace } from "../trace/schema.js";

/** One tier's answer to one rubric question. */
export interface Verdict {
  rubricId: string;
  tier: string;
  /** P(yes) for noul, expected score for score, the label for choice. */
  value: number | string;
  /** The tier's confidence in the answer, 0..1, when it reports one. */
  confidence?: number;
  /** True when the answer is confident enough to stand. False escalates to the next tier. */
  decided: boolean;
  note?: string;
}

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface JudgeResponse {
  verdicts: Verdict[];
  usage: JudgeUsage;
}

/**
 * A judge answers several rubric questions about one trace in one call. A judge that is
 * unavailable (no key, server down, outage) throws; the cascade records the failure and
 * moves on. It never turns a failure into a verdict.
 */
export interface Judge {
  readonly tier: string;
  judge(trace: Trace, rubrics: Rubric[]): Promise<JudgeResponse>;
}

export function passes(rubric: Rubric, value: number | string): boolean {
  switch (rubric.kind) {
    case "noul":
      return typeof value === "number" && value >= rubric.pass;
    case "score":
      return typeof value === "number" && value >= rubric.pass;
    case "choice":
      return typeof value === "string" && rubric.pass.includes(value);
  }
}
