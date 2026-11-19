import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SuiteSchema, type Suite } from "../suite.js";
import { TraceSchema, type Trace } from "../trace/schema.js";
import type { RunResult, SuiteResult, TraceProvider } from "./runner.js";

export interface FileArtifact { path: string; sha256: string }
export interface ExperimentManifest {
  version: 1; createdAt: string; complete: boolean;
  tool: { name: string; version: string }; mode: "online" | "offline";
  suite: { name: string; sha256: string; snapshot: FileArtifact };
  configuration: { sha256: string; judgeConfig?: unknown; target?: unknown; execution?: unknown };
  dataset: { sha256?: string; files: Array<{ name: string; sha256: string }>; traces: Array<FileArtifact & { caseId: string; run: number }> };
  runs: Array<{ caseId: string; run: number; status: RunResult["status"]; trace?: FileArtifact; result: FileArtifact }>;
  report?: FileArtifact; failure?: string;
}
export interface ArtifactOptions {
  suite: Suite; mode: "online" | "offline";
  /** Supply explicit non-secret metadata only. No environment is captured. */
  judgeConfig?: unknown; target?: unknown; datasetFiles?: string[];
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value); if (result === undefined) throw new Error("Metadata must be JSON-serializable"); return result;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
export function fingerprint(value: unknown): string { return hash(stable(value)); }
/** Metadata hygiene only: arbitrary tasks, responses and tool payloads are not de-identified. */
function metadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(metadata);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /secret|password|api.?key|authorization|cookie|credential|^(?:(?:access|refresh|bearer|auth|session|id)[_-]?)?token$|^headers?$|^env$|^command$/i.test(key) ? "[redacted]" : metadata(child)]));
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol)) {
        if (url.username || url.password) { url.username = "redacted"; url.password = "redacted"; }
        for (const key of url.searchParams.keys()) if (/secret|password|token|key|auth/i.test(key)) url.searchParams.set(key, "redacted");
        return url.toString();
      }
    } catch { /* Non-URL literal metadata, never executed. */ }
  }
  return value;
}
function snapshot(suite: Suite): Suite {
  const { adapter, judges, ...rest } = suite; void adapter; void judges;
  return SuiteSchema.parse(rest); // Saved replay suites cannot execute adapter commands.
}
const keyFor = (id: string, run: number) => `${hash(id)}-${run + 1}`;

