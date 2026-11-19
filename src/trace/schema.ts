import { z } from "zod";

/** The result of one tool call, attached to the call that produced it. */
export const ToolResultSchema = z.object({
  content: z.string(),
  isError: z.boolean().default(false),
});

export const MessageStepSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export const ToolCallStepSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  result: ToolResultSchema.optional(),
});

export const StepSchema = z.discriminatedUnion("type", [MessageStepSchema, ToolCallStepSchema]);

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
});

/**
 * One agent run in Johnny Be Good's native format. Importers convert other formats into
 * this shape, and every assertion and judge reads only this shape.
 */
export const TraceSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  task: z.string().optional(),
  model: z.string().optional(),
  source: z.object({ kind: z.string(), path: z.string().optional() }).optional(),
  steps: z.array(StepSchema),
  final: z.string().optional(),
  usage: UsageSchema.default({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  durationMs: z.number().nonnegative().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
export type MessageStep = z.infer<typeof MessageStepSchema>;
export type ToolCallStep = z.infer<typeof ToolCallStepSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Trace = z.infer<typeof TraceSchema>;

export function toolCalls(trace: Trace): ToolCallStep[] {
  return trace.steps.filter((s): s is ToolCallStep => s.type === "tool_call");
}

export function totalTokens(trace: Trace): number {
  const u = trace.usage;
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
