// Değerlendirme: "Uyum yüksek bulgular gerçekten daha isabetli mi?"
// Gerçek tarihsel 1m mumlardan zaman kesitli pencereler: agent'lar yalnızca pencere
// sonuna kadarki veriyi görür. Enjekte veri değerlendirmeye dahil edilmez.
//
// npx tsx src/evaluate.ts [--data recordings/eval_x.jsonl] [--symbol BTC-USDT] [--count 3000]
//                         [--events 10] [--calm 10] [--stats-only] [--cached|--record-agents]
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { ROOT, log, parseArgs, errMsg } from "./util.js";
import { fetchHistory, writeRecording, RECORDINGS_DIR } from "./data/collector.js";
import { loadRecording } from "./data/replay.js";
import { Candle, roundIdFor, windowEnding } from "./data/types.js";
import { computeSignals, minIndex, type Signals } from "./stats/robustZ.js";
import { runAtlas } from "./agents/atlas.js";
import { runArgus } from "./agents/argus.js";
import type { AgentMode } from "./agents/cache.js";
import { compareInitial, LEVEL_TR, type Level } from "./compare.js";

const HORIZONS = [15, 60] as const;
const MAX_H = 60;
const SPACING = 60; // pencereler arası en az mum (örtüşmesin)
const VOL_RATIO_SIGNIFICANT = 1.5;
const MOVE_SIGMAS = 3;
const SMALL_SAMPLE = 10;

interface Outcome {
  horizon: number;
  volRatio: number;
  absMove: number;
  significant: boolean;
}

interface EvalWindow {
  index: number;
  record_id: string;
  iso: string;
  kind: "olay" | "sakin";
  signals: Signals;
  outcomes: Outcome[];
  level?: Level;
  claimedAnomaly?: boolean;
  agreedType?: string;
  notes: string[];
}

function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

function logRets(c: Candle[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k++) out.push(Math.log(c[k].close / c[k - 1].close));
  return out;
}

/** Sonuç ölçütü: sonraki H dakikada oynaklık veya fiyat değişimi pencere öncesi tabana göre anlamlı arttı mı. */
export function outcomeAt(c: Candle[], i: number, h: number, window = config.statsWindow): Outcome {
  // taban: tetik mumundan ÖNCEKİ pencere (mumun kendisi tabanı şişirmesin)
  const base = Math.max(std(logRets(c, i - window, i - 1)), 1e-9);
  const fut = std(logRets(c, i + 1, i + h));
  const volRatio = fut / base;
  const absMove = Math.abs(Math.log(c[i + h].close / c[i].close));
  const significant = volRatio >= VOL_RATIO_SIGNIFICANT || absMove >= MOVE_SIGMAS * base * Math.sqrt(h);
  return { horizon: h, volRatio, absMove, significant };
}

