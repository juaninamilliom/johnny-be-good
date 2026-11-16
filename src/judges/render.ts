import type { Rubric } from "../suite.js";
import type { Trace } from "../trace/schema.js";

/**
 * A compact view of a trace for judges. Tool arguments and results are clipped so one
 * huge result cannot crowd out the rest of the run. Clipping is recorded in the view, so a
 * judge knows it saw part of a result.
 */
export interface TraceView {
  task?: string;
  steps: Array<{ n: number; kind: "user" | "assistant" | "tool"; text?: string; tool?: string; args?: string; result?: string; error?: boolean }>;
  final?: string;
  clipped: boolean;
}

export function viewTrace(trace: Trace, maxChars: number): TraceView {
  const perField = Math.max(200, Math.floor(maxChars / Math.max(4, trace.steps.length * 2 + 2)));
  let clipped = false;
  const clip = (s: string, n = perField) => {
    if (s.length <= n) return s;
    clipped = true;
    return `${s.slice(0, n)} …[${s.length - n} chars clipped]`;
  };
  const steps = trace.steps.map((s, i) =>
    s.type === "message"
      ? { n: i + 1, kind: s.role, text: clip(s.text) }
      : {
          n: i + 1,
          kind: "tool" as const,
          tool: s.name,
          args: clip(JSON.stringify(s.args) ?? ""),
          ...(s.result ? { result: clip(s.result.content), error: s.result.isError } : {}),
        },
  );
  const view: TraceView = { steps, clipped: false };
  if (trace.task) view.task = clip(trace.task, perField * 2);
  if (trace.final) view.final = clip(trace.final, perField * 2);
  view.clipped = clipped;
  return view;
}

/** Plain-text rendering for LLM judges. Closing data tags inside the trace are neutralized. */
export function renderTraceText(trace: Trace, maxChars: number): string {
  const v = viewTrace(trace, maxChars);
  const lines: string[] = [];
  if (v.task) lines.push(`TASK: ${v.task}`, "");
  for (const s of v.steps) {
    if (s.kind === "tool") {
      lines.push(`[${s.n}] TOOL CALL ${s.tool} ${s.args}`);
      if (s.result !== undefined) lines.push(`[${s.n}] TOOL ${s.error ? "ERROR" : "RESULT"}: ${s.result}`);
    } else lines.push(`[${s.n}] ${s.kind.toUpperCase()}: ${s.text}`);
  }
  if (v.final) lines.push("", `FINAL ANSWER: ${v.final}`);
  if (v.clipped) lines.push("", "(Some long fields were clipped.)");
  return lines.join("\n").replaceAll("</trace>", "<\\/trace>");
}

export function describeRubric(r: Rubric): string {
  switch (r.kind) {
    case "noul":
      return `- id "${r.id}" (yes/no): ${r.question}${r.yes ? ` Yes means: ${r.yes}.` : ""}${r.no ? ` No means: ${r.no}.` : ""} Answer "yes" or "no".`;
    case "score":
      return `- id "${r.id}" (score 0-${r.criteria.length - 1}): ${r.question} Levels: ${r.criteria.map((c, i) => `${i} = ${c}`).join("; ")}. Answer with the level number.`;
    case "choice":
      return `- id "${r.id}" (choice): ${r.question} Options: ${Object.entries(r.criteria).map(([k, d]) => (d ? `"${k}" (${d})` : `"${k}"`)).join(", ")}. Answer with one option exactly.`;
  }
}

/** Converts an LLM's text verdict into the cascade's value for a rubric. Returns undefined when it does not fit. */
export function parseVerdict(r: Rubric, raw: string): number | string | undefined {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  switch (r.kind) {
    case "noul": {
      const lower = v.toLowerCase();
      if (lower === "yes" || lower === "true") return 1;
      if (lower === "no" || lower === "false") return 0;
      return undefined;
    }
    case "score": {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n < r.criteria.length ? n : undefined;
    }
    case "choice":
      return Object.hasOwn(r.criteria, v) ? v : undefined;
  }
}
