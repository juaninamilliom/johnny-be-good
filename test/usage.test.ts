import { describe, expect, it } from "vitest";
import { parseTrace, importClaudeCode } from "../src/importers/index.js";
import { runAssertion } from "../src/assertions/assertions.js";
import { runSuite } from "../src/runner/runner.js";
import { parseSuite } from "../src/suite.js";
import { trace } from "./helpers.js";

const native = (extra: object = {}) => parseTrace(JSON.stringify({id: "native", steps: [], final: "ok", ...extra}));
const budget = parseSuite(`suite: token-budget\ncases:\n  - id: answer\n    expect: [{maxTokens: 10}, {final: ok}]\n`);
const assistant = (usage?: object) => ({type: "assistant", message: {id: "m1", content: [{type: "text", text: "ok"}], ...(usage ? {usage} : {})}});

describe("token instrumentation coverage", () => {
  it("does not confuse native schema defaults with measured zero usage", async () => {
    const missing = native();
    expect(missing.usage.inputTokens).toBe(0);
    expect(missing.meta?.usageProvided).toBe(false);
    expect(runAssertion(missing, {maxTokens: 10})).toMatchObject({passed: false, detail: "trace has no recorded token usage"});
    const result = await runSuite(budget, {mode: "online", provider: async () => missing});
    expect(result.cases[0]!.runs[0]!.agentUsageRecorded).toBe(false);
    expect(result.summary).toMatchObject({failed: 1, agentTokens: 0, agentUsageRecordedRuns: 0, agentCostRecordedRuns: 0});
  });

  it("retains explicitly supplied zero counters and zero cost as measured observations", async () => {
    const zero = native({usage: {inputTokens: 0, outputTokens: 0, costUsd: 0}});
    expect(zero.meta?.usageProvided).toBe(true);
    expect(runAssertion(zero, {maxTokens: 0}).passed).toBe(true);
    const result = await runSuite(budget, {mode: "online", provider: async () => zero});
    expect(result.summary).toMatchObject({passed: 1, agentTokens: 0, agentCostUsd: 0, agentUsageRecordedRuns: 1, agentCostRecordedRuns: 1});
    expect(result.cases[0]!.runs[0]!.agentUsageRecorded).toBe(true);
  });

  it("honors an adapter's explicit missing-instrumentation flag over placeholder counters", async () => {
    const placeholder = native({usage: {inputTokens: 0, outputTokens: 0}, meta: {usageProvided: false}});
    expect(placeholder.meta?.usageProvided).toBe(false);
    const result = await runSuite(budget, {mode: "online", provider: async () => placeholder});
    expect(result.summary).toMatchObject({failed: 1, agentUsageRecordedRuns: 0});
  });

  it("does not treat an empty usage object or cost-only data as token measurement", () => {
    for (const usage of [{}, {costUsd: 0.01}, {inputTokens: 0}, {outputTokens: 0}]) {
      const value = native({usage});
      expect(value.meta?.usageProvided).toBe(false);
      expect(runAssertion(value, {maxTokens: 100}).passed).toBe(false);
    }
  });

  it("normalizes direct providers before defaults and records partial run coverage", async () => {
    const suite = parseSuite(`suite: partial\ncases:\n  - {id: measured}\n  - {id: missing}\n`);
    const result = await runSuite(suite, {mode: "online", provider: async c => c.id === "measured" ? native({usage: {inputTokens: 5, outputTokens: 2, costUsd: 0.01}}) : ({id: "raw", steps: [], final: "ok"}) as never});
    expect(result.summary).toMatchObject({agentTokens: 7, agentUsageRecordedRuns: 1, agentCostRecordedRuns: 1, runs: 2});
    expect(result.cases[1]!.runs[0]!.agentUsageRecorded).toBe(false);
  });

  it("preserves numeric counters for compatibility while flagging them unrecorded", async () => {
    const supplied = trace({meta: {usageProvided: false}});
    const result = await runSuite(budget, {mode: "online", provider: async () => supplied});
    expect(result.summary.agentTokens).toBe(150);
    expect(result.summary.agentUsageRecordedRuns).toBe(0);
  });
});

describe("Claude usage provenance", () => {
  it("does not call initialized counters observations when no token event exists", () => {
    const noUsage = importClaudeCode(JSON.stringify(assistant()));
    expect(noUsage.meta?.usageProvided).toBe(false);
    expect(noUsage.usage.inputTokens).toBe(0);
    expect(runAssertion(noUsage, {maxTokens: 10}).passed).toBe(false);
    const empty = importClaudeCode(JSON.stringify(assistant({})));
    expect(empty.meta?.usageProvided).toBe(false);
  });

  it("records cost independently of token events", async () => {
    const value = importClaudeCode([assistant(), {type: "result", result: "ok", total_cost_usd: 0.01}].map(value => JSON.stringify(value)).join("\n"));
    expect(value.meta?.usageProvided).toBe(false);
    const result = await runSuite(budget, {mode: "online", provider: async () => value});
    expect(result.summary).toMatchObject({agentTokens: 0, agentUsageRecordedRuns: 0, agentCostRecordedRuns: 1, agentCostUsd: 0.01});
  });

  it("keeps partial message token counts unknown until both base counters are observed", () => {
    const inputOnly = importClaudeCode(JSON.stringify(assistant({input_tokens: 0})));
    expect(inputOnly.meta?.usageProvided).toBe(false);
    expect(runAssertion(inputOnly, {maxTokens: 0}).passed).toBe(false);
    const completed = importClaudeCode([assistant({input_tokens: 5}), assistant({output_tokens: 3}), assistant({input_tokens: 5, output_tokens: 3})].map(value => JSON.stringify(value)).join("\n"));
    expect(completed.meta?.usageProvided).toBe(true);
    expect(completed.usage).toMatchObject({inputTokens: 5, outputTokens: 3});
    const partialOther = {...assistant({input_tokens: 5}), message: {...assistant({input_tokens: 5}).message, id: "m2"}};
    const incomplete = importClaudeCode([assistant({input_tokens: 5, output_tokens: 3}), partialOther].map(value => JSON.stringify(value)).join("\n"));
    expect(incomplete.meta?.usageProvided).toBe(false);
  });

  it("accepts explicit zero usage events and counts a later real event after an empty one", () => {
    const zero = importClaudeCode(JSON.stringify(assistant({input_tokens: 0, output_tokens: 0})));
    expect(zero.meta?.usageProvided).toBe(true);
    expect(runAssertion(zero, {maxTokens: 0}).passed).toBe(true);
    const later = importClaudeCode([assistant({}), assistant({input_tokens: 10, output_tokens: 2})].map(value => JSON.stringify(value)).join("\n"));
    expect(later.meta?.usageProvided).toBe(true);
    expect(later.usage).toMatchObject({inputTokens: 10, outputTokens: 2});
  });
});
