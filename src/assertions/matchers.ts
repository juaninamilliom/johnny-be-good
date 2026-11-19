import { z } from "zod";

/**
 * A value matcher. A bare string, number, boolean or null is shorthand for `equals`.
 * An object with several keys must satisfy all of them.
 */
export const MatcherObjectSchema = z
  .object({
    equals: z.unknown().optional(),
    contains: z.string().optional(),
    notContains: z.string().optional(),
    regex: z.string().optional(),
    oneOf: z.array(z.unknown()).optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict();

export const MatcherSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), MatcherObjectSchema]);
export type Matcher = z.infer<typeof MatcherSchema>;

export interface MatchOutcome {
  ok: boolean;
  why?: string;
}

export function match(value: unknown, matcher: Matcher): MatchOutcome {
  if (matcher === null || typeof matcher !== "object") return equalsOutcome(value, matcher);
  const m = matcher;
  if (m.exists !== undefined && (value !== undefined) !== m.exists) {
    return { ok: false, why: m.exists ? "is missing" : `exists (${preview(value)})` };
  }
  if ("equals" in m && m.equals !== undefined) {
    const r = equalsOutcome(value, m.equals);
    if (!r.ok) return r;
  }
  const text = typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value);
  if (m.contains !== undefined && !(text ?? "").includes(m.contains)) return { ok: false, why: `does not contain ${JSON.stringify(m.contains)}` };
  if (m.notContains !== undefined && (text ?? "").includes(m.notContains)) return { ok: false, why: `contains ${JSON.stringify(m.notContains)}` };
  if (m.regex !== undefined && !new RegExp(m.regex).test(text ?? "")) return { ok: false, why: `does not match /${m.regex}/` };
  if (m.oneOf !== undefined && !m.oneOf.some((o) => deepEqual(value, o))) return { ok: false, why: `${preview(value)} is not one of ${JSON.stringify(m.oneOf)}` };
  for (const [op, bound] of [["gt", m.gt], ["gte", m.gte], ["lt", m.lt], ["lte", m.lte]] as const) {
    if (bound === undefined) continue;
    if (typeof value !== "number") return { ok: false, why: `${preview(value)} is not a number` };
    const ok = op === "gt" ? value > bound : op === "gte" ? value >= bound : op === "lt" ? value < bound : value <= bound;
    if (!ok) return { ok: false, why: `${value} is not ${op} ${bound}` };
  }
  return { ok: true };
}

/** Reads a dot path (`a.b.0.c`) from a value. An empty path returns the value. */
export function getPath(value: unknown, path: string, ownOnly = false): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (ownOnly && !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function preview(v: unknown, max = 60): string {
  const s = v === undefined ? "undefined" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function equalsOutcome(value: unknown, expected: unknown): MatchOutcome {
  return deepEqual(value, expected) ? { ok: true } : { ok: false, why: `${preview(value)} does not equal ${preview(expected)}` };
}
