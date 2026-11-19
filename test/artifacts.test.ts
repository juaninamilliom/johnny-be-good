import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore, fingerprint, replayExperiment, type ExperimentManifest } from "../src/runner/artifacts.js";
import { runSuite } from "../src/runner/runner.js";
import { parseSuite } from "../src/suite.js";
import { trace } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tracecheck-artifacts-")); roots.push(root); return join(root, "experiment"); }
const suite = parseSuite(`suite: captured\nadapter: {kind: command, command: "private command never replayed"}\ncases:\n  - id: ../../unsafe-name\n    task: Say hello\n    expect: [{final: hello}]\n  - id: unavailable\n    task: Say goodbye\n`);
async function manifest(dir: string): Promise<ExperimentManifest> { return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ExperimentManifest; }

async function captured() {
  const dir = await directory();
  const store = await createArtifactStore(dir, { suite, mode: "online", judgeConfig: { model: "judge-A", apiKey: "secret-value", baseUrl: "https://alice:private-password@example.invalid/?token=private-token", headers: { authorization: "Bearer secret" } }, target: { version: "app-v1", command: "private command" } });
  let calls = 0;
  const result = await runSuite(suite, { mode: "online", artifacts: store, provider: async c => { calls++; if (c.id === "unavailable") throw new Error("Target unavailable"); return trace({ final: "hello", calls: [["lookup", {city: "Lisbon"}, "tool response"]] }); } });
  return { dir, result, calls };
}

