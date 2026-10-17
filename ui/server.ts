// Canlı arayüz sunucusu: sistemi (src/main.ts) alt süreç olarak çalıştırır, loglarını
// tarayıcıya akıtır (SSE), raporları ve mum verisini sunar. Backend'e dokunmaz; yalnızca okur.
//   npx tsx ui/server.ts   →  http://127.0.0.1:4173
// Güvenlik: yalnızca 127.0.0.1'e bağlanır, senaryolar sabit argüman listesidir (tarayıcıdan
// serbest argüman gelmez), POST istekleri özel başlık ister (başka sitelerden tetiklenemez).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import { config, KILL_FILE } from "../src/config.js";
import { ROOT, log } from "../src/util.js";
import { loadRecording } from "../src/data/replay.js";
import { injectScenario, isScenario } from "../src/data/inject.js";
import { computeSignals } from "../src/stats/robustZ.js";
import { loadDeployment, SNOWTRACE_ADDRESS } from "../src/chain/deploy.js";
import type { Candle } from "../src/data/types.js";

const PORT = Number(process.env.UI_PORT ?? 4173);
const HOST = "127.0.0.1";
const REPORTS = path.join(ROOT, "reports");
const RECORDINGS = path.join(ROOT, "recordings");
const DEMO_FILE = "recordings/BTC-USDT_demo.jsonl";
const ENV_FILE = path.join(ROOT, ".env");

// --- Senaryolar: sabit argümanlar ---
interface Scenario {
  title: string;
  args: (symbol: string) => string[];
  replay?: { file: string; inject?: string };
}
const SCENARIOS: Record<string, Scenario> = {
  drop: { title: "Senaryo 1 · Düşüş, iki agent örtüşüyor", args: () => ["--replay", DEMO_FILE, "--inject", "drop", "--cached"], replay: { file: DEMO_FILE, inject: "drop" } },
  diverge: { title: "Senaryo 2 · Ayrışma → uyuşmazlık turu", args: () => ["--replay", DEMO_FILE, "--inject", "whipsaw", "--cached"], replay: { file: DEMO_FILE, inject: "whipsaw" } },
  kill: { title: "Senaryo 3 · Kill switch açık", args: () => ["--replay", DEMO_FILE, "--inject", "drop", "--cached", "--kill"], replay: { file: DEMO_FILE, inject: "drop" } },
  "drop-live": { title: "Canlı LLM · enjekte düşüş", args: () => ["--replay", DEMO_FILE, "--inject", "drop"], replay: { file: DEMO_FILE, inject: "drop" } },
  live: { title: "Anlık piyasa · tek tur", args: (s) => ["--symbol", s] },
  watch: { title: "Sürekli izleme (her dakika)", args: (s) => ["--watch", "--symbol", s] },
};

// --- .env her istekte taze okunur (sunucu açıkken .env değişirse alt süreç de yenisini görsün) ---
function envFile(): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(ENV_FILE, "utf8"));
  } catch {
    return {};
  }
}
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(envFile())) delete env[k]; // alt süreç .env'i kendisi okur
  env.FORCE_COLOR = "1";
  return env;
}
function killState(): { on: boolean; reason: string } {
  if ((envFile().KILL_SWITCH ?? "0").trim() === "1") return { on: true, reason: "KILL_SWITCH=1 (.env)" };
  if (fs.existsSync(KILL_FILE)) return { on: true, reason: "KILL dosyası" };
  return { on: false, reason: "kapalı" };
}

function status() {
  const e = envFile();
  const dep = loadDeployment();
  return {
    running: current ? { scenario: current.key, title: SCENARIOS[current.key].title, startedAt: current.startedAt } : null,
    okxAccount: (e.OKX_ACCOUNT ?? config.okxAccount).trim().toLowerCase(),
    dryRun: (e.DRY_RUN ?? "1").trim() !== "0",
    kill: killState(),
    sealProvider: (e.SEAL_PROVIDER ?? config.sealProvider).trim().toLowerCase(),
    contract: dep ? { address: dep.address, url: `${SNOWTRACE_ADDRESS}${dep.address}`, codeUrl: `${SNOWTRACE_ADDRESS}${dep.address}/contract/43113/code`, deployTx: dep.txHash, compiler: dep.compiler } : null,
    atlas: { provider: config.atlas.provider, model: config.atlas.model },
    argus: { provider: config.argus.provider, model: config.argus.model },
    limits: {
      totalBudgetUsdt: config.totalBudgetUsdt,
      maxPerTradeUsdt: config.maxPerTradeUsdt,
      maxDailyLossUsdt: config.maxDailyLossUsdt,
      reduceFraction: config.reduceFraction,
      minConfidence: config.minConfidence,
      allowedPairs: config.allowedPairs,
    },
    thresholds: {
      window: config.statsWindow,
      triggerPriceZ: config.triggerPriceZ,
      triggerVolumeZ: config.triggerVolumeZ,
      confirmPriceZ: config.confirmPriceZ,
      confirmVolumeZ: config.confirmVolumeZ,
    },
    watch: { cooldownMin: config.watchCooldownMin, maxRounds: config.watchMaxRounds },
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.title])),
  };
}

