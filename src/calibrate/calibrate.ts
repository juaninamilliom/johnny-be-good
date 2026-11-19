import { Terminal, seg, type TerminalOptions } from "../report/terminal.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadTrace } from "../importers/index.js";
import { RubricSchema, type Rubric } from "../suite.js";
import { TraceSchema, type Trace } from "../trace/schema.js";
import { passes, type Judge, type Verdict } from "../judges/types.js";

/**
 * Human labels: for each trace, whether each rubric question should pass. The point is to
 * measure the judges, so the labels come from a person reading the traces.
 */
export const LabelsSchema = z
  .object({
    rubrics: z.array(RubricSchema).min(1),
    items: z.array(z.object({ trace: z.string(), labels: z.record(z.string(), z.boolean()) }).strict()).min(1),
  })
  .strict();
export type Labels = z.infer<typeof LabelsSchema>;

export interface LabeledItem {
  trace: Trace;
  labels: Record<string, boolean>;
}

/** One rubric answer per tier for one labeled item. */
interface Observation {
  rubric: Rubric;
  label: boolean;
  byTier: Map<string, Verdict | undefined>;
}

export interface TierStats {
  tier: string;
  answered: number;
  accuracy: number;
}

export interface SweepRow {
  /** 0 trusts every Jev answer; higher values escalate more. noul band = 0.5 ± s, min confidence = 0.5 + s. */
  strictness: number;
  jevDecided: number;
  jevDecidedAccuracy: number;
  cascadeAccuracy: number;
  escalationRate: number;
}

export interface CalibrationReport {
  /** Sweep and recommendation are measured on the tuning labels, not held-out data. */
  evaluation?: "in-sample";
  questions: number;
  tiers: TierStats[];
  sweep: SweepRow[];
  recommended?: SweepRow;
  failures: Array<{ tier: string; error: string }>;
}

export async function loadLabels(path: string): Promise<{ rubrics: Rubric[]; items: LabeledItem[] }> {
  const text = await readFile(path, "utf8");
  const parsed = LabelsSchema.parse(path.endsWith(".json") ? JSON.parse(text) : parseYaml(text));
  const ids = new Set(parsed.rubrics.map((r) => r.id));
  const base = dirname(path);
  const items = await Promise.all(
    parsed.items.map(async (it) => {
      for (const id of Object.keys(it.labels)) if (!ids.has(id)) throw new Error(`${it.trace}: label for unknown rubric "${id}"`);
      return { trace: await loadTrace(resolve(base, it.trace)), labels: it.labels };
    }),
  );
  return { rubrics: parsed.rubrics, items };
}

/**
 * Asks every tier every labeled question (no cascade), then replays the cascade offline at
 * several strictness settings. The tier named `jev` is the one being thresholded; the last
 * tier is the fallback.
 */
