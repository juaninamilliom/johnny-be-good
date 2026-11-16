import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseTrace } from "../importers/index.js";
import type { TraceProvider } from "../runner/runner.js";
import type { AdapterConfig, Case } from "../suite.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type Spawner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; shell: boolean }) => Promise<ProcessResult>;

export const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(opts.input);
  });

/**
 * Online mode. Each run starts the agent fresh and reads the trace it prints.
 *
 * - `claude-code` runs `claude -p <task> --output-format stream-json --verbose [args]`.
 *   The task is an argument, never part of a shell string.
 * - `command` runs a shell command written in the suite. The task arrives in the
 *   TRACECHECK_TASK environment variable and on stdin, never interpolated into the
 *   command. The command prints a native trace or Claude Code stream-json.
 */
export function adapterProvider(cfg: AdapterConfig, baseDir: string, spawner: Spawner = defaultSpawner): TraceProvider {
  return async (c: Case, run: number) => {
    if (!c.task) throw new Error(`case "${c.id}" has no task to give the agent`);
    const cwd = resolve(baseDir, cfg.cwd ?? ".");
    const env = { ...process.env, TRACECHECK_TASK: c.task, TRACECHECK_CASE: c.id, TRACECHECK_RUN: String(run + 1) };
    const [cmd, args, shell] =
      cfg.kind === "claude-code"
        ? ["claude", ["-p", c.task, "--output-format", "stream-json", "--verbose", ...cfg.args], false]
        : [cfg.command, [], true];
    let res: ProcessResult;
    try {
      res = await spawner(cmd, args, { cwd, env, input: c.task, timeoutMs: cfg.timeoutMs, shell });
    } catch (err) {
      throw new Error(`could not start ${cfg.kind === "claude-code" ? "claude" : "the command"}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.timedOut) throw new Error(`agent timed out after ${cfg.timeoutMs} ms`);
    if (!res.stdout.trim()) throw new Error(`agent printed nothing (exit ${res.code})${res.stderr ? `: ${res.stderr.trim().slice(0, 300)}` : ""}`);
    const trace = parseTrace(res.stdout, { id: `${c.id}#${run + 1}` });
    // An agent that exits non-zero still produced a trace worth scoring; record the exit.
    return { ...trace, id: `${c.id}#${run + 1}`, task: trace.task ?? c.task, meta: { ...trace.meta, exitCode: res.code } };
  };
}
