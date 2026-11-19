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

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
/** Run only the process group we created; bounded output and escalation prevent stuck CI. */
export const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolvePromise, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell, detached: grouped, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0;
    let timedOut = false, failure: Error | undefined, settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new Error("Could not stop the adapter process");
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(deadline);
      if (failure) reject(failure);
      else resolvePromise({ stdout, stderr, code, timedOut });
    };
    const stop = () => {
      if (escalation || settled) return;
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 250);
      deadline = setTimeout(() => {
        failure ??= new Error(timedOut ? "Adapter timed out and did not close after termination" : "Adapter did not close after termination");
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);
      }, 1500);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdoutBytes += Buffer.byteLength(data);
      if (stdoutBytes > MAX_STDOUT) { failure ??= new Error("Adapter stdout exceeded 8 MiB"); stop(); }
      else stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderrBytes += Buffer.byteLength(data);
      if (stderrBytes > MAX_STDERR) { failure ??= new Error("Adapter stderr exceeded 1 MiB"); stop(); }
      else stderr += data;
    });
    // EPIPE is expected if the adapter exits before reading the task. Other I/O errors are visible.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") { failure ??= error; stop(); } });
    child.on("error", error => { failure = error; finish(null); });
    child.on("close", finish);
    child.stdin.end(opts.input);
  });

/**
 * Online mode. Each run starts the agent fresh and reads the trace it prints.
 *
 * - `claude-code` runs `claude -p <task> --output-format stream-json --verbose [args]`.
 *   The task is its own argument, and no shell runs.
 * - `command` runs a shell command written in the suite. The task arrives in the
 *   TRACECHECK_TASK environment variable and on stdin. The command string runs exactly
 *   as written. The command prints a native trace or Claude Code stream-json.
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