export async function calibrate(items: LabeledItem[], rubrics: Rubric[], judges: Judge[]): Promise<CalibrationReport> {
  rubrics = rubrics.map(rubric => RubricSchema.parse(rubric));
  validateCalibrationData(items, rubrics, judges, "calibration");
  const failures: Array<{ tier: string; error: string }> = [];
  const obs: Observation[] = [];
  for (const item of items) {
    const asked = rubrics.filter((r) => Object.hasOwn(item.labels, r.id));
    if (!asked.length) continue;
    const answers = new Map<string, Map<string, Verdict>>();
    for (const j of judges) {
      try {
        const res = await j.judge(item.trace, asked);
        const checked = validatedVerdicts(res.verdicts, asked, j.tier);
        answers.set(j.tier, checked.answers);
        failures.push(...checked.failures);
      } catch (err) {
        failures.push({ tier: j.tier, error: err instanceof Error ? err.message : String(err) });
        answers.set(j.tier, new Map());
      }
    }
    for (const r of asked) obs.push({ rubric: r, label: item.labels[r.id]!, byTier: new Map(judges.map((j) => [j.tier, answers.get(j.tier)!.get(r.id)])) });
  }

  const tiers: TierStats[] = judges.map((j) => {
    const answered = obs.filter((o) => o.byTier.get(j.tier));
    const right = answered.filter((o) => passes(o.rubric, o.byTier.get(j.tier)!.value) === o.label).length;
    return { tier: j.tier, answered: answered.length, accuracy: answered.length ? right / answered.length : 0 };
  });

  const jevTier = judges.find((j) => j.tier === "jev")?.tier;
  const fallback = judges.filter((j) => j.tier !== "jev").at(-1)?.tier;
  const sweep: SweepRow[] = [];
  if (jevTier) {
    for (let k = 0; k <= 9; k++) {
      const s = Math.round(k * 0.05 * 100) / 100;
      let jevDecided = 0;
      let jevRight = 0;
      let cascadeRight = 0;
      let escalated = 0;
      for (const o of obs) {
        const v = o.byTier.get(jevTier);
        const confident = v !== undefined && (o.rubric.kind === "noul" ? Math.abs((v.value as number) - 0.5) > s : (v.confidence ?? 0) >= 0.5 + s);
        if (confident) {
          jevDecided++;
          const ok = passes(o.rubric, v.value) === o.label;
          if (ok) jevRight++;
          if (ok) cascadeRight++;
        } else {
          escalated++;
          const f = fallback ? o.byTier.get(fallback) : undefined;
          if (f?.decided && passes(o.rubric, f.value) === o.label) cascadeRight++;
        }
      }
      sweep.push({
        strictness: s,
        jevDecided,
        jevDecidedAccuracy: jevDecided ? jevRight / jevDecided : 0,
        cascadeAccuracy: obs.length ? cascadeRight / obs.length : 0,
        escalationRate: obs.length ? escalated / obs.length : 0,
      });
    }
  }
  // Lowest-escalation setting within one percentage point of the best tuning agreement; this is not a measured cost optimum.
  const best = Math.max(0, ...sweep.map((r) => r.cascadeAccuracy));
  const recommended = sweep.filter((r) => r.cascadeAccuracy >= best - 0.01).sort((a, b) => a.escalationRate - b.escalationRate)[0];
  return { evaluation: "in-sample", questions: obs.length, tiers, sweep, ...(recommended ? { recommended } : {}), failures };
}

export interface ConfusionCounts {
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
}
export interface HeldOutFailure { traceId: string; tier: string; kind: "invalid_answer" | "judge_error"; error: string }
export interface HeldOutDisagreement { traceId: string; rubricId: string; expected: boolean; predicted: boolean; decidedBy: string }
export interface HeldOutCalibrationReport {
  kind: "held-out";
  tuning: CalibrationReport;
  /** Frozen before any held-out judge is called; absent without a Jev tier. */
  selectedStrictness?: number;
  validation: {
    items: number;
    questions: number;
    answered: number;
    unjudged: number;
    coverage: number;
    correct: number;
    /** Human-label agreement among answered labels only; null if none were judged. */
    agreement: number | null;
    /** Correct / all labels, so missing decisions are not silently excluded. */
    totalAgreement: number;
    confusion: ConfusionCounts;
    disagreements: HeldOutDisagreement[];
    failures: HeldOutFailure[];
    uncertainty: {
      unit: "trace";
      method: "wilson";
      confidenceLevel: 0.95;
      successes: number;
      trials: number;
      lower: number;
      upper: number;
      note: string;
    };
  };
}