describe("experiment artifacts", () => {
  it("archives full responses, private files, sanitized metadata and real failure evidence", async () => {
    const {dir, result, calls} = await captured();
    const saved = await manifest(dir);
    expect(calls).toBe(2);
    expect(saved.complete).toBe(true);
    expect(saved.runs).toHaveLength(2);
    expect(saved.dataset.traces).toHaveLength(1);
    expect(result.cases[0]!.runs[0]!.traceArtifact).toMatchObject({path: expect.stringMatching(/^trace-[a-f0-9]+-1.json$/)});
    const text = JSON.stringify(saved);
    for (const secret of ["secret-value", "private-password", "private-token", "Bearer secret", "private command"]) expect(text).not.toContain(secret);
    const archived = JSON.parse(await readFile(join(dir, saved.dataset.traces[0]!.path), "utf8"));
    expect(archived).toMatchObject({ final: "hello", task: "Say hello", steps: [{name: "lookup", args: {city: "Lisbon"}, result: {content: "tool response"}}] });
    const snapshot = JSON.parse(await readFile(join(dir, "suite.json"), "utf8"));
    expect(snapshot.adapter).toBeUndefined();
    expect(snapshot.judges).toBeUndefined();
    expect(saved.suite.sha256).toBe(fingerprint(suite));
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "report.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("regrades archived traces while preserving provider errors and never calling the original target", async () => {
    const {dir, calls} = await captured();
    const replay = await replayExperiment(dir);
    const result = await runSuite(replay.suite, { mode: "offline", provider: replay.provider });
    expect(calls).toBe(2);
    expect(result.cases.map(c => c.status)).toEqual(["pass", "error"]);
    expect(result.cases[1]!.runs[0]!.error).toBe("Target unavailable");
    expect(replay.suite.adapter).toBeUndefined();
  });

  it("does not invent traces when all target requests fail", async () => {
    const dir = await directory();
    const store = await createArtifactStore(dir, { suite, mode: "online" });
    await runSuite(suite, { mode: "online", artifacts: store, provider: async () => { throw new Error("Offline target"); } });
    expect((await manifest(dir)).dataset.traces).toEqual([]);
    const replay = await replayExperiment(dir);
    const result = await runSuite(replay.suite, { mode: "offline", provider: replay.provider });
    expect(result.summary).toMatchObject({errored: 2, passed: 0});
  });

  it("preserves partial traces from a crashed target without ever grading them as passes", async () => {
    const dir = await directory();
    const one = parseSuite(`suite: crashed\ncases:\n  - id: partial\n    expect: [{final: hello}]\n`);
    const artifacts = await createArtifactStore(dir, {suite: one, mode: "online"});
    const result = await runSuite(one, {mode: "online", artifacts, provider: async () => trace({final: "hello", meta: {exitCode: 1}})});
    expect(result.summary).toMatchObject({passed: 0, errored: 1});
    expect(result.cases[0]!.runs[0]!).toMatchObject({status: "error", assertions: [], error: "Target process exited unsuccessfully (1)"});
    expect((await manifest(dir)).dataset.traces).toHaveLength(1);
    const replay = await replayExperiment(dir);
    const regraded = await runSuite(replay.suite, {mode: "offline", provider: replay.provider});
    expect(regraded.summary.errored).toBe(1);
  });

  it("refuses overwrite, mismatched context, tampering and unsafe artifact references", async () => {
    const {dir} = await captured();
    await expect(createArtifactStore(dir, {suite, mode: "online"})).rejects.toThrow();
    const saved = await manifest(dir);
    const traceFile = saved.dataset.traces[0]!;
    await writeFile(join(dir, traceFile.path), '{}');
    await expect(replayExperiment(dir)).rejects.toThrow("checksum mismatch");
    const second = await captured();
    const changed = await manifest(second.dir);
    changed.runs.find(r => r.trace)!.trace!.path = "../outside.json";
    await writeFile(join(second.dir, "manifest.json"), JSON.stringify(changed));
    await expect(replayExperiment(second.dir)).rejects.toThrow("Trace reference");
    const unused = await createArtifactStore(await directory(), {suite, mode: "online"});
    await expect(runSuite(suite, {mode: "offline", provider: async () => trace(), artifacts: unused})).rejects.toThrow("does not match");
  });

  it("marks aborted runs incomplete and refuses to replay them as complete", async () => {
    const dir = await directory(), store = await createArtifactStore(dir, {suite, mode: "online"});
    await expect(runSuite(suite, {mode: "online", concurrency: 1, artifacts: store, provider: async () => trace(), onRun: () => { throw new Error("Operator callback failed"); }})).rejects.toThrow("Operator callback failed");
    expect(await manifest(dir)).toMatchObject({complete: false, failure: "Operator callback failed"});
    await expect(replayExperiment(dir)).rejects.toThrow("Only complete");
  });

  it("drains in-flight workers and stops scheduling before marking an archive incomplete", async () => {
    const dir = await directory();
    const many = parseSuite(`suite: draining\ncases:\n  - {id: first}\n  - {id: second}\n  - {id: never-started}\n`);
    const artifacts = await createArtifactStore(dir, {suite: many, mode: "online"});
    const called: string[] = [];
    await expect(runSuite(many, {mode: "online", concurrency: 2, artifacts, provider: async c => { called.push(c.id); await new Promise(resolve => setTimeout(resolve, c.id === "first" ? 5 : 30)); return trace(); }, onRun: id => { if (id === "first") throw new Error("Stop after first"); }})).rejects.toThrow("Stop after first");
    expect(called).toEqual(["first", "second"]);
    const saved = await manifest(dir);
    expect(saved.complete).toBe(false);
    expect(saved.runs).toHaveLength(2);
  });

  it("fingerprints data/configuration changes deterministically without treating key order as a change", async () => {
    expect(fingerprint({a: 1, b: [2]})).toBe(fingerprint({b: [2], a: 1}));
    expect(fingerprint({a: [1, 2]})).not.toBe(fingerprint({a: [2, 1]}));
    const dirs = [await directory(), await directory(), await directory()];
    const source = join(roots[0]!, "dataset.json");
    await writeFile(source, JSON.stringify(trace({final: "first"})));
    for (let i = 0; i < dirs.length; i++) {
      if (i === 2) await writeFile(source, JSON.stringify(trace({final: "changed"})));
      const artifacts = await createArtifactStore(dirs[i]!, {suite, mode: "online", judgeConfig: {model: i === 1 ? "judge-B" : "judge-A"}, datasetFiles: [source]});
      await runSuite(suite, {mode: "online", artifacts, provider: async () => trace({final: i === 2 ? "changed" : "first"})});
    }
    const [a, b, c] = await Promise.all(dirs.map(manifest));
    expect(a!.configuration.sha256).not.toBe(b!.configuration.sha256);
    expect(a!.dataset.files[0]!.sha256).not.toBe(c!.dataset.files[0]!.sha256);
    expect(a!.dataset.traces[0]!.sha256).not.toBe(c!.dataset.traces[0]!.sha256);
  });

  it("rejects swapping valid traces between trials", async () => {
    const dir = await directory(), artifacts = await createArtifactStore(dir, {suite, mode: "online"});
    await runSuite(suite, {mode: "online", artifacts, provider: async c => trace({final: c.id})});
    const saved = await manifest(dir);
    saved.runs[0]!.trace = saved.runs[1]!.trace;
    await writeFile(join(dir, "manifest.json"), JSON.stringify(saved));
    await expect(replayExperiment(dir)).rejects.toThrow("Trace reference");
  });

  it("detects dropped recorded runs even when the manifest is still marked complete", async () => {
    const {dir} = await captured();
    const saved = await manifest(dir); saved.runs.pop();
    await writeFile(join(dir, "manifest.json"), JSON.stringify(saved));
    await expect(replayExperiment(dir)).rejects.toThrow("missing experiment runs");
  });
});
