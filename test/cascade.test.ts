import { describe, expect, it } from "vitest";
import { runCascade } from "../src/judges/cascade.js";
import type { Judge, Verdict } from "../src/judges/types.js";
import { RubricSchema } from "../src/suite.js";
import { trace } from "./helpers.js";

const rubrics = [
  RubricSchema.parse({ id: "answered", kind: "noul", question: "Did it answer?" }),
  RubricSchema.parse({ id: "quality", kind: "score", question: "How good?", criteria: ["bad", "ok", "great"], pass: 1.5 }),
  RubricSchema.parse({ id: "tone", kind: "choice", question: "Tone?", criteria: { polite: null, rude: null }, pass: ["polite"] }),
];

function fake(tier: string, answers: Record<string, Omit<Verdict, "rubricId" | "tier">>, seen: string[][] = []): Judge {
  return {
    tier,
    async judge(_t, rs) {
      seen.push(rs.map((r) => r.id));
      return {
        verdicts: rs.filter((r) => answers[r.id]).map((r) => ({ rubricId: r.id, tier, ...answers[r.id]! })),
        usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.001 },
      };
    },
  };
}

describe("judge cascade", () => {
  it("escalates only undecided questions to the next tier", async () => {
    const seenLlm: string[][] = [];
    const jev = fake("jev", { answered: { value: 0.9, decided: true }, quality: { value: 1.4, confidence: 0.4, decided: false }, tone: { value: "polite", confidence: 0.95, decided: true } });
    const llm = fake("llm", { quality: { value: 2, decided: true } }, seenLlm);
    const r = await runCascade(trace(), rubrics, [jev, llm]);
    expect(seenLlm).toEqual([["quality"]]);
    expect(r.rubric.map((q) => [q.id, q.status, q.decidedBy])).toEqual([
      ["answered", "pass", "jev"],
      ["quality", "pass", "llm"],
      ["tone", "pass", "jev"],
    ]);
    expect(r.rubric[1]!.verdicts.map((v) => v.tier)).toEqual(["jev", "llm"]);
    expect(r.usageByTier.jev?.costUsd).toBe(0.001);
  });

  it("records a failed tier and falls through", async () => {
    const down: Judge = { tier: "jev", judge: async () => { throw new Error("503 Service Unavailable"); } };
    const llm = fake("llm", { answered: { value: 0.2, decided: true } });
    const r = await runCascade(trace(), [rubrics[0]!], [down, llm]);
    expect(r.rubric[0]).toMatchObject({ status: "fail", decidedBy: "llm", failures: [{ tier: "jev", error: "503 Service Unavailable" }] });
  });

  it("leaves a question unjudged when no tier decides it", async () => {
    const jev = fake("jev", { answered: { value: 0.5, decided: false } });
    const r = await runCascade(trace(), [rubrics[0]!], [jev]);
    expect(r.rubric[0]).toMatchObject({ status: "unjudged", verdicts: [{ value: 0.5 }] });
    expect((await runCascade(trace(), [rubrics[0]!], [])).rubric[0]!.status).toBe("unjudged");
  });
});
