import { z } from "zod";
import type { Trace } from "../trace/schema.js";
import { getPath } from "./matchers.js";
import type { AssertionResult } from "./assertions.js";

/**
 * Scores structured findings (a code review's bugs, a scanner's alerts) against a list of
 * known, seeded ones. The findings are read as JSON from the final answer: the whole
 * answer, the first ```json fence, or the first {...} or [...] span in it.
 */
export const ExpectedFindingsSchema = z
  .object({
    path: z.string().default("findings"),
    fileKey: z.string().default("file"),
    lineKey: z.string().default("line"),
    window: z.number().int().nonnegative().default(5),
    expected: z
      .array(z.object({ id: z.string(), file: z.string(), line: z.number().int().positive(), window: z.number().int().nonnegative().optional() }).strict())
      .min(1),
    /** Pass when at least this fraction of seeded findings is found. Ignored when `minFound` is set. */
    minRecall: z.number().min(0).max(1).default(1),
    /** Pass when at least this many seeded findings are found. Clearer than a fraction like 0.67. */
    minFound: z.number().int().nonnegative().optional(),
    maxFalsePositives: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ExpectedFindings = z.infer<typeof ExpectedFindingsSchema>;

export interface FindingsScore {
  recall: number;
  matched: string[];
  missed: string[];
  falsePositives: number;
  reported: number;
}

export function scoreFindings(reported: Array<{ file: string; line: number }>, spec: ExpectedFindings): FindingsScore {
  const used = new Set<number>();
  const matched: string[] = [];
  const missed: string[] = [];
  for (const exp of spec.expected) {
    const w = exp.window ?? spec.window;
    const idx = reported.findIndex((f, i) => !used.has(i) && sameFile(f.file, exp.file) && Math.abs(f.line - exp.line) <= w);
    if (idx >= 0) {
      used.add(idx);
      matched.push(exp.id);
    } else missed.push(exp.id);
  }
  return {
    recall: matched.length / spec.expected.length,
    matched,
    missed,
    falsePositives: reported.length - used.size,
    reported: reported.length,
  };
}

export function checkExpectedFindings(trace: Trace, spec: ExpectedFindings): AssertionResult {
  const bar = spec.minFound !== undefined ? `found ≥ ${spec.minFound}` : `recall ≥ ${spec.minRecall}`;
  const label = `expectedFindings ${spec.expected.length} seeded, ${bar}${spec.maxFalsePositives !== undefined ? `, ≤ ${spec.maxFalsePositives} false positives` : ""}`;
  const doc = extractJson(trace.final ?? "");
  if (doc === undefined) return { kind: "expectedFindings", label, passed: false, detail: "final answer has no JSON" };
  const raw = Array.isArray(doc) ? doc : getPath(doc, spec.path);
  if (!Array.isArray(raw)) return { kind: "expectedFindings", label, passed: false, detail: `no array at "${spec.path}"` };
  const reported = raw
    .map((f) => ({ file: getPath(f, spec.fileKey), line: Number(getPath(f, spec.lineKey)) }))
    .filter((f): f is { file: string; line: number } => typeof f.file === "string" && Number.isFinite(f.line));
  const s = scoreFindings(reported, spec);
  const enough = spec.minFound !== undefined ? s.matched.length >= spec.minFound : s.recall >= spec.minRecall;
  const passed = enough && (spec.maxFalsePositives === undefined || s.falsePositives <= spec.maxFalsePositives);
  const detail =
    `recall ${s.matched.length}/${spec.expected.length} (${(s.recall * 100).toFixed(0)}%), ${s.falsePositives} false positive(s) of ${s.reported} reported` +
    (s.missed.length ? `; missed: ${s.missed.join(", ")}` : "");
  return { kind: "expectedFindings", label, passed, detail };
}

export function extractJson(text: string): unknown {
  const attempts: string[] = [text];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  if (fence?.[1]) attempts.push(fence[1]);
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) attempts.push(text.slice(a, b + 1));
  }
  for (const t of attempts) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}
