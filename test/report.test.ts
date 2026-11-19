import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { loadSuite } from "../src/suite.js";
import { runSuite, recordedTraces } from "../src/runner/runner.js";
import { formatResult, exitCode } from "../src/report/report.js";
import { Terminal, clean, colorEnabled, seg } from "../src/report/terminal.js";
import { formatCalibration, type CalibrationReport } from "../src/calibrate/calibrate.js";
import { resolve } from "node:path";
import { runAssertion } from "../src/assertions/assertions.js";
import { trace } from "./helpers.js";

async function lisbon() {
  const suite = await loadSuite(resolve("examples/weather/suite.yaml"));
  return runSuite(suite, { provider: recordedTraces(resolve("examples/weather")), mode: "offline" });
}

describe("terminal report", () => {
  it("does not let display diagnostics change a valid in-memory verdict", () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    const result = runAssertion(trace({ calls: [["get_weather", cyclic]] }), { toolCalled: "get_weather" });
    expect(result.passed).toBe(true);
    expect(result.diagnostic?.actual).toContain("not JSON-serializable");
  });

  it("keeps failures, missing judges and recorded usage distinct without changing the result", async () => {
    const result = await lisbon();
    const before = JSON.stringify(result);
    const plain = formatResult(result, { verbose: true, judgesDisabled: true });
    const colored = formatResult(result, { verbose: true, judgesDisabled: true, color: true });
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(colored).toContain("\x1b[31m");
    expect(colored).toContain("\x1b[32m");
    expect(colored).toContain("\x1b[33m");
    expect(plain).not.toContain("\x1b");
    for (const text of ["1 case · 2 runs", "RUN 01  UNJUDGED", "RUN 02  FAIL", "9/10 exact checks passed", "4/4 rubric questions unjudged", "expected  get_weather", "actual    search_web", "690 tokens in recorded traces", "no model judge calls this run"]) expect(plain).toContain(text);
    expect(JSON.stringify(result)).toBe(before);
    expect(exitCode(result)).toBe(1);
  });

  it("fits a narrow report and strips trace-supplied terminal commands", async () => {
    const result = await lisbon();
    result.cases[0]!.id = "\x1b[2Jlisbon\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07";
    const plain = formatResult(result, { verbose: true, width: 48 });
    expect(plain).not.toContain("\x1b");
    expect(plain).not.toContain("https://example.invalid");
    expect(plain).toContain("lisbonlink");
    expect(plain.split("\n").every(line => Array.from(line).length <= 48)).toBe(true);
  });

  it("retains baseline failures and makes errored runs visible", async () => {
    const result = await lisbon();
    result.cases[0]!.runs[0]!.error = "Synthetic provider failure";
    const output = formatResult(result, { diff: { regressions: [{ id: "lisbon", before: "pass", after: "fail", change: "regressed" }], fixes: [], all: [] } });
    expect(output).toContain("Synthetic provider failure");
    expect(output).toContain("REGRESSED lisbon");
    expect(exitCode(result)).toBe(1);
  });

  it("respects color intent, environment and output stream capabilities", () => {
    expect(colorEnabled("auto", false, {})).toBe(false);
    expect(colorEnabled("auto", true, {})).toBe(true);
    expect(colorEnabled("auto", true, { NO_COLOR: "", FORCE_COLOR: "1" })).toBe(false);
    expect(colorEnabled("auto", true, { TERM: "dumb" })).toBe(false);
    expect(colorEnabled("auto", true, { FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled("auto", false, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled("always", false, { NO_COLOR: "1" })).toBe(true);
    expect(colorEnabled("never", true, { FORCE_COLOR: "1" })).toBe(false);
    expect(clean("bad\r\x00\x1b[31mred\x1b[0m")).toBe("badred");
    expect(new Terminal({width: 40}).line([seg("a".repeat(100), "cyan")]).split("\n").every(line => line.length <= 40)).toBe(true);
  });

  it("renders calibration with shared styling and a labeled narrow layout", () => {
    const row = { strictness: 0.15, jevDecided: 2, jevDecidedAccuracy: 1, cascadeAccuracy: 1, escalationRate: 0.5 };
    const report: CalibrationReport = { questions: 4, tiers: [{ tier: "jev", answered: 4, accuracy: 0.75 }], sweep: [row], recommended: row, failures: [{ tier: "llm", error: "Synthetic outage" }] };
    const normal = formatCalibration(report);
    expect(stripVTControlCharacters(formatCalibration(report, { color: true }))).toBe(normal);
    const narrow = formatCalibration(report, { width: 42 });
    expect(narrow).toContain("Strictness 0.15");
    expect(narrow).toContain("Synthetic outage");
    expect(narrow.split("\n").every(line => Array.from(line).length <= 42)).toBe(true);
    expect(normal).toContain("held-out set");
  });
});
