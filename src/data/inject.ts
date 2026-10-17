// Replay verisine etiketli yapay anomali ekler. Eklenen her kayıt injected: true
// ve record_id sonunda "-INJ" taşır; raporda ve logda "ENJEKTE" olarak görünür.
import path from "node:path";
import { log, isMain } from "../util.js";
import { median, mad } from "../stats/descriptive.js";
import { loadRecording } from "./replay.js";
import { Candle, candleRecordId } from "./types.js";

export const SCENARIOS = {
  drop: "Sert düşüş + hacim patlaması (fiyat ve hacim birlikte)",
  spike: "Sert yükseliş + hacim patlaması",
  volume: "Yalnızca hacim patlaması, fiyat yatay",
  whipsaw: "Uzun alt fitil: fiyat dibe vurup geri döner, hacim yüksek (yoruma açık)",
} as const;
export type Scenario = keyof typeof SCENARIOS;

export function isScenario(s: string): s is Scenario {
  return s in SCENARIOS;
}

/**
 * Son mumlardan tipik oynaklık (robust sigma), medyan hacim ve log-hacim yayılımını çıkarır.
 * Enjekte hacim, gerçek verinin yayılımına göre ölçeklenir ki tetik her veride çalışsın.
 */
function baseline(candles: Candle[], window = 60): { sigma: number; medVol: number; volMult: (z: number) => number } {
  const tail = candles.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i].close / tail[i - 1].close));
  const sigma = Math.max(1.4826 * mad(rets, median(rets)), 0.0003);
  const medVol = Math.max(median(tail.map((c) => c.vol)), 1e-6);
  const logVols = tail.map((c) => Math.log(c.vol + 1e-12));
  const volSigma = 1.4826 * mad(logVols, median(logVols));
  // hedef robust z kadar log-hacim artışı, en az 8 kat
  const volMult = (z: number) => Math.max(8, Math.exp(z * volSigma));
  return { sigma, medVol, volMult };
}

const round = (x: number, d = 8) => Number(x.toFixed(d));

/** Gerçek verideki fiyat ondalık hassasiyeti (enjekte mum bu hassasiyete yuvarlanır, göze batmasın). */
function priceDecimals(candles: Candle[]): number {
  let d = 0;
  for (const c of candles.slice(-60)) {
    for (const p of [c.open, c.high, c.low, c.close]) {
      const s = String(p);
      const i = s.indexOf(".");
      if (i >= 0) d = Math.max(d, s.length - i - 1);
    }
  }
  return Math.min(d, 8);
}

export function injectScenario(candles: Candle[], scenario: Scenario): Candle[] {
  if (candles.length < 2) throw new Error("enjeksiyon için yeterli veri yok");
  const last = candles[candles.length - 1];
  const { sigma, medVol, volMult } = baseline(candles);
  const ts = last.ts + 60_000;
  const pd = priceDecimals(candles);
  const open = last.close;
  let close: number, high: number, low: number, vol: number;

  switch (scenario) {
    case "drop": {
      const ret = -Math.max(0.012, 15 * sigma);
      close = open * Math.exp(ret);
      high = open * (1 + 0.5 * sigma);
      low = close * (1 - 2 * sigma);
      vol = medVol * volMult(5);
      break;
    }
    case "spike": {
      const ret = Math.max(0.012, 15 * sigma);
      close = open * Math.exp(ret);
      low = open * (1 - 0.5 * sigma);
      high = close * (1 + 2 * sigma);
      vol = medVol * volMult(5);
      break;
    }
    case "volume": {
      close = open * (1 + 0.1 * sigma);
      high = open * (1 + 0.8 * sigma);
      low = open * (1 - 0.8 * sigma);
      vol = medVol * volMult(7);
      break;
    }
    case "whipsaw": {
      low = open * (1 - Math.max(0.012, 15 * sigma));
      close = open * (1 - 0.2 * sigma);
      high = open * (1 + 0.5 * sigma);
      vol = medVol * volMult(5);
      break;
    }
  }

  const injected: Candle = {
    kind: "candle",
    record_id: candleRecordId(last.symbol, ts, true),
    symbol: last.symbol,
    ts,
    iso: new Date(ts).toISOString(),
    open: round(open, pd),
    high: round(Math.max(high, open, close), pd),
    low: round(Math.min(low, open, close), pd),
    close: round(close, pd),
    vol: round(vol),
    volCcy: round(vol * close, 4),
    confirm: "1",
    injected: true,
    inject_scenario: scenario,
  };
  return [...candles, injected];
}

// Demo: npx tsx src/data/inject.ts recordings/x.jsonl drop
if (isMain(import.meta.url)) {
  const [file, sc = "drop"] = process.argv.slice(2);
  if (!file || !isScenario(sc)) {
    log.error("ENJEKTE", `Kullanım: npx tsx src/data/inject.ts <kayit.jsonl> <${Object.keys(SCENARIOS).join("|")}>`);
    process.exit(1);
  }
  const { candles } = loadRecording(path.resolve(file));
  const out = injectScenario(candles, sc);
  const inj = out[out.length - 1];
  const prev = out[out.length - 2];
  log.warn("ENJEKTE", `${SCENARIOS[sc]}`);
  log.warn(
    "ENJEKTE",
    `${inj.record_id} | açılış ${inj.open} kapanış ${inj.close} (getiri ${((inj.close / prev.close - 1) * 100).toFixed(2)}%) dip ${inj.low} hacim ${inj.vol}`,
  );
}
