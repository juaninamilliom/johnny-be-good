import { describe, expect, it } from "vitest";
import { calibrateHeldOut, calibrate, formatHeldOutCalibration, type LabeledItem } from "../src/calibrate/calibrate.js";
import { RubricSchema } from "../src/suite.js";
import type { Judge } from "../src/judges/types.js";
import { trace } from "./helpers.js";

const rubric = RubricSchema.parse({ id: "ok", kind: "noul", question: "Did the response satisfy the task?" });
const labels: Record<string, boolean> = { t0: true, t1: false, t2: false, t3: true, h0: true, h1: false, h2: true, h3: false, h4: true, h5: false };
const values: Record<string, number> = { t0: 0.9, t1: 0.6, t2: 0.1, t3: 0.4, h0: 0.9, h1: 0.9, h2: 0.5, h3: Infinity, h4: 0.1, h5: 0.1 };
const item = (id: string): LabeledItem => ({ trace: trace({ id, final: `Distinct recorded response ${id}` }), labels: { ok: labels[id]! } });
const tuning = ["t0", "t1", "t2", "t3"].map(item);
const heldOut = ["h0", "h1", "h2", "h3", "h4", "h5"].map(item);
function fakeJudges(calls: string[] = []): Judge[] {
  return [
    { tier: "jev", judge: async (t) => { calls.push(`jev:${t.id}`); return { verdicts: [{ rubricId: "ok", tier: "jev", value: values[t.id]!, decided: true }], usage: { inputTokens: 0, outputTokens: 0 } }; } },
    { tier: "llm", judge: async (t) => {
      calls.push(`llm:${t.id}`);
      if (t.id === "h3") throw new Error("Synthetic judge outage");
      return { verdicts: [{ rubricId: "ok", tier: "llm", value: labels[t.id] ? 1 : 0, decided: t.id !== "h2" }], usage: { inputTokens: 0, outputTokens: 0 } };
    } },
  ];
}

