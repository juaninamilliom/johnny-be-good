import { z } from "zod";
import { toolCalls, totalTokens, type ToolCallStep, type Trace } from "../trace/schema.js";
import { getPath, match, MatcherSchema, preview } from "./matchers.js";
import { ExpectedFindingsSchema, checkExpectedFindings } from "./findings.js";

const ArgsSchema = z.record(z.string(), MatcherSchema);
const TimesSchema = z.object({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() }).strict();

/** Each assertion is an object with exactly one keyword key plus its options. */
export const AssertionSchema = z.union([
  z.object({ toolCalled: z.string(), args: ArgsSchema.optional(), times: TimesSchema.optional() }).strict(),
  z.object({ toolNotCalled: z.string() }).strict(),
  z.object({ toolOrder: z.array(z.string()).min(2), strict: z.boolean().optional() }).strict(),
  z.object({ maxToolCalls: z.number().int().nonnegative() }).strict(),
  z.object({ maxSteps: z.number().int().nonnegative() }).strict(),
  z.object({ maxTokens: z.number().int().nonnegative() }).strict(),
  z.object({ maxCostUsd: z.number().nonnegative() }).strict(),
  z.object({ noToolErrors: z.literal(true), except: z.array(z.string()).optional() }).strict(),
  z.object({ final: MatcherSchema }).strict(),
  z.object({ expectedFindings: ExpectedFindingsSchema }).strict(),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export interface AssertionResult {
  kind: string;
  label: string;
  passed: boolean;
  detail?: string;
  /** Optional display-only context; verdict calculation is unchanged. */
  diagnostic?: { expected: string; actual: string };
}

export function runAssertion(trace: Trace, a: Assertion): AssertionResult {
  const calls = toolCalls(trace);

  if ("toolCalled" in a) {
    const named = calls.filter((c) => c.name === a.toolCalled);
    const matching = a.args ? named.filter((c) => argsFailure(c, a.args!) === undefined) : named;
    const min = a.times?.min ?? 1;
    const max = a.times?.max ?? Infinity;
    const label = `toolCalled ${a.toolCalled}${a.args ? " with args" : ""}${a.times ? ` ${min}..${max === Infinity ? "∞" : max}×` : ""}`;
    const n = matching.length;
    const displayed = named.length ? named : calls;
    const diagnostic = {
      expected: `${a.toolCalled}(${displayPreview(a.args ?? {})}) · ${min}..${max === Infinity ? "∞" : max} matching calls`,
      actual: displayed.slice(0, 3).map(c => `${c.name}(${displayPreview(c.args)})`).join("; ") + (displayed.length > 3 ? `; +${displayed.length - 3} more calls` : "") || "no tool calls",
    };
    if (n >= min && n <= max) return { kind: "toolCalled", label, passed: true, diagnostic, detail: `${n} matching call(s)` };
    let detail = `${n} matching call(s), expected ${min}..${max === Infinity ? "∞" : max}`;
    if (a.args && named.length > n) detail += `; closest mismatch: ${argsFailure(named[0]!, a.args)}`;
    if (named.length === 0) detail += `; tools called: ${[...new Set(calls.map((c) => c.name))].join(", ") || "none"}`;
    return { kind: "toolCalled", label, passed: false, detail, diagnostic };
  }

  if ("toolNotCalled" in a) {
    const n = calls.filter((c) => c.name === a.toolNotCalled).length;
    return { kind: "toolNotCalled", label: `toolNotCalled ${a.toolNotCalled}`, passed: n === 0, ...(n ? { detail: `called ${n}×` } : {}) };
  }

  if ("toolOrder" in a) {
    const names = calls.map((c) => c.name);
    const label = `toolOrder ${a.toolOrder.join(" → ")}${a.strict ? " (strict)" : ""}`;
    const ok = a.strict ? containsContiguous(names, a.toolOrder) : containsSubsequence(names, a.toolOrder);
    return { kind: "toolOrder", label, passed: ok, ...(ok ? {} : { detail: `actual: ${names.join(" → ") || "no tool calls"}` }) };
  }

  if ("maxToolCalls" in a) return budget("maxToolCalls", calls.length, a.maxToolCalls);
  if ("maxSteps" in a) return budget("maxSteps", trace.steps.length, a.maxSteps);
  if ("maxTokens" in a) {
    if (!trace.usage || trace.meta?.usageProvided === false) return { kind: "maxTokens", label: `maxTokens ${a.maxTokens}`, passed: false, detail: "trace has no recorded token usage" };
    return budget("maxTokens", totalTokens(trace), a.maxTokens);
  }
  if ("maxCostUsd" in a) {
    const cost = trace.usage.costUsd;
    if (cost === undefined) return { kind: "maxCostUsd", label: `maxCostUsd ${a.maxCostUsd}`, passed: false, detail: "trace has no cost" };
    return budget("maxCostUsd", cost, a.maxCostUsd);
  }

  if ("noToolErrors" in a) {
    const except = new Set(a.except ?? []);
    const errored = calls.filter((c) => c.result?.isError && !except.has(c.name));
    return {
      kind: "noToolErrors",
      label: "noToolErrors",
      passed: errored.length === 0,
      ...(errored.length
        ? { detail: `${errored.length} error(s): ${errored.slice(0, 5).map((c) => `${c.name}: ${preview(c.result?.content, 80)}`).join("; ")}${errored.length > 5 ? `; and ${errored.length - 5} more` : ""}` }
        : {}),
    };
  }

  if ("final" in a) {
    if (trace.final === undefined) return { kind: "final", label: "final", passed: false, detail: "trace has no final answer" };
    const r = match(trace.final, a.final);
    return { kind: "final", label: `final ${preview(a.final, 40)}`, passed: r.ok, ...(r.why ? { detail: `final answer ${r.why}` } : {}) };
  }

  return checkExpectedFindings(trace, a.expectedFindings);
}

function argsFailure(call: ToolCallStep, args: Record<string, z.infer<typeof MatcherSchema>>): string | undefined {
  for (const [path, m] of Object.entries(args)) {
    const r = match(getPath(call.args, path), m);
    if (!r.ok) return `args.${path} ${r.why}`;
  }
  return undefined;
}

function budget(kind: string, actual: number, limit: number): AssertionResult {
  return { kind, label: `${kind} ${limit}`, passed: actual <= limit, detail: `actual ${actual}` };
}

function containsSubsequence(names: string[], seq: string[]): boolean {
  let i = 0;
  for (const n of names) if (n === seq[i]) i++;
  return i === seq.length;
}

function containsContiguous(names: string[], seq: string[]): boolean {
  for (let start = 0; start + seq.length <= names.length; start++) {
    if (seq.every((s, j) => names[start + j] === s)) return true;
  }
  return false;
}

// Presentation must not turn a valid in-memory assertion into a scoring exception.
function displayPreview(value: unknown): string {
  try { return preview(value, 300); }
  catch { return "[not JSON-serializable]"; }
}
