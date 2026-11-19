import { describe, expect, it } from "vitest";
import { runSuite } from "../src/runner/runner.js";
import { parseSuite } from "../src/suite.js";
import { trace } from "./helpers.js";

const suite = parseSuite(`suite: unequal\ncases:\n  - id: once\n    runs: 1\n  - id: thrice\n    runs: 3\n`);
describe("run selection and reliability", () => {
  it("groups unequal trial counts rather than presenting them as a single pass^k", async () => {
    const result = await runSuite(suite, {mode: "online", provider: async (c, run) => { if (c.id === "thrice" && run === 1) throw new Error("trial failure"); return trace(); }});
    expect(result.summary).toMatchObject({k: 0, uniformK: false, trialCounts: [1, 3], passHatK: 0.5,
      byTrialCount: [{k: 1, cases: 1, allPassed: 1, passRate: 1}, {k: 3, cases: 1, allPassed: 0, passRate: 0}]});
  });
  it("retains pass^k semantics for uniform trial counts", async () => {
    const result = await runSuite(suite, {mode: "online", only: ["thrice"], provider: async () => trace()});
    expect(result.summary).toMatchObject({k: 3, uniformK: true, trialCounts: [3], passHatK: 1});
  });
  it("rejects invalid API counts and empty or unknown selections before calling the provider", async () => {
    let called = 0; const provider = async () => { called++; return trace(); };
    for (const concurrency of [0, -1, 1.5, Infinity, NaN]) await expect(runSuite(suite, {mode: "online", provider, concurrency})).rejects.toThrow("positive safe integer");
    for (const runs of [0, -1, 1.5, Infinity]) await expect(runSuite(suite, {mode: "online", provider, runs})).rejects.toThrow("positive safe integer");
    for (const only of [[], ["missing"], ["once", "missing"]]) await expect(runSuite(suite, {mode: "online", provider, only})).rejects.toThrow("Case selection");
    expect(called).toBe(0);
  });
  it("does not accept a partial trace from an unsuccessful target process", async () => {
    for (const exitCode of [1, 2, null, "0"]) {
      const result = await runSuite(suite, {mode: "online", only: ["once"], provider: async () => trace({meta: {exitCode}})});
      expect(result.summary.errored).toBe(1);
      expect(result.cases[0]!.runs[0]!.error).toContain("exited unsuccessfully");
    }
  });
  it("records invalid native traces and assertion exceptions as errors instead of passes", async () => {
    const invalid = await runSuite(suite, {mode: "online", only: ["once"], provider: async () => ({...trace(), steps: undefined}) as never});
    expect(invalid.summary.errored).toBe(1);
    const badRegex = parseSuite(`suite: regex\ncases:\n  - id: broken\n    expect: [{final: {regex: "["}}]\n`);
    const result = await runSuite(badRegex, {mode: "online", provider: async () => trace({final: "text"})});
    expect(result.cases[0]!.runs[0]!.status).toBe("error");
    expect(result.cases[0]!.runs[0]!.error).toContain("Invalid regular expression");
  });
});
