import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adapterProvider, defaultSpawner, type Spawner } from "../src/adapters/adapters.js";
import { AdapterConfigSchema, CaseSchema } from "../src/suite.js";

const stream = readFileSync(new URL("./fixtures/stream.jsonl", import.meta.url), "utf8");
const kase = CaseSchema.parse({ id: "ls", task: "List files; rm -rf / # shell text" });

describe("adapters", () => {
  it("runs claude -p with the task as an argument and parses stream-json", async () => {
    const calls: Array<{ cmd: string; args: string[]; shell: boolean }> = [];
    const spawner: Spawner = async (cmd, args, o) => {
      calls.push({ cmd, args, shell: o.shell });
      return { stdout: stream, stderr: "", code: 0, timedOut: false };
    };
    const provider = adapterProvider(AdapterConfigSchema.parse({ kind: "claude-code", args: ["--model", "claude-haiku-5-5"] }), "/tmp", spawner);
    const t = await provider(kase, 1);
    expect(calls[0]).toEqual({ cmd: "claude", args: ["-p", kase.task, "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-5-5"], shell: false });
    expect(t.id).toBe("ls#2");
    expect(t.final).toBe("The directory is empty.");
    expect(t.meta?.exitCode).toBe(0);
  });

  it("gives a command the task through the environment", async () => {
    const provider = adapterProvider(
      AdapterConfigSchema.parse({ kind: "command", command: `node -e 'const t=process.env.TRACECHECK_TASK; console.log(JSON.stringify({id:"x",task:t,steps:[],final:t.length+""}))'` }),
      process.cwd(),
      defaultSpawner,
    );
    const t = await provider(kase, 0);
    expect(t.task).toBe(kase.task);
    expect(t.final).toBe(String(kase.task!.length));
  });

  it("fails visibly on timeouts and empty output", async () => {
    const slow: Spawner = async () => ({ stdout: "", stderr: "", code: null, timedOut: true });
    await expect(adapterProvider(AdapterConfigSchema.parse({ kind: "command", command: "x", timeoutMs: 5 }), ".", slow)(kase, 0)).rejects.toThrow("agent timed out after 5 ms");
    const quiet: Spawner = async () => ({ stdout: "", stderr: "boom", code: 1, timedOut: false });
    await expect(adapterProvider(AdapterConfigSchema.parse({ kind: "command", command: "x" }), ".", quiet)(kase, 0)).rejects.toThrow("agent printed nothing (exit 1): boom");
    await expect(adapterProvider(AdapterConfigSchema.parse({ kind: "command", command: "x" }), ".", quiet)(CaseSchema.parse({ id: "n" }), 0)).rejects.toThrow(/no task/);
  });
});

// Exercise real subprocess boundaries with synthetic programs only.
describe("adapter process boundaries", () => {
  it("terminates an adapter that ignores SIGTERM within a bounded interval", async () => {
    const started = Date.now();
    const r = await defaultSpawner(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { cwd: process.cwd(), env: process.env, input: "", timeoutMs: 150, shell: false });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("bounds captured output instead of accumulating without limit", async () => {
    await expect(defaultSpawner(process.execPath, ["-e", "process.stdout.write('x'.repeat(9*1024*1024))"], { cwd: process.cwd(), env: process.env, input: "", timeoutMs: 5000, shell: false })).rejects.toThrow("stdout exceeded 8 MiB");
  });
  it("reports spawn errors and handles a child closing stdin early", async () => {
    await expect(defaultSpawner("johnny-be-good-nonexistent-command", [], { cwd: process.cwd(), env: process.env, input: "", timeoutMs: 1000, shell: false })).rejects.toThrow();
    const r = await defaultSpawner(process.execPath, ["-e", "process.exit(0)"], { cwd: process.cwd(), env: process.env, input: "x".repeat(1024*1024), timeoutMs: 1000, shell: false });
    expect(r.code).toBe(0);
  });
});