/** Basit tohumlu rastgele (tekrarlanabilir seçim için). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function spacedOk(i: number, taken: number[]): boolean {
  return taken.every((t) => Math.abs(t - i) >= SPACING);
}

export function selectWindows(c: Candle[], nEvents: number, nCalm: number, seed = 42): { events: number[]; calm: number[]; sigs: Map<number, Signals> } {
  const sigs = new Map<number, Signals>();
  const lo = minIndex();
  const hi = c.length - 1 - MAX_H;
  for (let i = lo; i <= hi; i++) sigs.set(i, computeSignals(c, i));

  const strength = (s: Signals) => Math.max(Math.abs(s.priceZ) / config.triggerPriceZ, s.volZ / config.triggerVolumeZ);
  const triggered = [...sigs.values()].filter((s) => s.triggered).sort((a, b) => strength(b) - strength(a));
  const events: number[] = [];
  for (const s of triggered) {
    if (events.length >= nEvents) break;
    if (spacedOk(s.index, events)) events.push(s.index);
  }

  // Sakin: son 10 mumda hiç tetik yok
  const calmCand = [...sigs.keys()].filter((i) => {
    for (let k = Math.max(lo, i - 10); k <= i; k++) if (sigs.get(k)?.triggered) return false;
    return true;
  });
  const r = rng(seed);
  for (let k = calmCand.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [calmCand[k], calmCand[j]] = [calmCand[j], calmCand[k]];
  }
  const calm: number[] = [];
  for (const i of calmCand) {
    if (calm.length >= nCalm) break;
    if (spacedOk(i, [...events, ...calm])) calm.push(i);
  }
  return { events: events.sort((a, b) => a - b), calm: calm.sort((a, b) => a - b), sigs };
}

function pct(a: number, n: number): string {
  return n === 0 ? "-" : `${((a / n) * 100).toFixed(0)}% (${a}/${n})`;
}

function table(title: string, rows: string[][]): void {
  const widths = rows[0].map((_, j) => Math.max(...rows.map((r) => r[j].length)));
  log.stage("DEĞERLENDİRME", title);
  for (const r of rows) console.log("  " + r.map((x, j) => x.padEnd(widths[j])).join("  │  "));
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const mode: AgentMode = flags.has("cached") ? "cached" : flags.has("record-agents") ? "record" : "call";
  const statsOnly = flags.has("stats-only");
  const nEvents = Number(values.get("events") ?? 10);
  const nCalm = Number(values.get("calm") ?? 10);

  // 1) Veri (tarihsel, gerçek)
  let candles: Candle[];
  if (values.get("data")) {
    candles = loadRecording(path.resolve(values.get("data")!)).candles;
  } else {
    const symbol = (values.get("symbol") ?? "BTC-USDT").toUpperCase();
    const count = Number(values.get("count") ?? 3000);
    log.stage("DEĞERLENDİRME", `${symbol}: ${count} tarihsel 1m mum indiriliyor`);
    candles = await fetchHistory(symbol, count);
    const f = writeRecording(candles, path.join(RECORDINGS_DIR, `eval_${symbol}_${candles[0].ts}_${candles[candles.length - 1].ts}.jsonl`));
    log.ok("DEĞERLENDİRME", `kaydedildi → ${path.relative(ROOT, f)} (tekrar için --data ile kullanın)`);
  }
  if (candles.some((c) => c.injected)) throw new Error("ENJEKTE veri değerlendirmeye dahil edilmez; temiz bir kayıt kullanın");

  // 2) Pencere seçimi
  const { events, calm, sigs } = selectWindows(candles, nEvents, nCalm);
  log.stage("DEĞERLENDİRME", `${events.length} olay + ${calm.length} sakin pencere seçildi (hedef ${nEvents}+${nCalm})`);

  const windows: EvalWindow[] = [...events.map((i) => ({ i, kind: "olay" as const })), ...calm.map((i) => ({ i, kind: "sakin" as const }))].map(
    ({ i, kind }) => ({
      index: i,
      record_id: candles[i].record_id,
      iso: candles[i].iso,
      kind,
      signals: sigs.get(i)!,
      outcomes: HORIZONS.map((h) => outcomeAt(candles, i, h)),
      notes: [],
    }),
  );

  // 3) Agent analizi (zaman kesitli: yalnızca pencere sonuna kadarki veri)
  if (!statsOnly) {
    for (const [k, w] of windows.entries()) {
      const c = candles[w.index];
      const window = windowEnding(candles, w.index, config.statsWindow);
      if (window[window.length - 1].ts !== c.ts) throw new Error("zaman kesiti ihlali");
      const input = { round_id: roundIdFor(c), symbol: c.symbol, window };
      log.info("DEĞERLENDİRME", `[${k + 1}/${windows.length}] ${w.kind} ${c.iso}`);
      try {
        const [a, b] = await Promise.all([runAtlas(input, mode), runArgus(input, mode)]);
        const cmp = compareInitial(a.finding ?? null, b.finding ?? null, w.signals);
        // Değerlendirmede uyuşmazlık turu çalıştırılmaz: ayrışma doğrudan belirsiz
        w.level = cmp.level;
        w.claimedAnomaly = cmp.level !== "BELIRSIZ" && !!cmp.agreed?.anomaly;
        w.agreedType = cmp.agreed?.type;
        for (const o of [a, b]) if (!o.ok) w.notes.push(`${o.agent}: ${o.errors.join("; ")}`);
      } catch (e) {
        w.level = "BELIRSIZ";
        w.notes.push(errMsg(e));
      }
    }
  }

  // 4) Tablolar
  const sig = (ws: EvalWindow[], h: number) => ws.filter((w) => w.outcomes.find((o) => o.horizon === h)!.significant).length;
  const ev = windows.filter((w) => w.kind === "olay");
  const ca = windows.filter((w) => w.kind === "sakin");
  table("İstatistik tabanı (LLM'siz): sonraki dönemde anlamlı oynaklık/fiyat artışı", [
    ["grup", "n", "15 dk anlamlı", "60 dk anlamlı"],
    ["olay (tetik çalıştı)", String(ev.length), pct(sig(ev, 15), ev.length), pct(sig(ev, 60), ev.length)],
    ["sakin (tetik yok)", String(ca.length), pct(sig(ca, 15), ca.length), pct(sig(ca, 60), ca.length)],
  ]);

  let byLevel: Record<string, unknown> | undefined;
  if (!statsOnly) {
    const rows = [["uyum seviyesi", "n", "anomali iddiası", "isabet @15", "isabet @60", "yanlış alarm @60", "sakin pencerede alarm"]];
    byLevel = {};
    for (const lv of ["YUKSEK", "ORTA", "BELIRSIZ"] as Level[]) {
      const g = windows.filter((w) => w.level === lv);
      const claimed = g.filter((w) => w.claimedAnomaly);
      const hit15 = sig(claimed, 15);
      const hit60 = sig(claimed, 60);
      const calmAlarms = claimed.filter((w) => w.kind === "sakin").length;
      rows.push([LEVEL_TR[lv], String(g.length), String(claimed.length), pct(hit15, claimed.length), pct(hit60, claimed.length), pct(claimed.length - hit60, claimed.length), String(calmAlarms)]);
      byLevel[lv] = { n: g.length, claimed: claimed.length, hit15, hit60, falseAlarm60: claimed.length - hit60, calmAlarms };
    }
    table("Uyum seviyesine göre isabet ve yanlış alarm", rows);
    const failed = windows.filter((w) => w.notes.length).length;
    if (failed) log.warn("DEĞERLENDİRME", `${failed} pencerede agent hatası/geçersiz çıktı vardı (belirsiz sayıldı)`);
  }

  const small = windows.length < 2 * SMALL_SAMPLE || ev.length < SMALL_SAMPLE || ca.length < SMALL_SAMPLE;
  if (small) log.warn("DEĞERLENDİRME", `ÖRNEKLEM KÜÇÜK (${ev.length} olay, ${ca.length} sakin): sonuçlar yön gösterir, istatistiksel kanıt değildir`);
  log.info(
    "DEĞERLENDİRME",
    `Ölçüt: sonraki H dk oynaklık / pencere oynaklığı ≥ ${VOL_RATIO_SIGNIFICANT} veya |fiyat değişimi| ≥ ${MOVE_SIGMAS}σ√H. "Uyum beyanı" kalibre değildir.`,
  );

  const outDir = path.join(ROOT, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `evaluation_${Date.now()}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ created_at: new Date().toISOString(), statsOnly, mode, smallSample: small, criteria: { VOL_RATIO_SIGNIFICANT, MOVE_SIGMAS, HORIZONS }, byLevel, windows }, null, 2),
    "utf8",
  );
  log.ok("DEĞERLENDİRME", `sonuçlar → ${path.relative(ROOT, out)}`);
}

main().catch((e) => {
  log.error("DEĞERLENDİRME", errMsg(e));
  process.exitCode = 1;
});