/** Freeze a tuning-selected policy, then validate once on disjoint labeled traces. */
export async function calibrateHeldOut(
  tuningItems: LabeledItem[], heldOutItems: LabeledItem[], rubrics: Rubric[], judges: Judge[],
): Promise<HeldOutCalibrationReport> {
  rubrics = rubrics.map(rubric => RubricSchema.parse(rubric));
  validateSplit(tuningItems, heldOutItems, rubrics, judges);
  const tuning = await calibrate(tuningItems, rubrics, judges);
  if (judges.some(j => j.tier === "jev") && !tuning.tiers.find(tier => tier.tier === "jev")?.answered)
    throw new Error("Tuning produced no valid Jev answers; held-out evaluation was not run");
  const selectedStrictness = tuning.recommended?.strictness;
  if (judges.some(j => j.tier === "jev") && selectedStrictness === undefined)
    throw new Error("Tuning produced no threshold; held-out evaluation was not run");
  const validation: HeldOutCalibrationReport["validation"] = {
    items: heldOutItems.length, questions: 0, answered: 0, unjudged: 0, coverage: 0,
    correct: 0, agreement: null, totalAgreement: 0,
    confusion: { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 },
    disagreements: [], failures: [],
    uncertainty: { unit: "trace", method: "wilson", confidenceLevel: 0.95,
      successes: 0, trials: heldOutItems.length, lower: 0, upper: 1,
      note: "Empirical trace-level all-label agreement interval, counting unanswered labels as unsuccessful. Assumes independent representative traces; not a calibration or generalization guarantee." },
  };
  const jev = judges.find(j => j.tier === "jev");
  const fallback = judges.filter(j => j.tier !== "jev").at(-1);
  for (const item of heldOutItems) {
    const asked = rubrics.filter(r => Object.hasOwn(item.labels, r.id));
    const answers = new Map<string, Map<string, Verdict>>();
    for (const judge of judges) {
      try {
        const response = await judge.judge(item.trace, asked);
        const checked = validatedVerdicts(response.verdicts, asked, judge.tier);
        answers.set(judge.tier, checked.answers);
        validation.failures.push(...checked.failures.map(f => ({ ...f, traceId: item.trace.id, kind: "invalid_answer" as const })));
      } catch (error) {
        answers.set(judge.tier, new Map());
        validation.failures.push({ traceId: item.trace.id, tier: judge.tier, kind: "judge_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    let itemCorrect = true;
    for (const rubric of asked) {
      validation.questions++;
      const cheap = jev ? answers.get(jev.tier)?.get(rubric.id) : undefined;
      const useCheap = cheap !== undefined && confidentAt(rubric, cheap, selectedStrictness!);
      const final = useCheap ? cheap : fallback ? answers.get(fallback.tier)?.get(rubric.id) : undefined;
      // The frozen threshold replaces Jev's configured decided flag; fallback abstention remains abstention.
      if (!final || (!useCheap && !final.decided)) {
        validation.unjudged++; itemCorrect = false; continue;
      }
      const predicted = passes(rubric, final.value), expected = item.labels[rubric.id]!;
      validation.answered++;
      const key = expected ? predicted ? "truePositive" : "falseNegative" : predicted ? "falsePositive" : "trueNegative";
      validation.confusion[key]++;
      if (predicted === expected) validation.correct++;
      else {
        itemCorrect = false;
        validation.disagreements.push({ traceId: item.trace.id, rubricId: rubric.id, expected, predicted, decidedBy: useCheap ? jev!.tier : fallback!.tier });
      }
    }
    if (itemCorrect) validation.uncertainty.successes++;
  }
  validation.coverage = validation.answered / validation.questions;
  validation.agreement = validation.answered ? validation.correct / validation.answered : null;
  validation.totalAgreement = validation.correct / validation.questions;
  Object.assign(validation.uncertainty, wilson(validation.uncertainty.successes, validation.uncertainty.trials));
  return { kind: "held-out", tuning, ...(selectedStrictness === undefined ? {} : { selectedStrictness }), validation };
}

function confidentAt(rubric: Rubric, verdict: Verdict, strictness: number): boolean {
  return rubric.kind === "noul" ? Math.abs((verdict.value as number) - 0.5) > strictness : (verdict.confidence ?? 0) >= 0.5 + strictness;
}

function validatedVerdicts(verdicts: Verdict[], asked: Rubric[], tier: string): { answers: Map<string, Verdict>; failures: Array<{ tier: string; error: string }> } {
  const answers = new Map<string, Verdict>(), failures: Array<{ tier: string; error: string }> = [];
  if (!Array.isArray(verdicts)) return { answers, failures: [{ tier, error: "Invalid judge response: verdicts must be an array" }] };
  const counts = new Map<string, number>();
  for (const v of verdicts) if (v && typeof v.rubricId === "string") counts.set(v.rubricId, (counts.get(v.rubricId) ?? 0) + 1);
  for (const rubric of asked) {
    const verdict = verdicts.find(v => v?.rubricId === rubric.id);
    const value = verdict?.value;
    const numberValid = typeof value === "number" && Number.isFinite(value);
    const valueValid = rubric.kind === "choice" ? typeof value === "string" && Object.hasOwn(rubric.criteria, value)
      : numberValid && value >= 0 && value <= (rubric.kind === "noul" ? 1 : rubric.criteria.length - 1);
    const confidenceValid = verdict?.confidence === undefined || (typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence) && verdict.confidence >= 0 && verdict.confidence <= 1);
    if (!verdict || counts.get(rubric.id) !== 1 || !valueValid || !confidenceValid || typeof verdict.decided !== "boolean" || verdict.tier !== tier) {
      failures.push({ tier, error: `Invalid or missing judge answer for rubric "${rubric.id}"` });
    } else answers.set(rubric.id, verdict);
  }
  return { answers, failures };
}

/** This threshold sweep models one Jev tier followed by at most one fallback. */
function validateCalibrationPolicy(judges: Judge[]): void {
  if (new Set(judges.map(judge => judge.tier)).size !== judges.length)
    throw new Error("Calibration requires uniquely named judge tiers");
  if (judges.findIndex(judge => judge.tier === "jev") > 0)
    throw new Error("Calibration requires Jev to be the first judge tier");
  if (judges.filter(judge => judge.tier !== "jev").length > 1)
    throw new Error("Calibration supports at most one non-Jev fallback tier; multi-stage cascades require separate policy validation");
}

function validateCalibrationData(items: LabeledItem[], rubrics: Rubric[], judges: Judge[], name: string): void {
  if (!items.length) throw new Error(`${name}: at least one labeled trace is required`);
  if (!rubrics.length) throw new Error("At least one rubric is required");
  const ids = new Set(rubrics.map(rubric => rubric.id));
  if (rubrics.some(rubric => !rubric.id.trim()) || ids.size !== rubrics.length) throw new Error("Duplicate rubric IDs or empty rubric IDs are not allowed");
  if (!judges.length || judges.some(judge => typeof judge.tier !== "string" || !judge.tier.trim()) || new Set(judges.map(judge => judge.tier)).size !== judges.length)
    throw new Error("At least one uniquely named judge tier is required");
  validateCalibrationPolicy(judges);
  for (const item of items) {
    TraceSchema.parse(item.trace);
    if (!item.trace.id.trim()) throw new Error(`${name}: trace IDs must be nonempty`);
    if (!item.labels || typeof item.labels !== "object" || Array.isArray(item.labels)) throw new Error(`${name}: labels must be an object`);
    const labels = Object.keys(item.labels);
    if (!labels.length) throw new Error(`${name}: each trace requires at least one human label`);
    for (const id of labels) if (!ids.has(id) || typeof item.labels[id] !== "boolean") throw new Error(`${name}: invalid label for rubric "${id}"`);
  }
}

function validateSplit(tuning: LabeledItem[], heldOut: LabeledItem[], rubrics: Rubric[], judges: Judge[]): void {
  if (!tuning.length || !heldOut.length) throw new Error("Tuning and held-out sets must both contain labeled traces");
  validateCalibrationData(tuning, rubrics, judges, "tuning");
  validateCalibrationData(heldOut, rubrics, judges, "held-out");
  const seenIds = new Set<string>(), seenContent = new Set<string>();
  for (const items of [tuning, heldOut]) {
    for (const item of items) {
      if (!item.trace.id || seenIds.has(item.trace.id)) throw new Error(`Duplicate or overlapping trace ID "${item.trace.id}"`);
      const content = traceFingerprint(item.trace);
      if (seenContent.has(content)) throw new Error("Duplicate or overlapping trace content; metadata/ID changes do not make a new held-out example");
      seenIds.add(item.trace.id); seenContent.add(content);
    }
  }
}

function traceFingerprint(trace: Trace): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  // Identifiers and operational metadata cannot make duplicated behavior a held-out example.
  const content = { task: trace.task, final: trace.final, steps: trace.steps.map(step => step.type === "tool_call"
    ? { type: step.type, name: step.name, args: step.args, result: step.result } : step) };
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex");
}

function wilson(successes: number, trials: number): { lower: number; upper: number } {
  const z = 1.959963984540054, z2 = z * z, p = successes / trials, denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

export function formatHeldOutCalibration(report: HeldOutCalibrationReport, opts: TerminalOptions = {}): string {
  const t = new Terminal(opts), v = report.validation;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const out = [formatCalibration(report.tuning, opts), t.rule(), "", t.line([seg("HELD-OUT VALIDATION", "bold")]),
    t.line([seg(`Frozen threshold: ${report.selectedStrictness === undefined ? "no Jev tier" : report.selectedStrictness.toFixed(2)}`, "cyan")]),
    t.line([seg(`${v.items} traces · ${v.questions} labels · ${v.answered} answered · ${v.unjudged} unjudged`, "muted")]),
    t.line([seg(`Coverage ${pct(v.coverage)} · agreement among answered ${v.agreement === null ? "not measured" : pct(v.agreement)} · correct/all labels ${pct(v.totalAgreement)}`, "cyan")]),
    t.line([seg(`TP ${v.confusion.truePositive} · TN ${v.confusion.trueNegative} · FP ${v.confusion.falsePositive} · FN ${v.confusion.falseNegative}`, "muted")]),
    t.line([seg(`All-label-agreeing traces: ${v.uncertainty.successes}/${v.uncertainty.trials}; 95% Wilson interval ${pct(v.uncertainty.lower)}–${pct(v.uncertainty.upper)}`, "muted")]),
    t.line([seg(v.uncertainty.note, "muted")])];
  for (const d of v.disagreements) out.push(t.line([seg(`Disagreement ${d.traceId}/${d.rubricId}: human ${d.expected ? "pass" : "fail"}, judge ${d.predicted ? "pass" : "fail"} (${d.decidedBy})`, "fail")]));
  for (const f of v.failures) out.push(t.line([seg(`Judge ${f.kind} ${f.traceId}/${f.tier}: ${f.error}`, "error")]));
  out.push("", t.line([seg("Do not retune on this held-out result; use a new validation set after policy changes.", "unjudged")]), "");
  return out.join("\n");
}

export function formatCalibration(r: CalibrationReport, opts: TerminalOptions = {}): string {
  const t = new Terminal({ ...opts, width: opts.width ?? 120 });
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const out = ["", t.line([seg("Johnny Be Good", "cyan"), seg("  /  calibration", "bold")]), t.line([seg(`${r.questions} human-labeled questions · IN-SAMPLE threshold tuning`, "muted")]), "", t.rule()];
  for (const tier of r.tiers) out.push("", t.line([seg(tier.tier, "cyan"), seg(`  ${tier.answered} answered · ${pct(tier.accuracy)} agreement with labels`, "muted")], 2));
  if (r.sweep.length) {
    out.push("", t.line([seg("THRESHOLD SWEEP", "bold")]));
    if (t.width >= 90) {
      out.push(t.line([seg("strictness  jev decides  jev accuracy  cascade accuracy  escalated", "muted")]));
      for (const row of r.sweep) out.push(t.line([seg(`${row.strictness.toFixed(2).padStart(10)}  ${String(row.jevDecided).padStart(11)}  ${pct(row.jevDecidedAccuracy).padStart(12)}  ${pct(row.cascadeAccuracy).padStart(16)}  ${pct(row.escalationRate).padStart(9)}`, row === r.recommended ? "cyan" : "normal")]));
    } else {
      for (const row of r.sweep) out.push("", t.line([seg(`Strictness ${row.strictness.toFixed(2)}`, row === r.recommended ? "cyan" : "bold")], 2), t.line([seg(`Jev: ${row.jevDecided} decided · ${pct(row.jevDecidedAccuracy)} agreement`, "muted")], 4), t.line([seg(`Cascade: ${pct(row.cascadeAccuracy)} · escalated: ${pct(row.escalationRate)}`, "muted")], 4));
    }
    if (r.recommended) {
      const s = r.recommended.strictness;
      out.push("", t.line([seg(`recommended: strictness ${s.toFixed(2)} → jev: { minConfidence: ${(0.5 + s).toFixed(2)}, unsureBand: [${(0.5 - s).toFixed(2)}, ${(0.5 + s).toFixed(2)}] }`, "cyan")]));
      out.push(t.line([seg("Threshold selected on these labels; verify on a separate held-out set.", "muted")]));
    }
  }
  for (const f of r.failures) out.push("", t.line([seg(`! ${f.tier} failed: ${f.error}`, "error")]));
  out.push("");
  return out.join("\n");
}
