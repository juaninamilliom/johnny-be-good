import { describe, expect, it } from "vitest";
import { diffBaseline, exitCode, formatResult } from "../src/report/report.js";
import { runSuite } from "../src/runner/runner.js";
import { parseSuite } from "../src/suite.js";
import type { Judge } from "../src/judges/types.js";
import { trace } from "./helpers.js";

const suite = parseSuite(`
suite: demo
defaults:
  expect:
    - maxToolCalls: 5
cases:
  - id: weather
    task: What is the weather?
    runs: 3
    expect:
      - toolCalled: get_weather
  - id: polite
    rubric:
      - { id: answered, kind: noul, question: Did it answer? }
`, "suite.yaml");

const flaky = async (c: { id: string }, run: number) =>
  c.id === "weather" ? trace({ id: `w${run}`, calls: run === 1 ? [["search", {}]] : [["get_weather", {}]] }) : trace({ id: "p", final: "hi" });

describe("runner", () => {
  it("computes pass@1 and pass^k across runs and leaves rubric unjudged without judges", async () => {
    const r = await runSuite(suite, { provider: flaky, mode: "online" });
    const weather = r.cases.find((c) => c.id === "weather")!;
    expect(weather.runs.map((x) => x.status)).toEqual(["pass", "fail", "pass"]);
    expect(weather.passRate).toBeCloseTo(2 / 3);
    expect(r.cases.find((c) => c.id === "polite")!.status).toBe("unjudged");
    expect(r.summary).toMatchObject({ cases: 2, failed: 1, unjudged: 1, k: 3, passHatK: 0 });
    expect(exitCode(r)).toBe(1);
    expect(formatResult(r)).toContain("pass^3 0% over 4 runs");
  });

  it("applies suite defaults and judges rubric questions", async () => {
    const judge: Judge = { tier: "fake", judge: async (_t, rs) => ({ verdicts: rs.map((q) => ({ rubricId: q.id, tier: "fake", value: 0.9, decided: true })), usage: { inputTokens: 1, outputTokens: 0 } }) };
    const r = await runSuite(suite, { provider: async () => trace({ calls: [["get_weather", {}]] }), mode: "online", judges: [judge], runs: 1, only: ["polite"] });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]!.status).toBe("pass");
    expect(r.cases[0]!.runs[0]!.assertions[0]!.label).toBe("maxToolCalls 5");
    expect(exitCode(r)).toBe(0);
  });

  it("reports a provider error as an errored run", async () => {
    const r = await runSuite(suite, { provider: async () => { throw new Error("agent crashed"); }, mode: "online", only: ["polite"] });
    expect(r.cases[0]).toMatchObject({ status: "error", runs: [{ error: "agent crashed" }] });
  });

  it("diffs a baseline: regressions, fixes and rate changes", async () => {
    const before = await runSuite(suite, { provider: async () => trace({ calls: [["get_weather", {}]], final: "x" }), mode: "online" });
    const after = await runSuite(suite, { provider: flaky, mode: "online" });
    const d = diffBaseline(before, after);
    // weather passed every run before and fails one now: a regression.
    expect(d.regressions.map((x) => [x.id, x.change])).toEqual([["weather", "regressed"]]);
    expect(exitCode(after, d)).toBe(1);
    // A case already failing that loses more runs is a rate-down regression.
    const worse = await runSuite(suite, { provider: async (c) => (c.id === "weather" ? trace({ calls: [["search", {}]] }) : trace({ final: "hi" })), mode: "online" });
    expect(diffBaseline(after, worse).regressions.map((x) => [x.id, x.change])).toEqual([["weather", "rate-down"]]);
  });

  it("rejects duplicate case ids", () => {
    expect(() => parseSuite("suite: x\ncases:\n  - id: a\n  - id: a\n")).toThrow(/duplicate case id "a"/);
  });
});
