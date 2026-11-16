import type { Step, ToolCallStep, Trace, Usage } from "../trace/schema.js";

/**
 * Imports a Claude Code run. Two inputs share one parser:
 *
 * - a session transcript (`~/.claude/projects/<project>/<session>.jsonl`), and
 * - the stream-json output of `claude -p --output-format stream-json --verbose`.
 *
 * Both are JSONL whose `user` and `assistant` lines carry Anthropic Messages API
 * content blocks. A transcript writes one content block per line and repeats the
 * message's usage on each of them, so usage is counted once per message id. Subagent
 * (sidechain) lines are skipped unless `includeSidechains` is set.
 */
export interface ClaudeCodeImportOptions {
  id?: string;
  path?: string;
  includeSidechains?: boolean;
}

type Block = { type?: string; [key: string]: unknown };

export function importClaudeCode(jsonl: string, opts: ClaudeCodeImportOptions = {}): Trace {
  const steps: Step[] = [];
  const callsById = new Map<string, ToolCallStep>();
  const usageSeen = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let task: string | undefined;
  let model: string | undefined;
  let sessionId: string | undefined;
  let final: string | undefined;
  let resultFinal: string | undefined;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let durationMs: number | undefined;

  const lines = jsonl.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`);
    }
    if (rec.isSidechain === true && !opts.includeSidechains) continue;
    sessionId ??= str(rec.sessionId) ?? str(rec.session_id);
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }

    if (rec.type === "result") {
      // stream-json's closing line: the final answer, cost and wall time.
      resultFinal = str(rec.result) ?? resultFinal;
      if (typeof rec.total_cost_usd === "number") usage.costUsd = rec.total_cost_usd;
      if (typeof rec.duration_ms === "number") durationMs = rec.duration_ms;
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const message = rec.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, unknown> } | undefined;
    if (!message) continue;

    if (rec.type === "assistant") {
      model ??= message.model;
      const usageKey = message.id ?? str(rec.uuid) ?? `line-${i}`;
      if (message.usage && !usageSeen.has(usageKey)) {
        usageSeen.add(usageKey);
        usage.inputTokens += num(message.usage.input_tokens);
        usage.outputTokens += num(message.usage.output_tokens);
        usage.cacheReadTokens += num(message.usage.cache_read_input_tokens);
        usage.cacheWriteTokens += num(message.usage.cache_creation_input_tokens);
      }
      for (const block of blocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          steps.push({ type: "message", role: "assistant", text: block.text });
          final = block.text;
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const call: ToolCallStep = { type: "tool_call", id: block.id, name: block.name, args: block.input ?? {} };
          callsById.set(block.id, call);
          steps.push(call);
        }
      }
      continue;
    }

    // user line: a typed prompt, or tool results returning to the model.
    if (rec.isMeta === true) continue;
    if (typeof message.content === "string") {
      if (message.content.trim()) {
        steps.push({ type: "message", role: "user", text: message.content });
        task ??= message.content;
      }
      continue;
    }
    for (const block of blocks(message.content)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const call = callsById.get(block.tool_use_id);
        if (call) call.result = { content: resultText(block.content), isError: block.is_error === true };
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        steps.push({ type: "message", role: "user", text: block.text });
        task ??= block.text;
      }
    }
  }

  if (durationMs === undefined && firstTs !== undefined && lastTs !== undefined) durationMs = lastTs - firstTs;
  const trace: Trace = {
    version: 1,
    id: opts.id ?? sessionId ?? "claude-code-run",
    steps,
    usage,
    source: { kind: "claude-code", ...(opts.path ? { path: opts.path } : {}) },
  };
  if (task !== undefined) trace.task = task;
  if (model !== undefined) trace.model = model;
  const answer = resultFinal ?? final;
  if (answer !== undefined) trace.final = answer;
  if (durationMs !== undefined) trace.durationMs = durationMs;
  return trace;
}

function blocks(content: unknown): Block[] {
  if (Array.isArray(content)) return content.filter((b): b is Block => typeof b === "object" && b !== null);
  return [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type ? `[${b.type}]` : ""))
    .filter(Boolean)
    .join("\n");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
