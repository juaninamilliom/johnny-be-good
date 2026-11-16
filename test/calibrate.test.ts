import { describe, expect, it } from "vitest";
import { calibrate, formatCalibration } from "../src/calibrate/calibrate.js";
import type { Judge } from "../src/judges/types.js";
import { RubricSchema } from "../src/suite.js";
import { trace } from "./helpers.js";

const rubric = RubricSchema.parse({ id: "ok", kind: "noul", question: "Did it work?" });

// Ten items. Jev's P(yes) per item, and the human label (true = should pass).
const jevP = [0.95, 0.9, 0.85, 0.62, 0.57, 0.43, 0.38, 0.15, 0.1, 0.05];
const label = [true, true, true, false, true, true, false, false, false, false];
const items = jevP.map((_, i) => ({ trace: trace({ id: `t${i}` }), labels: { ok: label[i]! } }));
const idx = (t: { id: string }) => Number(t.id.slice(1));

const jev: Judge = { tier: "jev", judge: async (t) => ({ verdicts: [{ rubricId: "ok", tier: "jev", value: jevP[idx(t)]!, decided: true }], usage: { inputTokens: 1, outputTokens: 0 } }) };
// The fallback is right every time.
const llm: Judge = { tier: "llm", judge: async (t) => ({ verdicts: [{ rubricId: "ok", tier: "llm", value: label[idx(t)] ? 1 : 0, decided: true }], usage: { inputTokens: 1, outputTokens: 0 } }) };

describe("calibrate", () => {
  it("measures each tier and finds the cheapest band that keeps accuracy", async () => {
    const r = await calibrate(items, [rubric], [jev, llm]);
    expect(r.tiers).toEqual([
      { tier: "jev", answered: 10, accuracy: 0.8 },
      { tier: "llm", answered: 10, accuracy: 1 },
    ]);
    const at = (s: number) => r.sweep.find((x) => x.strictness === s)!;
    expect(at(0)).toMatchObject({ jevDecided: 10, cascadeAccuracy: 0.8, escalationRate: 0 });
    // 0.57 and 0.43 escalate; 0.62 still stands and is wrong.
    expect(at(0.1)).toMatchObject({ jevDecided: 8, cascadeAccuracy: 0.9 });
    // Band 0.35..0.65 escalates all four ambiguous items, and the fallback gets them right.
    expect(at(0.15)).toMatchObject({ jevDecided: 6, jevDecidedAccuracy: 1, cascadeAccuracy: 1, escalationRate: 0.4 });
    expect(r.recommended?.strictness).toBe(0.15);
    expect(formatCalibration(r)).toContain("recommended: strictness 0.15 → jev: { minConfidence: 0.65, unsureBand: [0.35, 0.65] }");
  });

  it("records a tier that fails", async () => {
    const down: Judge = { tier: "jev", judge: async () => { throw new Error("503"); } };
    const r = await calibrate(items.slice(0, 1), [rubric], [down, llm]);
    expect(r.failures).toEqual([{ tier: "jev", error: "503" }]);
    expect(r.tiers[0]).toMatchObject({ answered: 0 });
  });
});