// --- Mum verisi (grafik için) ---
function insideRecordings(rel: string): string | null {
  const abs = path.resolve(ROOT, rel);
  return abs.startsWith(RECORDINGS + path.sep) && abs.endsWith(".jsonl") && fs.existsSync(abs) ? abs : null;
}
function chartData(file: string, inject?: string) {
  let candles: Candle[] = loadRecording(file).candles;
  if (inject && isScenario(inject)) candles = injectScenario(candles, inject);
  const i = candles.length - 1;
  const n = config.statsWindow;
  const s = i >= n ? computeSignals(candles, i) : null;
  return {
    file: path.relative(ROOT, file),
    signals: s,
    candles: candles.slice(-n).map((c) => ({ id: c.record_id, t: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, v: c.vol, inj: !!c.injected })),
  };
}

// --- SSE ---
const clients = new Set<http.ServerResponse>();
const backlog: string[] = []; // sayfa yenilenirse devam eden koşunun olayları kaybolmasın
function send(event: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  backlog.push(data);
  if (backlog.length > 2000) backlog.shift();
  for (const c of clients) c.write(data);
}

const LEVEL_BY_COLOR: Record<string, string> = { "36": "stage", "34": "info", "32": "ok", "33": "warn", "31": "error", "35": "agent" };
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let current: { key: string; child: ChildProcess; startedAt: string; recording?: string; inject?: string } | null = null;

function handleLine(raw: string): void {
  const color = /^\x1b\[2m[^\x1b]*\x1b\[0m \x1b\[(\d+)m\[/.exec(raw)?.[1];
  const line = stripAnsi(raw).trimEnd();
  if (!line) return;
  const m = /^(\d\d:\d\d:\d\d) \[([^\]]+)\] (.*)$/.exec(line);
  if (!m) {
    if (/^[╔╚]/.test(line)) return;
    send({ type: "banner", text: line.replace(/^║\s*|\s*║$/g, "") });
    // Tur sonu: rapor dosyasını oku ve gönder
    const rep = /Rapor: (reports[\\/][^\s]+)\.html/.exec(line);
    if (rep) {
      const json = path.join(ROOT, `${rep[1]}.json`);
      try {
        send({ type: "report", data: JSON.parse(fs.readFileSync(json, "utf8")) });
      } catch {
        // rapor okunamadı; loglar yine de görünür
      }
    }
    return;
  }
  const [, time, tag, msg] = m;
  send({ type: "line", time, tag, msg, level: (color && LEVEL_BY_COLOR[color]) ?? "info" });
  // Anlık modda kaydedilen mum dosyası → grafik
  const rec = /→ (recordings[\\/][^\s]+\.jsonl)/.exec(msg);
  if (rec && current && (tag === "VERİ" || tag === "İZLEME")) current.recording = rec[1];
  if (current?.recording && ((tag === "VERİ" && rec) || (tag === "İZLEME" && / UTC · /.test(msg) && !/geç kontrol/.test(msg)) || (tag === "İZLEME" && rec))) {
    const abs = insideRecordings(current.recording);
    if (abs) {
      try {
        send({ type: "candles", data: chartData(abs) });
      } catch {
        // grafik verisi alınamadı
      }
    }
  }
}

function start(key: string, symbol: string): { ok: boolean; error?: string } {
  if (current) return { ok: false, error: "zaten çalışan bir koşu var; önce durdurun" };
  const sc = SCENARIOS[key];
  if (!sc) return { ok: false, error: "bilinmeyen senaryo" };
  const sym = symbol.toUpperCase();
  if (!config.allowedPairs.includes(sym)) return { ok: false, error: "izinli olmayan çift" };
  const args = sc.args(sym);
  backlog.length = 0;
  // Tek süreç: tsx CLI ara süreç açar, Windows'ta durdurma yalnızca onu öldürürdü
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "main.ts"), ...args], { cwd: ROOT, env: childEnv(), shell: false, windowsHide: true });
  current = { key, child, startedAt: new Date().toISOString(), inject: sc.replay?.inject };
  send({ type: "start", scenario: key, title: sc.title, command: `npx tsx src/main.ts ${args.join(" ")}`, startedAt: current.startedAt });
  if (sc.replay) {
    const abs = insideRecordings(sc.replay.file);
    if (abs) send({ type: "candles", data: chartData(abs, sc.replay.inject) });
  }
  let buf = "";
  const onData = (d: Buffer) => {
    buf += d.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const p of parts) handleLine(p);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", (code) => {
    if (buf) handleLine(buf);
    send({ type: "exit", code });
    log.info("UI", `koşu bitti (${key}, çıkış ${code})`);
    current = null;
  });
  log.stage("UI", `koşu başladı: ${sc.title}`);
  return { ok: true };
}

