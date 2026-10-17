// OKX Agent Trade Kit (okx CLI) çağrıları. Tüm çağrılar runOkx'ten geçer.
// Windows'ta `okx` bir .cmd kısayolu olduğundan paketin JS giriş dosyası
// doğrudan Node ile, shell OLMADAN çalıştırılır.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log, errMsg, isMain } from "./util.js";
import { SECRET_ENV_NAMES } from "./config.js";

export interface OkxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  data?: unknown;
  error?: string;
  durationMs: number;
}

const OKX_PACKAGE = path.join("@okx_ai", "okx-trade-cli");
const SAFE_ARG = /^[A-Za-z0-9._:\-,]+$/;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Argüman beyaz listesi (kural 1 ve 4): yalnızca güvenli karakterler, profil
 * seçimi yok, "live" içeren hiçbir argüman yok. Uymayan dizi reddedilir.
 */
export function validateOkxArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0) throw new Error("okx argümanları boş veya dizi değil");
  for (const a of args) {
    if (typeof a !== "string" || a.length === 0 || a.length > 64) throw new Error(`geçersiz okx argümanı: ${String(a)}`);
    if (!SAFE_ARG.test(a)) throw new Error(`okx argümanında izinsiz karakter: "${a}"`);
    if (a.toLowerCase().includes("live")) throw new Error(`okx argümanı reddedildi (yasaklı kelime): "${a}"`);
    if (a === "--profile") throw new Error("okx profil seçimi kullanılmaz; demo yalnızca --demo bayrağıyla seçilir");
  }
  return args as string[];
}

/** --json bayrağını global bayraklardan sonra, modül adından önce ekler. */
function withJson(args: string[]): string[] {
  if (args.includes("--json")) return args;
  const out = [...args];
  let i = 0;
  while (i < out.length && out[i] === "--demo") i++;
  out.splice(i, 0, "--json");
  return out;
}

let cachedEntry: string | null | undefined;

/** npm global kökünde okx-trade-cli paketinin bin giriş dosyasını bulur. */
export function resolveOkxEntry(): string | null {
  if (cachedEntry !== undefined) return cachedEntry;
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  try {
    const r = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
    if (r) roots.push(r);
  } catch {
    // npm bulunamadıysa diğer adaylarla devam
  }
  for (const root of roots) {
    try {
      const pkgDir = path.join(root, OKX_PACKAGE);
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.okx;
      if (typeof bin !== "string") continue;
      const entry = path.join(pkgDir, bin);
      if (fs.existsSync(entry)) return (cachedEntry = entry);
    } catch {
      // sonraki aday
    }
  }
  return (cachedEntry = null);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV_NAMES) delete env[k]; // sırlar alt sürece aktarılmaz
  return env;
}

function parseJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** okx CLI'yi çalıştırır. Asla fırlatmaz; hata durumunda ok=false döner. */
export async function runOkx(args: string[], opts: { timeoutMs?: number } = {}): Promise<OkxResult> {
  const started = Date.now();
  let safeArgs: string[];
  try {
    safeArgs = withJson(validateOkxArgs(args));
  } catch (e) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: errMsg(e), durationMs: 0 };
  }

  const entry = resolveOkxEntry();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<OkxResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: Omit<OkxResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };

    // Tercih edilen yol: shell yok. Giriş dosyası bulunamazsa son çare shell:true
    // (argümanlar yukarıda beyaz listeden geçtiği için güvenli).
    const child = entry
      ? spawn(process.execPath, [entry, ...safeArgs], { shell: false, windowsHide: true, env: childEnv() })
      : spawn("okx", safeArgs, { shell: true, windowsHide: true, env: childEnv() });

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, exitCode: null, stdout, stderr, error: `okx zaman aşımı (${timeoutMs} ms)` });
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ ok: false, exitCode: null, stdout, stderr, error: `okx başlatılamadı: ${errMsg(e)}` }));
    child.on("close", (code) => {
      const data = parseJson(stdout);
      if (code !== 0) {
        finish({ ok: false, exitCode: code, stdout, stderr, data, error: `okx çıkış kodu ${code}: ${stderr.trim().slice(0, 300)}` });
      } else if (data === undefined) {
        finish({ ok: false, exitCode: code, stdout, stderr, error: "okx çıktısı geçerli JSON değil" });
      } else {
        finish({ ok: true, exitCode: code, stdout, stderr, data });
      }
    });
  });
}

if (isMain(import.meta.url)) {
  const entry = resolveOkxEntry();
  log.stage("OKX", entry ? `Giriş dosyası: ${entry} (shell yok)` : "Giriş dosyası bulunamadı, shell:true yedeği kullanılacak");
  const r = await runOkx(["market", "ticker", "BTC-USDT"]);
  if (r.ok && Array.isArray(r.data)) {
    const t = r.data[0] as { instId: string; last: string };
    log.ok("OKX", `${t.instId} son fiyat: ${t.last} (${r.durationMs} ms)`);
  } else {
    log.error("OKX", `Piyasa çağrısı başarısız: ${r.error}`);
  }
}
