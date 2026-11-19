import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssertionSchema, runAssertion } from "../src/assertions/assertions.js";
import { parseSuite } from "../src/suite.js";
import { loadRecordedDataset } from "../src/runner/dataset.js";
import { runSuite } from "../src/runner/runner.js";
import { createArtifactStore, replayExperiment } from "../src/runner/artifacts.js";
import { exitCode, formatResult } from "../src/report/report.js";
import { trace } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), "jbg-dataset-")); roots.push(root);
  await writeFile(join(root, "rows.jsonl"), text);
  const suite = parseSuite(`suite: decisions
judges: { jev: false, llm: false }
cases:
  - id: rule
    traces: { jsonl: rows.jsonl }
    expect:
      - field: { from: final, path: actions.0.leverage, gt: 0, lte: 5 }
      - field: { from: meta, path: priorLoss, equals: false }
`);
  return { root, suite };
}
const row = (id: string, leverage = 3) => JSON.stringify({ version: 1, id, steps: [], final: JSON.stringify({ actions: [{ leverage }] }), meta: { priorLoss: false } });

describe("structured field checks", () => {
  const t = trace({ final: JSON.stringify({ n: 3, text: "hello", nil: null, list: ["OPEN"] }) });
  it("reuses all matchers and combines bounds", () => {
    const checks = [
      {path: "n", equals: 3}, {path: "n", oneOf: [2, 3]}, {path: "n", gt: 1, gte: 3, lt: 4, lte: 3},
      {path: "text", contains: "ell", notContains: "bad", regex: "^hello$"},
      {path: "nil", equals: null, exists: true}, {path: "list.0", equals: "OPEN"}, {path: "missing", exists: false},
    ];
    for (const field of checks) expect(runAssertion(t, AssertionSchema.parse({ field: { from: "final", ...field } })).passed).toBe(true);
    expect(runAssertion(t, AssertionSchema.parse({ field: { from: "final", path: "n", lte: 2 } })).passed).toBe(false);
  });
  it("does not let negative-only matchers pass absent fields or inherited paths", () => {
    for (const path of ["missing", "constructor", "__proto__.constructor"]) {
      expect(runAssertion(t, {field: {from: "final", path, notContains: "bad"}})).toMatchObject({passed: false, detail: `missing path: final.${path}`});
    }
    expect(runAssertion(t, {field: {from: "meta", path: "missing", equals: false}}).passed).toBe(false);
  });
  it("reports invalid JSON with a bounded excerpt, including when testing absence", () => {
    const answer = "x".repeat(100);
    expect(runAssertion(trace({final: answer}), {field: {from: "final", path: "a", exists: false}}))
      .toMatchObject({passed: false, detail: `final answer is not JSON: ${answer.slice(0, 80)}`});
  });
});

