import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { parseTrace } from "../importers/index.js";
import { SuiteSchema, type Suite, type Case } from "../suite.js";
import type { Trace } from "../trace/schema.js";
import { recordedTraces, type TraceProvider } from "./runner.js";

/** Expand native JSONL into independent, one-run samples. Never auto-detect it as a transcript. */
export async function loadRecordedDataset(input: Suite, baseDir: string): Promise<{ suite: Suite; provider: TraceProvider; datasetFiles: string[] }> {
  const suite = SuiteSchema.parse(input);
  const cases: Case[] = [], rows = new Map<string, Trace | Error>(), datasetFiles = new Set<string>();
  const ids = new Set(suite.cases.map(c => c.id));
  for (const c of suite.cases) {
    if (!c.traces || Array.isArray(c.traces)) {
      cases.push(c);
      for (const p of c.traces ?? (c.trace ? [c.trace] : [])) datasetFiles.add(resolve(baseDir, p));
      continue;
    }
    if (c.trace || c.runs !== undefined || c.sampleSource) throw new Error(`case "${c.id}": JSONL cannot be combined with trace, runs or sampleSource`);
    const path = resolve(baseDir, c.traces.jsonl);
    datasetFiles.add(path);
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0, count = 0;
    try {
      for await (const text of lines) {
        line++;
        if (!text.trim()) continue;
        count++;
        const id = `${c.id}::line:${line}`;
        if (ids.has(id)) throw new Error(`Dataset case ID collision: ${id}`);
        ids.add(id);
        const source = { caseId: c.id, path, line };
        const { traces, ...rest } = c; void traces;
        cases.push({ ...rest, id, sampleSource: source });
        try { rows.set(id, parseTrace(text, { format: "native", path: `${path}:${line}` })); }
        catch (error) { rows.set(id, new Error(`${path}:${line}: ${error instanceof Error ? error.message : String(error)}`)); }
      }
    } finally { lines.close(); stream.destroy(); }
    if (!count) throw new Error(`case "${c.id}": JSONL dataset is empty: ${path}`);
  }
  const fallback = recordedTraces(baseDir);
  const provider: TraceProvider = async (c, run) => {
    const row = rows.get(c.id);
    if (row instanceof Error) throw row;
    if (row) return row;
    return fallback(c, run);
  };
  return { suite: SuiteSchema.parse({ ...suite, cases }), provider, datasetFiles: [...datasetFiles] };
}
