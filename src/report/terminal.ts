import { stripVTControlCharacters } from "node:util";

export type ColorMode = "auto" | "always" | "never";
export type Tone = "normal" | "bold" | "muted" | "cyan" | "pass" | "fail" | "unjudged" | "error";
export type Segment = { text: string; tone?: Tone };
export interface TerminalOptions { color?: boolean; width?: number }
const codes: Record<Tone, string> = { normal: "0", bold: "1", muted: "2", cyan: "36", pass: "32", fail: "31", unjudged: "33", error: "31;1" };

export function colorEnabled(mode: ColorMode, tty: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode !== "auto") return mode === "always";
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return tty && env.TERM !== "dumb";
}

/** Trace text is data: strip terminal controls before adding our own presentation. */
export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export const seg = (text: string, tone: Tone = "normal"): Segment => ({ text, tone });

/** Small JSON/tool-call highlighter; no parsing or evaluation of trace-supplied text. */
export function syntax(text: string): Segment[] {
  const source = clean(text);
  const pattern = /"(?:[^"\\]|\\.)*"|\b(?:true|false|null|\d+(?:\.\d+)?)\b|\b[a-zA-Z_][\w.-]*(?=\()/g;
  const parts: Segment[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index;
    parts.push(seg(source.slice(offset, at), "muted"));
    const token = match[0];
    const key = token.startsWith('"') && /^\s*:/.test(source.slice(at + token.length));
    parts.push(seg(token, key ? "normal" : token.startsWith('"') ? "pass" : /^\d|true|false|null/.test(token) ? "unjudged" : "cyan"));
    offset = at + token.length;
  }
  parts.push(seg(source.slice(offset), "muted"));
  return parts;
}

export class Terminal {
  readonly width: number;
  private readonly color: boolean;
  constructor(opts: TerminalOptions = {}) {
    this.width = Math.max(20, Math.min(120, Math.floor(Number.isFinite(opts.width) ? opts.width! : 100)));
    this.color = opts.color ?? false;
  }
  paint(text: string, tone: Tone = "normal"): string {
    const safe = clean(text);
    return this.color && tone !== "normal" && safe ? `\x1b[${codes[tone]}m${safe}\x1b[0m` : safe;
  }
  rule(): string { return this.paint("─".repeat(this.width), "muted"); }
  line(parts: Segment[], indent = 0): string {
    const pad = " ".repeat(Math.min(indent, this.width - 1));
    const lines: string[] = [];
    let line = pad, columns = pad.length;
    const flush = () => { lines.push(line.trimEnd()); line = pad; columns = pad.length; };
    for (const part of parts) {
      for (const token of clean(part.text).split(/(\n|[^\S\n]+)/).filter(Boolean)) {
        if (token === "\n") { flush(); continue; }
        const chars = Array.from(token);
        if (columns + chars.length > this.width && columns > pad.length) flush();
        if (/^\s+$/.test(token) && columns === pad.length) continue;
        let chunk = "";
        for (const char of chars) {
          if (columns === this.width) { line += this.paint(chunk, part.tone); chunk = ""; flush(); }
          chunk += char; columns++;
        }
        line += this.paint(chunk, part.tone);
      }
    }
    lines.push(line.trimEnd());
    return lines.join("\n");
  }
}
