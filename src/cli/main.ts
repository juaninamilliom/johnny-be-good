#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Terminal, colorEnabled, seg, type ColorMode } from "../report/terminal.js";
import { adapterProvider } from "../adapters/adapters.js";
import { calibrate, formatCalibration, loadLabels } from "../calibrate/calibrate.js";
import { judgesFromConfig } from "../judges/index.js";
import { diffBaseline, exitCode, formatResult } from "../report/report.js";
import { recordedTraces, runSuite, type SuiteResult } from "../runner/runner.js";
import { loadSuite, type JudgesConfig } from "../suite.js";

const HELP = `tracecheck: evaluate AI agents by what they did

Usage:
  tracecheck score <suite.yaml>      Score recorded traces (offline)
  tracecheck run <suite.yaml>        Run the agent through the suite's adapter (online)
  tracecheck import <transcript>     Convert a Claude Code transcript or stream-json to a trace
  tracecheck calibrate <labels.yaml> Measure the judges against human labels

Options for score and run:
  --only <ids>        Comma-separated case ids
  --runs <k>          Runs per case (run only; default from the suite)
  --concurrency <n>   Parallel runs (default 4)
  --out <file>        Write the results as JSON
  --baseline <file>   Compare with a saved result; regressions fail the run
  --no-judges         Skip rubric questions' judges (they report unjudged)
  --llm <provider>    Final judge tier: ollama or anthropic (overrides the suite)
  --model <name>      Model for the final judge tier
  --verbose           Show passing checks too
  --color <mode>      auto (default), always, or never; also applies to calibration
  --json              Print the results as JSON

Options for import:
  --out <file>        Write the trace to a file (default: stdout)
  --sidechains        Keep subagent steps

Exit codes: 0 passed, 1 a failure, error or regression, 2 only unjudged cases.
Env: TYPESAFE_API_KEY enables the Jev tier. OLLAMA_HOST overrides the Ollama URL.
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: "string" },
      runs: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      baseline: { type: "string" },
      "no-judges": { type: "boolean" },
      llm: { type: "string" },
      model: { type: "string" },
      verbose: { type: "boolean" },
      json: { type: "boolean" },
      color: { type: "string" },
      sidechains: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, target] = positionals;
  const color = values.color ?? "auto";
  if (!["auto", "always", "never"].includes(color)) throw new Error("--color must be auto, always, or never");
  const colorMode = color as ColorMode;
  const presentation = { color: colorEnabled(colorMode, !!process.stdout.isTTY), width: process.stdout.columns || 100 };

  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version);
    return 0;
  }
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  if (!target) throw new Error(`${command}: missing file argument`);

  if (command === "import") {
    const { importClaudeCode } = await import("../importers/claude-code.js");
    const text = await readFile(target, "utf8");
    const trace = importClaudeCode(text, { path: target, ...(values.sidechains ? { includeSidechains: true } : {}) });
    const json = JSON.stringify(trace, null, 2);
    if (values.out) await writeFile(values.out, `${json}\n`);
    else console.log(json);
    return 0;
  }

  const llmOverride = (cfg: JudgesConfig | undefined): JudgesConfig | undefined => {
    if (!values.llm && !values.model) return cfg;
    const provider = values.llm ?? (cfg?.llm ? cfg.llm.provider : "ollama");
    if (provider !== "ollama" && provider !== "anthropic") throw new Error(`--llm must be ollama or anthropic, got "${provider}"`);
    return { ...cfg, llm: { ...(cfg?.llm || {}), provider, maxTraceChars: (cfg?.llm || undefined)?.maxTraceChars ?? 40_000, ...(values.model ? { model: values.model } : {}) } };
  };

  if (command === "calibrate") {
    const { rubrics, items } = await loadLabels(target);
    const judges = judgesFromConfig(llmOverride(undefined));
    const report = await calibrate(items, rubrics, judges);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatCalibration(report, presentation));
    return report.failures.length ? 1 : 0;
  }

  if (command !== "score" && command !== "run") throw new Error(`unknown command "${command}" (try --help)`);
  const suite = await loadSuite(target);
  const baseDir = dirname(resolve(target));
  const mode = command === "score" ? "offline" : "online";
  if (mode === "online" && !suite.adapter) throw new Error(`${target}: "run" needs an adapter in the suite`);
  const provider = mode === "offline" ? recordedTraces(baseDir) : adapterProvider(suite.adapter!, baseDir);
  const judges = values["no-judges"] ? [] : judgesFromConfig(llmOverride(suite.judges));

  const progress = new Terminal({ color: colorEnabled(colorMode, !!process.stderr.isTTY), width: process.stderr.columns || 100 });
  const interactive = !!process.stderr.isTTY && !values.json && process.env.TERM !== "dumb";
  let completed = 0;
  let result: SuiteResult;
  try {
    result = await runSuite(suite, {
      provider,
      mode,
      judges,
      ...(values.only ? { only: values.only.split(",").map((s) => s.trim()) } : {}),
      ...(values.runs ? { runs: positiveInt(values.runs, "--runs") } : {}),
      ...(values.concurrency ? { concurrency: positiveInt(values.concurrency, "--concurrency") } : {}),
      onRun: (id, r) => {
        completed++;
        if (interactive) process.stderr.write(`\r\x1b[2K${progress.line([seg(`${completed} runs complete`, "cyan"), seg(` · ${id.replace(/[\r\n]/g, " ")} · run ${r.run + 1} `, "muted"), seg(r.status.toUpperCase(), r.status)]).split("\n")[0]}`);
      },
    });
  } finally {
    if (interactive && completed) process.stderr.write("\r\x1b[2K");
  }
  const baseline = values.baseline ? (JSON.parse(await readFile(values.baseline, "utf8")) as SuiteResult) : undefined;
  const diff = baseline ? diffBaseline(baseline, result) : undefined;
  if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(values.json ? JSON.stringify(diff ? { ...result, baseline: diff } : result, null, 2) : formatResult(result, { ...presentation, judgesDisabled: values["no-judges"] ?? false, verbose: values.verbose ?? false, ...(diff ? { diff } : {}) }));
  return exitCode(result, diff);
}

function positiveInt(v: string, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const terminal = new Terminal({ color: colorEnabled("auto", !!process.stderr.isTTY), width: process.stderr.columns || 100 });
    console.error(terminal.line([seg("tracecheck: ", "error"), seg(err instanceof Error ? err.message : String(err), "fail")]));
    process.exit(1);
  },
);
