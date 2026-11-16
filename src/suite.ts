import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AssertionSchema } from "./assertions/assertions.js";

/**
 * A rubric question for the judge cascade. Three kinds, matching what a calibrated
 * classifier can answer:
 * - `noul`: yes or no. Passes when P(yes) ≥ `pass` (default 0.5).
 * - `score`: an ordered rubric, lowest first. Passes when the expected score ≥ `pass`.
 * - `choice`: named labels. Passes when the chosen label is in `pass`.
 */
export const RubricSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("noul"), question: z.string(), yes: z.string().optional(), no: z.string().optional(), pass: z.number().min(0).max(1).default(0.5) }).strict(),
  z.object({ id: z.string(), kind: z.literal("score"), question: z.string(), criteria: z.array(z.string()).min(2), pass: z.number().nonnegative() }).strict(),
  z.object({ id: z.string(), kind: z.literal("choice"), question: z.string(), criteria: z.record(z.string(), z.string().nullable()), pass: z.array(z.string()).min(1) }).strict(),
]);
export type Rubric = z.infer<typeof RubricSchema>;

export const JevConfigSchema = z
  .object({
    model: z.string().optional(),
    /** A score or choice answer stands when its confidence is at least this. */
    minConfidence: z.number().min(0).max(1).default(0.6),
    /** A noul answer inside this P(yes) band is unsure and escalates. */
    unsureBand: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.3, 0.7]),
    maxStateChars: z.number().int().positive().default(60_000),
  })
  .strict();

export const LlmConfigSchema = z
  .object({
    provider: z.enum(["ollama", "anthropic"]).default("ollama"),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    maxTraceChars: z.number().int().positive().default(40_000),
  })
  .strict();

export const JudgesConfigSchema = z
  .object({
    jev: z.union([JevConfigSchema, z.literal(false)]).optional(),
    llm: z.union([LlmConfigSchema, z.literal(false)]).optional(),
  })
  .strict();
export type JudgesConfig = z.infer<typeof JudgesConfigSchema>;

export const AdapterConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude-code"), args: z.array(z.string()).default([]), cwd: z.string().optional(), timeoutMs: z.number().int().positive().default(600_000) }).strict(),
  z.object({ kind: z.literal("command"), command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().positive().default(600_000) }).strict(),
]);
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export const CaseSchema = z
  .object({
    id: z.string(),
    task: z.string().optional(),
    /** Offline: one recorded trace, or several runs of the same task. */
    trace: z.string().optional(),
    traces: z.array(z.string()).optional(),
    /** Online: how many times the adapter runs this case. */
    runs: z.number().int().positive().optional(),
    expect: z.array(AssertionSchema).default([]),
    rubric: z.array(RubricSchema).default([]),
  })
  .strict();
export type Case = z.infer<typeof CaseSchema>;

export const SuiteSchema = z
  .object({
    suite: z.string(),
    judges: JudgesConfigSchema.optional(),
    adapter: AdapterConfigSchema.optional(),
    runs: z.number().int().positive().default(1),
    defaults: z.object({ expect: z.array(AssertionSchema).default([]), rubric: z.array(RubricSchema).default([]) }).strict().optional(),
    cases: z.array(CaseSchema).min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", path: ["cases", i, "id"], message: `duplicate case id "${c.id}"` });
      seen.add(c.id);
      const rubricIds = new Set<string>();
      for (const r of [...(s.defaults?.rubric ?? []), ...c.rubric]) {
        if (rubricIds.has(r.id)) ctx.addIssue({ code: "custom", path: ["cases", i, "rubric"], message: `duplicate rubric id "${r.id}"` });
        rubricIds.add(r.id);
      }
    });
  });
export type Suite = z.infer<typeof SuiteSchema>;

export async function loadSuite(path: string): Promise<Suite> {
  const text = await readFile(path, "utf8");
  return parseSuite(text, path);
}

export function parseSuite(text: string, path = "suite"): Suite {
  const doc = path.endsWith(".json") ? (JSON.parse(text) as unknown) : (parseYaml(text) as unknown);
  const parsed = SuiteSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${path}: invalid suite\n${issues}`);
  }
  return parsed.data;
}
