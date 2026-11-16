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
    const parsed = TraceSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`${opts.path ?? "trace"}: not a valid tracecheck trace: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    return parsed.data;
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