export class ArtifactStore {
  private begun = false; private finalized = false;
  private readonly traces = new Map<string, FileArtifact>();
  private writes = Promise.resolve();
  constructor(readonly directory: string, private readonly manifest: ExperimentManifest) {}
  async begin(suite: Suite, mode: "online" | "offline", execution: unknown): Promise<void> {
    if (this.begun || this.finalized) throw new Error("Artifact store can only be used for one experiment");
    if (fingerprint(suite) !== this.manifest.suite.sha256 || mode !== this.manifest.mode) throw new Error("Artifact store does not match this suite and mode");
    this.begun = true;
    this.manifest.configuration.execution = metadata(execution);
    this.manifest.configuration.sha256 = fingerprint({ judgeConfig: this.manifest.configuration.judgeConfig ?? null, target: this.manifest.configuration.target ?? null, execution: this.manifest.configuration.execution });
    await this.saveManifest();
  }
  async saveTrace(caseId: string, run: number, trace: Trace): Promise<FileArtifact> {
    const key = keyFor(caseId, run);
    if (this.traces.has(key)) throw new Error("Duplicate trace artifact");
    const file = await this.json(`trace-${key}.json`, TraceSchema.parse(trace));
    this.traces.set(key, file); this.manifest.dataset.traces.push({ caseId, run, ...file });
    await this.saveManifest(); return file;
  }
  async saveResult(caseId: string, result: RunResult): Promise<void> {
    const key = keyFor(caseId, result.run), file = await this.json(`result-${key}.json`, result), trace = this.traces.get(key);
    this.manifest.runs.push({ caseId, run: result.run, status: result.status, ...(trace ? { trace } : {}), result: file });
    await this.saveManifest();
  }
  async finalize(result: SuiteResult): Promise<void> {
    if (!this.begun || this.finalized) throw new Error("Artifact store is not active");
    this.manifest.report = await this.json("report.json", result);
    this.manifest.dataset.sha256 = fingerprint({ files: this.manifest.dataset.files, traces: [...this.manifest.dataset.traces].sort((a, b) => compareText(a.caseId, b.caseId) || a.run - b.run) });
    this.manifest.complete = true; this.finalized = true; await this.saveManifest();
  }
  async abort(error: unknown): Promise<void> {
    this.manifest.complete = false; this.manifest.failure = error instanceof Error ? error.message : String(error); await this.saveManifest();
  }
  private async json(path: string, value: unknown): Promise<FileArtifact> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(join(this.directory, path), text, { mode: 0o600, flag: "wx" });
    return { path, sha256: hash(text) };
  }
  private saveManifest(): Promise<void> {
    this.writes = this.writes.then(async () => {
      this.manifest.dataset.traces.sort((a, b) => compareText(a.caseId, b.caseId) || a.run - b.run);
      this.manifest.runs.sort((a, b) => compareText(a.caseId, b.caseId) || a.run - b.run);
      const temp = join(this.directory, ".manifest-next.json");
      await writeFile(temp, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temp, join(this.directory, "manifest.json"));
    }); return this.writes;
  }
}
export async function createArtifactStore(directory: string, options: ArtifactOptions): Promise<ArtifactStore> {
  if (options.mode !== "online" && options.mode !== "offline") throw new Error("mode must be online or offline");
  const suite = SuiteSchema.parse(options.suite), destination = resolve(directory);
  const files = await Promise.all((options.datasetFiles ?? []).map(async path => ({ name: basename(path), sha256: hash(await readFile(path)) })));
  const tool = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const cfg = { ...(options.judgeConfig !== undefined ? { judgeConfig: metadata(options.judgeConfig) } : {}), ...(options.target !== undefined ? { target: metadata(options.target) } : {}) };
  const suiteHash = fingerprint(suite), configurationHash = fingerprint(cfg);
  const text = `${JSON.stringify(snapshot(suite), null, 2)}\n`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 }); // Refuse every pre-existing directory, including an empty one.
  await writeFile(join(destination, "suite.json"), text, { mode: 0o600, flag: "wx" });
  const manifest: ExperimentManifest = { version: 1, createdAt: new Date().toISOString(), complete: false, tool: { name: tool.name, version: tool.version }, mode: options.mode,
    suite: { name: suite.suite, sha256: suiteHash, snapshot: { path: "suite.json", sha256: hash(text) } }, configuration: { sha256: configurationHash, ...cfg }, dataset: { files, traces: [] }, runs: [] };
  await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return new ArtifactStore(destination, manifest);
}
async function artifact(dir: string, file: FileArtifact): Promise<unknown> {
  if (!file || typeof file.path !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.json$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid artifact reference");
  const path = join(dir, file.path);
  if (!(await lstat(path)).isFile()) throw new Error("Artifact must be a regular file");
  const bytes = await readFile(path);
  if (hash(bytes) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.path}`);
  return JSON.parse(bytes.toString()) as unknown;
}
/** Regrades saved responses without invoking a target or executing any saved command. */
export async function replayExperiment(directory: string): Promise<{ suite: Suite; provider: TraceProvider; manifest: ExperimentManifest }> {
  const dir = resolve(directory);
  if (!(await lstat(join(dir, "manifest.json"))).isFile()) throw new Error("Manifest must be a regular file");
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ExperimentManifest;
  if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.runs)) throw new Error("Only complete version-1 experiments can be replayed");
  const suite = SuiteSchema.parse(await artifact(dir, manifest.suite?.snapshot));
  if (!manifest.dataset || !Array.isArray(manifest.dataset.files) || !Array.isArray(manifest.dataset.traces) || manifest.dataset.sha256 !== fingerprint({files: manifest.dataset.files, traces: [...manifest.dataset.traces].sort((a, b) => compareText(a.caseId, b.caseId) || a.run - b.run)})) throw new Error("Dataset checksum mismatch");
  const report = await artifact(dir, manifest.report!) as SuiteResult;
  if (!report || !Array.isArray(report.cases) || report.suite !== suite.suite || report.mode !== manifest.mode || manifest.suite.name !== suite.suite) throw new Error("Report does not match its experiment");
  const expected = new Map<string, RunResult>();
  for (const c of report.cases) {
    if (typeof c.id !== "string" || !Array.isArray(c.runs)) throw new Error("Invalid experiment report case");
    for (const run of c.runs) {
      const key = keyFor(c.id, run.run);
      if (expected.has(key)) throw new Error("Duplicate report run");
      expected.set(key, run);
    }
  }
  if (manifest.runs.length !== expected.size) throw new Error("Manifest is missing experiment runs");
  const configurationHash = fingerprint({ judgeConfig: manifest.configuration.judgeConfig ?? null, target: manifest.configuration.target ?? null, execution: manifest.configuration.execution });
  if (manifest.configuration.sha256 !== configurationHash) throw new Error("Configuration checksum mismatch");
  const seen = new Set<string>(), runs = new Map<string, Array<{ run: number; trace?: Trace; error?: string }>>();
  for (const row of manifest.runs) {
    if (typeof row.caseId !== "string" || !Number.isSafeInteger(row.run) || row.run < 0 || !["pass", "fail", "unjudged", "error"].includes(row.status)) throw new Error("Invalid experiment run");
    const key = keyFor(row.caseId, row.run);
    if (expected.get(key)?.status !== row.status) throw new Error("Run does not match archived report");
    if (seen.has(key) || !suite.cases.some(c => c.id === row.caseId)) throw new Error("Duplicate or unknown experiment run");
    seen.add(key);
    const result = await artifact(dir, row.result) as RunResult;
    if (result.run !== row.run || result.status !== row.status || fingerprint(result) !== fingerprint(expected.get(key))) throw new Error("Result does not match its manifest and report");
    const indexed = manifest.dataset.traces.find(t => t.caseId === row.caseId && t.run === row.run);
    if (row.trace ? !indexed || fingerprint(row.trace) !== fingerprint(result.traceArtifact) || row.trace.path !== indexed.path || row.trace.sha256 !== indexed.sha256 : result.traceArtifact || indexed) throw new Error("Trace reference does not match its archived trial");
    const trace = row.trace ? TraceSchema.parse(await artifact(dir, row.trace)) : undefined;
    if (!trace && row.status !== "error") throw new Error("A non-error run is missing its trace");
    runs.set(row.caseId, [...(runs.get(row.caseId) ?? []), { run: row.run, ...(trace ? { trace } : { error: result.error ?? "Recorded provider error" }) }]);
  }
  const cases = suite.cases.filter(c => runs.has(c.id)).map(c => {
    const list = runs.get(c.id)!.sort((a, b) => a.run - b.run);
    if (list.some((r, i) => r.run !== i)) throw new Error("Run sequence has a gap");
    return { ...c, trace: undefined, traces: list.map((_, i) => `archived-run-${i + 1}.json`) };
  });
  if (!cases.length) throw new Error("Experiment has no recorded runs");
  const provider: TraceProvider = async (c, run) => {
    const item = runs.get(c.id)?.find(r => r.run === run);
    if (!item) throw new Error("No archived run for this case and trial");
    if (!item.trace) throw new Error(item.error ?? "Recorded provider error");
    return structuredClone(item.trace);
  };
  return { suite: SuiteSchema.parse({ ...suite, cases }), provider, manifest };
}