describe("native JSONL datasets", () => {
  it("isolates malformed rows and preserves IDs, physical lines and independent-sample metrics", async () => {
    const {root, suite} = await fixture([row("one"), "", "{broken", row("two", 8)].join("\n"));
    const dataset = await loadRecordedDataset(suite, root);
    const result = await runSuite(dataset.suite, {provider: dataset.provider, mode: "offline"});
    expect(result.cases.map(c => c.status)).toEqual(["pass", "error", "fail"]);
    const selected = await runSuite(dataset.suite, {provider: dataset.provider, mode: "offline", only: ["rule"]});
    expect(selected.cases).toHaveLength(3);
    expect(result.cases.map(c => c.sampleSource?.line)).toEqual([1, 3, 4]);
    expect(result.cases[0]?.runs[0]?.traceId).toBe("one");
    expect(result.cases[2]?.runs[0]?.traceId).toBe("two");
    expect(result.cases[1]?.runs[0]?.error).toContain("rows.jsonl:3:");
    expect(result.summary).toMatchObject({datasetSamples: 3, datasetPassRate: 1/3, k: 0, passHatK: 0});
    expect(formatResult(result)).toContain("3 independent samples");
    expect(formatResult(result)).not.toContain("pass^1");
    expect(exitCode(result)).toBe(1);
  });
  it("replays archived rows and errors after deleting the export", async () => {
    const {root, suite} = await fixture(`${row("saved")}\nnot-json\n`);
    const dataset = await loadRecordedDataset(suite, root);
    const dir = join(root, "archive");
    const artifacts = await createArtifactStore(dir, {suite: dataset.suite, mode: "offline", datasetFiles: dataset.datasetFiles});
    const before = await runSuite(dataset.suite, {provider: dataset.provider, mode: "offline", artifacts});
    await rm(join(root, "rows.jsonl"));
    const replay = await replayExperiment(dir);
    const after = await runSuite(replay.suite, {provider: replay.provider, mode: "offline"});
    expect(after.cases.map(c => [c.sampleSource, c.status, c.runs[0]?.traceId, c.runs[0]?.error])).toEqual(before.cases.map(c => [c.sampleSource, c.status, c.runs[0]?.traceId, c.runs[0]?.error]));
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest.dataset.files).toHaveLength(1);
    expect(manifest.dataset.files[0].name).toBe("rows.jsonl");
  });
  it("scores JSONL through the actual CLI and keeps JSON output clean", async () => {
    const {root} = await fixture(row("cli-row"));
    const suiteFile = join(root, "suite.yaml");
    await writeFile(suiteFile, `suite: cli-dataset\ncases:\n  - id: decisions\n    traces: { jsonl: rows.jsonl }\n    expect:\n      - field: { from: final, path: actions.0.leverage, lte: 5 }\n`);
    const {stdout, stderr} = await promisify(execFile)(process.execPath, ["node_modules/vite-node/vite-node.mjs", "src/cli/main.ts", "score", suiteFile, "--no-judges", "--json"], {env: {...process.env, TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: ""}});
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.summary).toMatchObject({passed: 1, datasetSamples: 1});
    expect(report.cases[0].runs[0].traceId).toBe("cli-row");
  });
  it("rejects empty, absent and ambiguous datasets", async () => {
    const {root, suite} = await fixture("\n  \n");
    await expect(loadRecordedDataset(suite, root)).rejects.toThrow("dataset is empty");
    await rm(join(root, "rows.jsonl"));
    await expect(loadRecordedDataset(suite, root)).rejects.toThrow("ENOENT");
    suite.cases[0]!.trace = "other.json";
    await expect(loadRecordedDataset(suite, root)).rejects.toThrow("cannot be combined");
  });
  it("rejects generated ID collisions and isolates schema-invalid native traces", async () => {
    const {root, suite} = await fixture(`${row("good")}\n{"id":"bad","steps":"wrong"}\n`);
    const dataset = await loadRecordedDataset(suite, root);
    const result = await runSuite(dataset.suite, {provider: dataset.provider, mode: "offline"});
    expect(result.cases.map(c => c.status)).toEqual(["pass", "error"]);
    suite.cases.push({id: "rule::line:1", expect: [], rubric: []});
    await expect(loadRecordedDataset(suite, root)).rejects.toThrow("ID collision");
  });
  it("keeps ordinary trace lists working alongside datasets", async () => {
    const {root, suite} = await fixture(row("dataset"));
    await writeFile(join(root, "single.json"), row("ordinary"));
    suite.cases.push({...suite.cases[0]!, id: "ordinary", traces: ["single.json"]});
    const dataset = await loadRecordedDataset(suite, root);
    const result = await runSuite(dataset.suite, {provider: dataset.provider, mode: "offline"});
    expect(result.cases.map(c => c.runs[0]?.traceId)).toEqual(["dataset", "ordinary"]);
    expect(result.summary).toMatchObject({passed: 2, datasetSamples: 1, passAt1: 1});
  });
});