describe("held-out calibration", () => {
  it("freezes tuning before validation and separates agreement, coverage and confusion counts", async () => {
    const calls: string[] = [];
    const report = await calibrateHeldOut(tuning, heldOut, [rubric], fakeJudges(calls));
    expect(report.tuning.evaluation).toBe("in-sample");
    expect(report.selectedStrictness).toBe(0.1);
    expect(calls.slice(0, 8).every(call => call.includes(":t"))).toBe(true);
    expect(calls.slice(8).every(call => call.includes(":h"))).toBe(true);
    expect(report.validation).toMatchObject({ items: 6, questions: 6, answered: 4, unjudged: 2, correct: 2, agreement: 0.5, confusion: { truePositive: 1, trueNegative: 1, falsePositive: 1, falseNegative: 1 } });
    expect(report.validation.coverage).toBeCloseTo(4 / 6);
    expect(report.validation.totalAgreement).toBeCloseTo(2 / 6);
    expect(report.validation.disagreements.map(d => d.traceId)).toEqual(["h1", "h4"]);
    expect(report.validation.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: "h3", tier: "jev", kind: "invalid_answer", error: 'Invalid or missing judge answer for rubric "ok"' }),
      expect.objectContaining({ traceId: "h3", tier: "llm", kind: "judge_error", error: "Synthetic judge outage" }),
    ]));
    expect(report.validation.uncertainty).toMatchObject({ unit: "trace", trials: 6, successes: 2, method: "wilson" });
    expect(report.validation.uncertainty.lower).toBeLessThan(2 / 6);
    expect(report.validation.uncertainty.upper).toBeGreaterThan(2 / 6);
    expect(formatHeldOutCalibration(report)).toContain("HELD-OUT VALIDATION");
    expect(formatHeldOutCalibration(report)).toContain("not a calibration or generalization guarantee");
  });

  it("cannot change the selected threshold by changing held-out labels", async () => {
    const one = await calibrateHeldOut(tuning, heldOut, [rubric], fakeJudges());
    const changed = heldOut.map(x => ({ ...x, labels: { ok: !x.labels.ok } }));
    const two = await calibrateHeldOut(tuning, changed, [rubric], fakeJudges());
    expect(two.selectedStrictness).toBe(one.selectedStrictness);
    expect(two.tuning).toEqual(one.tuning);
    expect(two.validation.disagreements).not.toEqual(one.validation.disagreements);
  });

  it("rejects overlapping IDs, duplicate behavioral content and within-split duplicates before judge calls", async () => {
    const calls: string[] = [];
    await expect(calibrateHeldOut(tuning, [tuning[0]!], [rubric], fakeJudges(calls))).rejects.toThrow("overlapping trace ID");
    const copied = { ...tuning[0]!, trace: { ...tuning[0]!.trace, id: "renamed", source: { kind: "other", path: "other.json" }, durationMs: 99 } };
    await expect(calibrateHeldOut(tuning, [copied], [rubric], fakeJudges(calls))).rejects.toThrow("overlapping trace content");
    await expect(calibrateHeldOut([tuning[0]!, tuning[0]!], heldOut, [rubric], fakeJudges(calls))).rejects.toThrow("overlapping trace ID");
    expect(calls).toEqual([]);
  });

  it("rejects unsupported multi-fallback and reversed-order policies before making judge calls", async () => {
    const calls: string[] = [];
    const [jev, fallback] = fakeJudges(calls);
    const other: Judge = { ...fallback!, tier: "another-fallback" };
    for (const policy of [[jev!, fallback!, other], [fallback!, other]]) {
      await expect(calibrateHeldOut(tuning, heldOut, [rubric], policy)).rejects.toThrow("at most one non-Jev fallback");
      await expect(calibrate(tuning, [rubric], policy)).rejects.toThrow("at most one non-Jev fallback");
    }
    await expect(calibrateHeldOut(tuning, heldOut, [rubric], [fallback!, jev!])).rejects.toThrow("first judge tier");
    await expect(calibrate(tuning, [rubric], [fallback!, jev!])).rejects.toThrow("first judge tier");
    expect(calls).toEqual([]);
  });

  it("classifies thrown parsing errors as judge errors rather than provider outages", async () => {
    const broken: Judge = { tier: "only", judge: async t => {
      if (t.id.startsWith("h")) throw new SyntaxError("Malformed judge JSON");
      return { verdicts: [{ rubricId: "ok", tier: "only", value: 1, decided: true }], usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const report = await calibrateHeldOut([tuning[0]!], [heldOut[0]!], [rubric], [broken]);
    expect(report.validation.failures).toEqual([{ traceId: "h0", tier: "only", kind: "judge_error", error: "Malformed judge JSON" }]);
    expect(report.validation).toMatchObject({ answered: 0, unjudged: 1 });
  });

  it("rejects empty data, absent/unknown labels and duplicate rubrics or tiers", async () => {
    const judges = fakeJudges();
    await expect(calibrateHeldOut([], heldOut, [rubric], judges)).rejects.toThrow("both contain labeled traces");
    await expect(calibrateHeldOut(tuning, [], [rubric], judges)).rejects.toThrow("both contain labeled traces");
    await expect(calibrateHeldOut(tuning, [{ ...heldOut[0]!, labels: {} }], [rubric], judges)).rejects.toThrow("at least one human label");
    await expect(calibrateHeldOut(tuning, [{ ...heldOut[0]!, labels: { missing: true } }], [rubric], judges)).rejects.toThrow("invalid label");
    await expect(calibrateHeldOut(tuning, heldOut, [rubric, rubric], judges)).rejects.toThrow("Duplicate rubric IDs");
    await expect(calibrateHeldOut(tuning, heldOut, [rubric], [])).rejects.toThrow("uniquely named judge");
    await expect(calibrateHeldOut(tuning, heldOut, [rubric], [judges[0]!, judges[0]!])).rejects.toThrow("uniquely named judge");
  });

  it("rejects empty or invalid in-sample measurements rather than reporting zero questions as success", async () => {
    const calls: string[] = [];
    const judges = fakeJudges(calls);
    await expect(calibrate([], [rubric], judges)).rejects.toThrow("at least one labeled trace");
    await expect(calibrate(tuning, [], judges)).rejects.toThrow("At least one rubric");
    await expect(calibrate(tuning, [rubric], [])).rejects.toThrow("uniquely named judge");
    await expect(calibrate([{ ...tuning[0]!, labels: {} }], [rubric], judges)).rejects.toThrow("at least one human label");
    await expect(calibrate([{ ...tuning[0]!, labels: { missing: true } }], [rubric], judges)).rejects.toThrow("invalid label");
    await expect(calibrate([{ ...tuning[0]!, labels: { ok: "yes" as unknown as boolean } }], [rubric], judges)).rejects.toThrow("invalid label");
    await expect(calibrate(tuning, [rubric, rubric], judges)).rejects.toThrow("Duplicate rubric IDs");
    await expect(calibrate(tuning, [rubric], [judges[0]!, judges[0]!])).rejects.toThrow("uniquely named judge");
    expect(calls).toEqual([]);
  });

  it("permits partial human labeling but scores only labeled questions", async () => {
    const extra = RubricSchema.parse({ id: "other", kind: "noul", question: "A second criterion" });
    const report = await calibrateHeldOut(tuning, [heldOut[0]!], [rubric, extra], fakeJudges());
    expect(report.validation.questions).toBe(1);
    expect(report.validation.answered).toBe(1);
  });

  it("does not select a Jev threshold when the tuning tier never returned a valid answer", async () => {
    const down: Judge = { tier: "jev", judge: async () => { throw new Error("Synthetic outage"); } };
    await expect(calibrateHeldOut([tuning[0]!], [heldOut[0]!], [rubric], [down])).rejects.toThrow("no valid Jev answers");
  });

  it("does not count fallback abstention as a correct tuning prediction", async () => {
    const uncertain: Judge = { tier: "jev", judge: async () => ({ verdicts: [{ rubricId: "ok", tier: "jev", value: 0.5, decided: false }], usage: { inputTokens: 0, outputTokens: 0 } }) };
    const abstain: Judge = { tier: "llm", judge: async () => ({ verdicts: [{ rubricId: "ok", tier: "llm", value: 0, decided: false }], usage: { inputTokens: 0, outputTokens: 0 } }) };
    const report = await calibrate([tuning[1]!], [rubric], [uncertain, abstain]);
    expect(report.sweep.every(row => row.cascadeAccuracy === 0)).toBe(true);
  });

  it("does not turn fallback abstention or malformed answers into agreement with a negative label", async () => {
    const abstain: Judge = { tier: "only", judge: async () => ({ verdicts: [{ rubricId: "ok", tier: "only", value: 0, decided: false }], usage: { inputTokens: 0, outputTokens: 0 } }) };
    const report = await calibrateHeldOut([tuning[0]!], [heldOut[1]!], [rubric], [abstain]);
    expect(report.selectedStrictness).toBeUndefined();
    expect(report.validation).toMatchObject({ answered: 0, unjudged: 1, coverage: 0, correct: 0, agreement: null, totalAgreement: 0 });
    expect(report.validation.uncertainty.successes).toBe(0);
    const invalid: Judge = { tier: "only", judge: async () => ({ verdicts: [{ rubricId: "ok", tier: "only", value: NaN, decided: true }], usage: { inputTokens: 0, outputTokens: 0 } }) };
    const invalidReport = await calibrateHeldOut([tuning[0]!], [heldOut[1]!], [rubric], [invalid]);
    expect(invalidReport.validation.unjudged).toBe(1);
    expect(invalidReport.validation.failures).toHaveLength(1);
    expect((await calibrate([tuning[0]!], [rubric], [invalid])).tiers[0]!.answered).toBe(0);
  });
});
