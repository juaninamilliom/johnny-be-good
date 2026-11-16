import type { JudgesConfig } from "../suite.js";
import { JevJudge } from "./jev.js";
import { anthropicJudge, ollamaJudge } from "./llm.js";
import type { Judge } from "./types.js";

export { runCascade } from "./cascade.js";
export { JevJudge } from "./jev.js";
export { anthropicJudge, ollamaJudge, LlmJudge } from "./llm.js";
export type { Judge, Verdict, JudgeResponse, JudgeUsage } from "./types.js";

/**
 * Builds the cascade from suite config. Jev comes first when a TypeSafe key is present or
 * Jev is configured; the LLM tier (Ollama unless configured otherwise) comes last. `false`
 * turns a tier off.
 */
export function judgesFromConfig(cfg: JudgesConfig | undefined, env: NodeJS.ProcessEnv = process.env): Judge[] {
  const judges: Judge[] = [];
  const jev = cfg?.jev;
  if (jev !== false && (jev || env.TYPESAFE_API_KEY)) {
    judges.push(
      new JevJudge({
        ...(jev?.model ? { model: jev.model } : {}),
        ...(jev ? { minConfidence: jev.minConfidence, unsureBand: jev.unsureBand, maxStateChars: jev.maxStateChars } : {}),
      }),
    );
  }
  const llm = cfg?.llm;
  if (llm !== false) {
    const provider = llm?.provider ?? "ollama";
    const common = { ...(llm?.model ? { model: llm.model } : {}), ...(llm?.maxTraceChars ? { maxTraceChars: llm.maxTraceChars } : {}) };
    judges.push(provider === "anthropic" ? anthropicJudge(common) : ollamaJudge({ ...common, ...(llm?.baseUrl ? { baseUrl: llm.baseUrl } : {}) }));
  }
  return judges;
}
