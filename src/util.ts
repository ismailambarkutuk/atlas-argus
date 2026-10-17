// Ortak yardımcılar: proje kökü, okunaklı Türkçe log, zaman aşımı, sır maskeleme.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Dosya doğrudan `npx tsx <dosya>` ile çalıştırıldıysa true (modülün kendi demo girişi için). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(metaUrl)).toLowerCase() === path.resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

// --- Sır maskeleme (kural 6: anahtarlar log'a/rapora yazılmaz) ---
const secrets: string[] = [];
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6 && !secrets.includes(value)) secrets.push(value);
}
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}

// --- Log ---
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(color: string, tag: string, msg: string): void {
  console.log(`${C.dim}${stamp()}${C.reset} ${color}[${tag}]${C.reset} ${redact(msg)}`);
}

export const log = {
  stage: (tag: string, msg: string) => emit(C.cyan, tag, msg),
  info: (tag: string, msg: string) => emit(C.blue, tag, msg),
  ok: (tag: string, msg: string) => emit(C.green, tag, msg),
  warn: (tag: string, msg: string) => emit(C.yellow, tag, msg),
  error: (tag: string, msg: string) => emit(C.red, tag, msg),
  agent: (tag: string, msg: string) => emit(C.magenta, tag, msg),
  banner: (lines: string[]) => {
    const width = Math.max(...lines.map((l) => l.length)) + 4;
    const bar = "═".repeat(width);
    console.log(`${C.bold}╔${bar}╗${C.reset}`);
    for (const l of lines) console.log(`${C.bold}║  ${redact(l).padEnd(width - 2)}║${C.reset}`);
    console.log(`${C.bold}╚${bar}╝${C.reset}`);
  },
};

export function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

/** Söz verilen işlemi en fazla `ms` milisaniye bekler; aşılırsa anlaşılır bir hata fırlatır. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: zaman aşımı (${ms} ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Basit argüman okuyucu: --bayrak veya --anahtar değer */
export function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(a.slice(2), next);
      i++;
    } else {
      flags.add(a.slice(2));
    }
  }
  return { flags, values };
}
