import { describe, expect, it } from "vitest";
import { AssertionSchema, runAssertion } from "../src/assertions/assertions.js";
import { scoreFindings, extractJson, ExpectedFindingsSchema } from "../src/assertions/findings.js";
import { match } from "../src/assertions/matchers.js";
import { trace } from "./helpers.js";

const t = trace({
  calls: [
    ["search", { q: "weather lisbon" }, "ok"],
    ["get_weather", { city: "Lisbon", units: "F", days: 3 }, "64F"],
    ["send_email", { to: "a@example.com" }, "denied", true],
  ],
  final: "It is 64°F in Lisbon.",
});
const run = (a: unknown) => runAssertion(t, AssertionSchema.parse(a));

describe("matchers", () => {
  it("treats a scalar as equals and combines object keys", () => {
    expect(match("x", "x").ok).toBe(true);
    expect(match(5, { gte: 3, lt: 6 }).ok).toBe(true);
    expect(match(7, { gte: 3, lt: 6 })).toEqual({ ok: false, why: "7 is not lt 6" });
    expect(match(undefined, { exists: true }).ok).toBe(false);
    expect(match("Lisbon, CA", { regex: "^Oak", contains: "CA" }).ok).toBe(true);
  });
});

describe("assertions", () => {
  it("toolCalled checks args and counts", () => {
    expect(run({ toolCalled: "get_weather", args: { city: "Lisbon", days: { gte: 1 } } }).passed).toBe(true);
    const miss = run({ toolCalled: "get_weather", args: { city: "Berkeley" } });
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain('args.city "Lisbon" does not equal "Berkeley"');
    expect(run({ toolCalled: "search", times: { max: 0 } }).passed).toBe(false);
    expect(run({ toolCalled: "nope" }).detail).toContain("tools called: search, get_weather, send_email");
  });

  it("toolNotCalled, toolOrder and budgets", () => {
    expect(run({ toolNotCalled: "delete_file" }).passed).toBe(true);
    expect(run({ toolNotCalled: "send_email" }).passed).toBe(false);
    expect(run({ toolOrder: ["search", "send_email"] }).passed).toBe(true);
    expect(run({ toolOrder: ["search", "send_email"], strict: true }).passed).toBe(false);
    expect(run({ toolOrder: ["get_weather", "search"] }).passed).toBe(false);
    expect(run({ maxToolCalls: 3 }).passed).toBe(true);
    expect(run({ maxTokens: 149 }).passed).toBe(false);
    expect(run({ maxCostUsd: 1 }).detail).toBe("trace has no cost");
  });

  it("noToolErrors honors except", () => {
    expect(run({ noToolErrors: true }).passed).toBe(false);
    expect(run({ noToolErrors: true, except: ["send_email"] }).passed).toBe(true);
  });

  it("final matcher", () => {
    expect(run({ final: { contains: "64" } }).passed).toBe(true);
    expect(run({ final: { notContains: "64" } }).passed).toBe(false);
  });

  it("rejects an assertion with two keywords", () => {
    expect(() => AssertionSchema.parse({ toolCalled: "a", toolNotCalled: "b" })).toThrow();
  });
});

describe("expectedFindings", () => {
  const spec = ExpectedFindingsSchema.parse({
    expected: [
      { id: "off-by-one", file: "src/pager.ts", line: 14 },
      { id: "null-deref", file: "src/user.ts", line: 30 },
      { id: "race", file: "src/cache.ts", line: 8 },
    ],
    minRecall: 0.6,
    maxFalsePositives: 1,
  });

  it("matches within the line window, one finding per seeded bug", () => {
    const s = scoreFindings(
      [
        { file: "./src/pager.ts", line: 17 },
        { file: "src/pager.ts", line: 15 },
        { file: "repo/src/user.ts", line: 31 },
      ],
      spec,
    );
    expect(s).toMatchObject({ matched: ["off-by-one", "null-deref"], missed: ["race"], falsePositives: 1 });
  });

  it("reads findings from a JSON fence in the final answer", () => {
    const final = 'Review done.\n```json\n{"findings":[{"file":"src/pager.ts","line":14},{"file":"src/cache.ts","line":9}]}\n```';
    const r = runAssertion(trace({ final }), AssertionSchema.parse({ expectedFindings: spec }));
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("recall 2/3 (67%), 0 false positive(s) of 2 reported; missed: null-deref");
  });

  it("fails visibly when the answer has no JSON", () => {
    expect(runAssertion(trace({ final: "looks fine" }), AssertionSchema.parse({ expectedFindings: spec })).detail).toBe("final answer has no JSON");
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });
});
