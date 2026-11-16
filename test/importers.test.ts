import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importClaudeCode, parseTrace } from "../src/importers/index.js";
import { toolCalls } from "../src/trace/schema.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("Claude Code transcript import", () => {
  const trace = importClaudeCode(fx("session.jsonl"));

  it("takes the first typed prompt as the task and skips meta lines", () => {
    expect(trace.task).toBe("What is the weather in Lisbon?");
  });

  it("links tool results to their calls", () => {
    const calls = toolCalls(trace);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "get_weather", args: { city: "Lisbon", units: "F" }, result: { isError: false } });
    expect(calls[0]?.result?.content).toContain("64");
  });

  it("counts usage once per message id and skips sidechains", () => {
    expect(trace.usage).toMatchObject({ inputTokens: 250, outputTokens: 35, cacheReadTokens: 50, cacheWriteTokens: 10 });
  });

  it("keeps the last assistant text as the final answer", () => {
    expect(trace.final).toBe("It is 64°F and foggy in Lisbon.");
    expect(trace.model).toBe("claude-sonnet-5-5");
    expect(trace.id).toBe("sess-1");
    expect(trace.durationMs).toBe(6000); // session span, first line to last
  });

  it("includes sidechains when asked", () => {
    const withSide = importClaudeCode(fx("session.jsonl"), { includeSidechains: true });
    expect(toolCalls(withSide).map((c) => c.name)).toEqual(["get_weather", "Grep"]);
  });
});

describe("stream-json import", () => {
  const trace = importClaudeCode(fx("stream.jsonl"));

  it("reads the result line for final answer, cost and duration", () => {
    expect(trace.final).toBe("The directory is empty.");
    expect(trace.usage.costUsd).toBe(0.0012);
    expect(trace.durationMs).toBe(4200);
  });

  it("marks errored tool results", () => {
    expect(toolCalls(trace)[0]?.result).toEqual({ content: "ls: cannot access: No such file", isError: true });
  });
});

describe("parseTrace", () => {
  it("accepts a native trace and fills defaults", () => {
    const t = parseTrace(JSON.stringify({ id: "n1", steps: [{ type: "message", role: "user", text: "hi" }] }));
    expect(t.usage.inputTokens).toBe(0);
    expect(t.version).toBe(1);
  });

  it("rejects a malformed native trace with the failing path", () => {
    expect(() => parseTrace(JSON.stringify({ id: "n1", steps: [{ type: "tool_call", name: "x" }] }), { format: "native" })).toThrow(/steps\.0/);
  });

  it("names a broken JSONL line", () => {
    expect(() => parseTrace('{"type":"user"}\nnot json')).toThrow(/line 2/);
  });
});
