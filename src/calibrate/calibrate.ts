import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadTrace } from "../importers/index.js";
import { RubricSchema, type Rubric } from "../suite.js";
import type { Trace } from "../trace/schema.js";
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
  const failures: Array<{ tier: string; error: string }> = [];
  const obs: Observation[] = [];
  for (const item of items) {
    const asked = rubrics.filter((r) => r.id in item.labels);
    if (!asked.length) continue;
    const answers = new Map<string, Map<string, Verdict>>();
    for (const j of judges) {
      try {
        const res = await j.judge(item.trace, asked);
        answers.set(j.tier, new Map(res.verdicts.map((v) => [v.rubricId, v])));
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
          if (f && passes(o.rubric, f.value) === o.label) cascadeRight++;
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
  // The cheapest setting whose accuracy is within one point of the best one.
  const best = Math.max(0, ...sweep.map((r) => r.cascadeAccuracy));
  const recommended = sweep.filter((r) => r.cascadeAccuracy >= best - 0.01).sort((a, b) => a.escalationRate - b.escalationRate)[0];
  return { questions: obs.length, tiers, sweep, ...(recommended ? { recommended } : {}), failures };
}

export function formatCalibration(r: CalibrationReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
  const out = [`calibration · ${r.questions} labeled questions`, ""];
  for (const t of r.tiers) out.push(`${t.tier.padEnd(28)} answered ${String(t.answered).padStart(4)} · agrees with labels ${pct(t.accuracy)}`);
  if (r.sweep.length) {
    out.push("", "strictness  jev decides  jev accuracy  cascade accuracy  escalated");
    for (const s of r.sweep) {
      out.push(`${s.strictness.toFixed(2).padStart(10)}  ${String(s.jevDecided).padStart(11)}  ${pct(s.jevDecidedAccuracy).padStart(12)}  ${pct(s.cascadeAccuracy).padStart(16)}  ${pct(s.escalationRate).padStart(9)}`);
    }
    if (r.recommended) {
      const s = r.recommended.strictness;
      out.push("", `recommended: strictness ${s.toFixed(2)} → jev: { minConfidence: ${(0.5 + s).toFixed(2)}, unsureBand: [${(0.5 - s).toFixed(2)}, ${(0.5 + s).toFixed(2)}] }`);
    }
  }
  for (const f of r.failures) out.push(`! ${f.tier} failed: ${f.error}`);
  return out.join("\n");
}
