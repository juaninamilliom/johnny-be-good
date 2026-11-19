import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { TraceSchema, type Trace } from "../trace/schema.js";
import { importClaudeCode } from "./claude-code.js";

export { importClaudeCode } from "./claude-code.js";

export type TraceFormat = "native" | "claude-code" | "auto";

/**
 * Loads a trace file. `auto` treats a single JSON object with a `steps` array as a
 * native trace and anything else as Claude Code JSONL.
 */
export async function loadTrace(path: string, format: TraceFormat = "auto"): Promise<Trace> {
  const text = await readFile(path, "utf8");
  return parseTrace(text, { format, path });
}

export function parseTrace(text: string, opts: { format?: TraceFormat; path?: string; id?: string } = {}): Trace {
  const format = opts.format ?? "auto";
  const id = opts.id ?? (opts.path ? basename(opts.path).replace(/\.(jsonl?|ndjson)$/, "") : undefined);
  if (format === "native" || (format === "auto" && looksNative(text))) {
    const source: unknown = JSON.parse(text);
    const parsed = TraceSchema.safeParse(source);
    if (!parsed.success) {
      throw new Error(`${opts.path ?? "trace"}: not a valid tracecheck trace: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    return { ...parsed.data, meta: { ...parsed.data.meta, usageProvided: hasRecordedTokenUsage(source) } };
  }
  return importClaudeCode(text, { ...(id ? { id } : {}), ...(opts.path ? { path: opts.path } : {}) });
}

function looksNative(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{")) return false;
  try {
    const obj = JSON.parse(text) as unknown;
    return typeof obj === "object" && obj !== null && Array.isArray((obj as { steps?: unknown }).steps);
  } catch {
    return false;
  }
}

/** Detect observed token fields before schema defaults turn absent usage into zero counters.
 * Explicit false from an adapter wins; presence does not certify the producer's counting accuracy.
 */
export function hasRecordedTokenUsage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as { meta?: { usageProvided?: unknown }; usage?: unknown };
  if (source.meta?.usageProvided === false || !source.usage || typeof source.usage !== "object") return false;
  const usage = source.usage as Record<string, unknown>;
  return ["inputTokens", "outputTokens"].every(key => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}
