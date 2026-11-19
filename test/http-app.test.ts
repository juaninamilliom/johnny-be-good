import { afterEach, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
const children: ChildProcess[] = [];
async function demo(wrong = false, malformed = false): Promise<string> {
  const child = spawn(process.execPath, [resolve("examples/http-app/demo-server.mjs")], { env: { ...process.env, PORT: "0", DEMO_WRONG_ANSWER: wrong ? "1" : "0", DEMO_MALFORMED_JSON: malformed ? "1" : "0" }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  return new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("Demo server did not start")), 5000);
    let output = "";
    child.stderr!.on("data", chunk => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/evaluate/);
      if (match) { clearTimeout(timer); ready(match[0]); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Demo server exited ${code}`)); });
  });
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once("close", () => done()); child.kill("SIGTERM");
  })));
});
const command = [resolve("node_modules/vite-node/vite-node.mjs"), resolve("src/cli/main.ts"), "run", resolve("examples/http-app/suite.yaml"), "--no-judges", "--json"];
describe("documented HTTP application example", () => {
  it("passes known answers through the actual CLI, command adapter and local endpoint", async () => {
    const endpoint = await demo();
    const { stdout, stderr } = await exec(process.execPath, command, { env: { ...process.env, TRACECHECK_APP_URL: endpoint, TRACECHECK_APP_TOKEN: "" }, timeout: 10000 });
    const result = JSON.parse(stdout) as { summary: { passed: number; failed: number }; judges: string[] };
    expect(result.summary).toMatchObject({ passed: 2, failed: 0 });
    expect(result.judges).toEqual([]); expect(stderr).toBe("");
  }, 15000);
  it("archives live responses and replays them after the app is stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "johnny-http-"));
    try {
      const endpoint = await demo();
      const experiment = join(directory, "experiment");
      await exec(process.execPath, [...command, "--artifacts", experiment, "--target-version", "fictional-demo-v1"], { env: { ...process.env, TRACECHECK_APP_URL: endpoint, TRACECHECK_APP_TOKEN: "" }, timeout: 10000 });
      const manifest = JSON.parse(await readFile(join(experiment, "manifest.json"), "utf8")) as { complete: boolean; dataset: {traces: unknown[]} };
      expect(manifest.complete).toBe(true); expect(manifest.dataset.traces).toHaveLength(2);
      const child = children.at(-1)!;
      await new Promise<void>(closed => { child.once("close", () => closed()); child.kill("SIGTERM"); });
      const replayCommand = [resolve("node_modules/vite-node/vite-node.mjs"), resolve("src/cli/main.ts"), "replay", experiment, "--no-judges", "--json"];
      const { stdout } = await exec(process.execPath, replayCommand, { env: { ...process.env, TRACECHECK_APP_URL: "http://127.0.0.1:1/unavailable", TRACECHECK_APP_TOKEN: "" }, timeout: 10000 });
      expect((JSON.parse(stdout) as {summary: {passed: number}}).summary.passed).toBe(2);
    } finally { await rm(directory, {recursive: true, force: true}); }
  }, 20000);

  it("does not echo a private malformed response in adapter errors", async () => {
    const endpoint = await demo(false, true);
    try {
      await exec(process.execPath, command, { env: { ...process.env, TRACECHECK_APP_URL: endpoint, TRACECHECK_APP_TOKEN: "" }, timeout: 10000 });
      throw new Error("Expected malformed app JSON to fail");
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      const text = `${failure.stdout || ""}${failure.stderr || ""}`;
      expect(text).not.toContain("private-response-sentinel");
      expect(text).toContain("JSON parsing, or response mapping failed");
    }
  }, 15000);

  it("rejects wrong answers despite successful HTTP responses", async () => {
    const endpoint = await demo(true);
    try {
      await exec(process.execPath, command, { env: { ...process.env, TRACECHECK_APP_URL: endpoint, TRACECHECK_APP_TOKEN: "" }, timeout: 10000 });
      throw new Error("Expected wrong answers to fail");
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string };
      expect(failure.code).toBe(1);
      const result = JSON.parse(failure.stdout || "{}") as { summary: { failed: number } };
      expect(result.summary.failed).toBe(2);
    }
  }, 15000);
});