// --- Raporlar ---
function listReports() {
  if (!fs.existsSync(REPORTS)) return [];
  return fs
    .readdirSync(REPORTS)
    .filter((f) => f.startsWith("R-") && f.endsWith(".json"))
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(REPORTS, f), "utf8"));
        return {
          file: f,
          round_id: r.round_id,
          symbol: r.symbol,
          created_at: r.created_at,
          level: r.compare?.level,
          action: r.risk?.action,
          exec: r.exec?.status,
          injected: !!(r.trigger?.injected || r.injectedRecordIds?.length),
          cached: !!r.agents?.some((a: { cached?: boolean }) => a.cached),
          dryRun: !!r.exec?.dryRun,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b!.created_at).localeCompare(String(a!.created_at)));
}
function latestEvaluation() {
  if (!fs.existsSync(REPORTS)) return null;
  const files = fs.readdirSync(REPORTS).filter((f) => /^evaluation_\d+\.json$/.test(f));
  files.sort((a, b) => fs.statSync(path.join(REPORTS, b)).mtimeMs - fs.statSync(path.join(REPORTS, a)).mtimeMs);
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(REPORTS, f), "utf8"));
      return { file: f, created_at: e.created_at, mode: e.mode, smallSample: e.smallSample, criteria: e.criteria, byLevel: e.byLevel, windows: e.windows?.length ?? 0 };
    } catch {
      // sonraki dosya
    }
  }
  return null;
}

// --- HTTP ---
function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (req.method === "POST") {
      if (req.headers["x-atlas-argus"] !== "1") return json(res, 403, { ok: false, error: "yasak" });
      const body = await readBody(req);
      if (url.pathname === "/api/run") return json(res, 200, start(String(body.scenario ?? ""), String(body.symbol ?? "BTC-USDT")));
      if (url.pathname === "/api/stop") {
        if (!current) return json(res, 200, { ok: false, error: "çalışan koşu yok" });
        current.child.kill("SIGINT");
        send({ type: "line", time: new Date().toISOString().slice(11, 19), tag: "UI", msg: "durdurma istendi", level: "warn" });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/kill") {
        if (body.on === true) fs.writeFileSync(KILL_FILE, `arayüzden açıldı ${new Date().toISOString()}\n`, "utf8");
        else if (fs.existsSync(KILL_FILE)) fs.unlinkSync(KILL_FILE);
        return json(res, 200, { ok: true, kill: killState() });
      }
      return json(res, 404, { ok: false });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(ROOT, "ui", "index.html")));
    }
    if (url.pathname === "/api/status") return json(res, 200, status());
    if (url.pathname === "/api/reports") return json(res, 200, listReports());
    if (url.pathname === "/api/evaluation") return json(res, 200, latestEvaluation());
    if (url.pathname.startsWith("/api/reports/")) {
      const name = path.basename(decodeURIComponent(url.pathname.slice("/api/reports/".length)));
      const f = path.join(REPORTS, name);
      if (!name.startsWith("R-") || !name.endsWith(".json") || !fs.existsSync(f)) return json(res, 404, { ok: false });
      return json(res, 200, JSON.parse(fs.readFileSync(f, "utf8")));
    }
    if (url.pathname === "/api/demo-candles") {
      const inject = url.searchParams.get("inject") ?? undefined;
      const abs = insideRecordings(DEMO_FILE);
      return json(res, 200, abs ? chartData(abs, inject) : null);
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", running: !!current })}\n\n`);
      if (current) for (const d of backlog) res.write(d);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    json(res, 404, { ok: false });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  log.banner(["ATLAS–ARGUS · Canlı arayüz", `http://${HOST}:${PORT}`, "Durdurmak için Ctrl+C"]);
});
process.on("SIGINT", () => {
  current?.child.kill("SIGINT");
  process.exit(0);
});
