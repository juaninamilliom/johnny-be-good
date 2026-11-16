import type { Rubric } from "../suite.js";
import type { Trace } from "../trace/schema.js";

/**
 * A compact view of a trace for judges, held to a character budget. Each field is clipped
 * first. If the run is still over budget, steps are kept from both ends (the start says
 * what the agent set out to do, the end says how it finished) and the middle is elided.
 * Both kinds of cut are recorded in the view, so a judge knows what it did not see.
 */
export interface ViewStep {
  n: number;
  kind: "user" | "assistant" | "tool";
  text?: string;
  tool?: string;
  args?: string;
  result?: string;
  error?: boolean;
}

export interface TraceView {
  task?: string;
  steps: ViewStep[];
  /** Steps left out of the middle of the run to fit the budget. */
  elided?: { from: number; to: number; count: number };
  final?: string;
  clipped: boolean;
}

export function viewTrace(trace: Trace, maxChars: number): TraceView {
  const perField = Math.max(120, Math.floor(maxChars / Math.max(4, trace.steps.length * 2 + 2)));
  let clipped = false;
  const clip = (s: string, n = perField) => {
    if (s.length <= n) return s;
    clipped = true;
    return `${s.slice(0, n)} …[${s.length - n} chars clipped]`;
  };
  const all: ViewStep[] = trace.steps.map((s, i) =>
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
  const view: TraceView = { steps: all, clipped: false };
  if (trace.task) view.task = clip(trace.task, Math.min(2000, maxChars / 8));
  if (trace.final) view.final = clip(trace.final, Math.min(4000, maxChars / 4));

  const fixed = JSON.stringify({ ...view, steps: [] }).length + 200;
  const size = (st: ViewStep) => JSON.stringify(st).length + 1;
  if (fixed + all.reduce((a, st) => a + size(st), 0) > maxChars) {
    // Take steps alternately from the start and the end until the budget is spent.
    let budget = maxChars - fixed;
    let lo = 0;
    let hi = all.length - 1;
    const head: ViewStep[] = [];
    const tail: ViewStep[] = [];
    let fromHead = true;
    while (lo <= hi) {
      const st = fromHead ? all[lo]! : all[hi]!;
      const cost = size(st);
      if (cost > budget) break;
      budget -= cost;
      if (fromHead) head.push(all[lo++]!);
      else tail.unshift(all[hi--]!);
      fromHead = !fromHead;
    }
    if (lo <= hi) {
      view.steps = [...head, ...tail];
      view.elided = { from: all[lo]!.n, to: all[hi]!.n, count: hi - lo + 1 };
    }
  }
  view.clipped = clipped || view.elided !== undefined;
  return view;
}

/** Plain-text rendering for LLM judges. Closing data tags inside the trace are neutralized. */
export function renderTraceText(trace: Trace, maxChars: number): string {
  const v = viewTrace(trace, maxChars);
  const lines: string[] = [];
  if (v.task) lines.push(`TASK: ${v.task}`, "");
  for (const s of v.steps) {
    if (v.elided && s.n === v.elided.to + 1) lines.push(`… ${v.elided.count} steps (${v.elided.from}-${v.elided.to}) left out to fit the budget …`);
    if (s.kind === "tool") {
      lines.push(`[${s.n}] TOOL CALL ${s.tool} ${s.args}`);
      if (s.result !== undefined) lines.push(`[${s.n}] TOOL ${s.error ? "ERROR" : "RESULT"}: ${s.result}`);
    } else lines.push(`[${s.n}] ${s.kind.toUpperCase()}: ${s.text}`);
  }
  if (v.final) lines.push("", `FINAL ANSWER: ${v.final}`);
  if (v.clipped) lines.push("", v.elided ? `(This view leaves out ${v.elided.count} steps from the middle of the run and clips long fields.)` : "(Some long fields were clipped.)");
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
