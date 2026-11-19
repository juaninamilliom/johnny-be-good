#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Terminal, colorEnabled, seg, type ColorMode } from "../report/terminal.js";
import { adapterProvider } from "../adapters/adapters.js";
import { calibrate, calibrateHeldOut, formatCalibration, formatHeldOutCalibration, loadLabels } from "../calibrate/calibrate.js";
import { judgesFromConfig } from "../judges/index.js";
import { diffBaseline, exitCode, formatResult } from "../report/report.js";
import { runSuite, type SuiteResult } from "../runner/runner.js";
import { loadRecordedDataset } from "../runner/dataset.js";
import { createArtifactStore, replayExperiment } from "../runner/artifacts.js";
import { loadSuite, JevConfigSchema, LlmConfigSchema, type JudgesConfig } from "../suite.js";

const HELP = `Johnny Be Good: evaluate AI agents by what they did

Usage:
  johnny-be-good score <suite.yaml>      Score recorded traces (offline)
  johnny-be-good run <suite.yaml>        Run the agent through the suite's adapter (online)
  johnny-be-good import <transcript>     Convert a Claude Code transcript or stream-json to a trace
  johnny-be-good calibrate <labels.yaml> Measure the judges against human labels

  johnny-be-good replay <experiment-dir> Regrade archived responses without calling the app

Options for score, run and replay:
  --artifacts <dir>   Save traces, report and manifest in a NEW private directory
  --target-version <id> Record a non-secret app/prompt revision in the manifest
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

Options for calibration:
  --held-out <labels> Validate a frozen tuning-selected threshold on separate labels

Options for import:
  --out <file>        Write the trace to a file (default: stdout)
  --sidechains        Keep subagent steps

Exit codes for score/run/replay: 0 passed, 1 failure/error/regression, 2 only unjudged.
Calibration: 0 measurement completed, 1 invalid/error/unanswered; not a quality gate.
Env: TYPESAFE_API_KEY enables the Jev tier. OLLAMA_HOST overrides the Ollama URL.
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: "string" },
      artifacts: { type: "string" },
      "target-version": { type: "string" },
      "held-out": { type: "string" },
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
  if (positionals.length !== 2) throw new Error("Expected one file or experiment directory argument");
  const allowed: Record<string, string[]> = {
    import: ["out", "sidechains"], calibrate: ["llm", "model", "held-out", "out"],
    score: ["only", "concurrency", "out", "baseline", "no-judges", "llm", "model", "verbose", "artifacts", "target-version"],
    replay: ["only", "concurrency", "out", "baseline", "no-judges", "llm", "model", "verbose", "artifacts", "target-version"],
    run: ["only", "runs", "concurrency", "out", "baseline", "no-judges", "llm", "model", "verbose", "artifacts", "target-version"],
  };
  for (const [flag, value] of Object.entries(values)) {
    if (value !== undefined && !["color", "json", "help", "version", ...(allowed[command] ?? [])].includes(flag)) throw new Error(`--${flag} is not supported by ${command}`);
  }


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
    if (values["held-out"]) {
      const heldOut = await loadLabels(values["held-out"]);
      if (JSON.stringify(heldOut.rubrics) !== JSON.stringify(rubrics)) throw new Error("Tuning and held-out rubric definitions must match exactly");
      const report = await calibrateHeldOut(items, heldOut.items, rubrics, judges);
      if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(values.json ? JSON.stringify(report, null, 2) : formatHeldOutCalibration(report, presentation));
      return report.tuning.failures.length || report.validation.failures.length || report.validation.unjudged ? 1 : 0;
    }
    const report = await calibrate(items, rubrics, judges);
    if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatCalibration(report, presentation));
    return report.failures.length || !report.questions ? 1 : 0;
  }

  if (!["score", "run", "replay"].includes(command)) throw new Error(`unknown command "${command}" (try --help)`);
  if (values["held-out"]) throw new Error("--held-out is only supported by calibrate");
  if (command !== "run" && values.runs) throw new Error("--runs is only supported by run; recorded trials are preserved");
  const replay = command === "replay" ? await replayExperiment(target) : undefined;
  let suite = replay?.suite ?? await loadSuite(target);
  const baseDir = dirname(resolve(target));
  const mode = command === "run" ? "online" : "offline";
  if (mode === "online" && !suite.adapter) throw new Error(`${target}: "run" needs an adapter in the suite`);
  if (mode === "online" && suite.cases.some(c => c.traces && !Array.isArray(c.traces))) throw new Error("JSONL datasets are offline only; use score");
  const dataset = mode === "offline" && !replay ? await loadRecordedDataset(suite, baseDir) : undefined;
  if (dataset) suite = dataset.suite;
  const provider = replay?.provider ?? dataset?.provider ?? adapterProvider(suite.adapter!, baseDir);
  // Replay starts with no judges unless explicitly selected; saved responses never silently leave the machine.
  const judgeConfig = llmOverride(replay ? { jev: false, llm: false } : suite.judges);
  const judges = values["no-judges"] ? [] : judgesFromConfig(judgeConfig);
  const effectiveJudgeConfig = {
    jev: values["no-judges"] || judgeConfig?.jev === false || (!judgeConfig?.jev && !process.env.TYPESAFE_API_KEY) ? false : { ...JevConfigSchema.parse(judgeConfig?.jev || {}), model: judgeConfig?.jev && judgeConfig.jev.model || "provider default (not pinned)" },
    llm: values["no-judges"] || judgeConfig?.llm === false ? false : { ...LlmConfigSchema.parse(judgeConfig?.llm || {}), resolvedTier: judges.find(j => j.tier !== "jev")?.tier },
  };
  const baseline = values.baseline ? await loadBaseline(values.baseline) : undefined;
  const artifacts = values.artifacts ? await createArtifactStore(values.artifacts, {
    suite, mode, judgeConfig: effectiveJudgeConfig,
    target: { ...(values["target-version"] ? { version: values["target-version"] } : {}), ...(replay ? { replayOf: replay.manifest.suite.sha256 } : {}), applicationRevisionPinned: !!values["target-version"] },
    datasetFiles: dataset?.datasetFiles ?? [],
  }) : undefined;

  const progress = new Terminal({ color: colorEnabled(colorMode, !!process.stderr.isTTY), width: process.stderr.columns || 100 });
  const interactive = !!process.stderr.isTTY && !values.json && process.env.TERM !== "dumb";
  let completed = 0;
  let result: SuiteResult;
  try {
    result = await runSuite(suite, {
      provider,
      mode,
      ...(artifacts ? { artifacts } : {}),
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
  const diff = baseline ? diffBaseline(baseline, result) : undefined;
  if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(values.json ? JSON.stringify(diff ? { ...result, baseline: diff } : result, null, 2) : formatResult(result, { ...presentation, judgesDisabled: values["no-judges"] || !!replay && !judges.length, verbose: values.verbose ?? false, ...(diff ? { diff } : {}) }));
  return exitCode(result, diff);
}

async function loadBaseline(path: string): Promise<SuiteResult> {
  const value = JSON.parse(await readFile(path, "utf8")) as SuiteResult;
  if (!value || typeof value.suite !== "string" || !Array.isArray(value.cases) || !value.cases.length) throw new Error("Baseline must be a nonempty evaluation report");
  const ids = new Set<string>();
  for (const c of value.cases) {
    if (!c || typeof c.id !== "string" || ids.has(c.id) || !["pass", "fail", "unjudged", "error"].includes(c.status) || !Number.isFinite(c.passRate) || c.passRate < 0 || c.passRate > 1) throw new Error("Baseline contains invalid or duplicate case results");
    ids.add(c.id);
  }
  return value;
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
    console.error(terminal.line([seg("Johnny Be Good: ", "error"), seg(err instanceof Error ? err.message : String(err), "fail")]));
    process.exit(1);
  },
);
