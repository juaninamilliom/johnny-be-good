import type { Trace } from "../src/trace/schema.js";

export function trace(partial: Partial<Trace> & { calls?: Array<[string, unknown, string?, boolean?]> } = {}): Trace {
  const { calls = [], ...rest } = partial;
  return {
    version: 1,
    id: "t1",
    steps: calls.map(([name, args, result, isError], i) => ({
      type: "tool_call" as const,
      id: `c${i}`,
      name,
      args,
      ...(result !== undefined ? { result: { content: result, isError: isError ?? false } } : {}),
    })),
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...rest,
  };
}
