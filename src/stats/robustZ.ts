// LLM'siz istatistik kontrolü: kayan pencerede robust z.
// robust z = (x − medyan) / (1.4826 × MAD). Fiyat için log getiri, hacim için log(hacim).
import path from "node:path";
import { config } from "../config.js";
import { log, isMain } from "../util.js";
import type { Candle } from "../data/types.js";
import { median, mad } from "./descriptive.js";

export { median, mad };

export const MAD_EPSILON = 1e-9;
const VOL_FLOOR = 1e-12;

/** x'in `baseline` dağılımına göre robust z skoru. MAD sıfırsa epsilon kullanılır. */
export function robustZ(x: number, baseline: number[]): number {
  const med = median(baseline);
  const m = mad(baseline, med);
  return (x - med) / (1.4826 * Math.max(m, MAD_EPSILON));
}

export interface Signals {
  index: number;
  record_id: string;
  ts: number;
  ret: number; // son mumun log getirisi
  priceZ: number;
  volZ: number;
  window: number;
  triggered: boolean;
  triggerReasons: string[];
  /** fiyat |z| ≥ 3 VE hacim z ≥ 2 */
  statConfirm: boolean;
}

/** En az window + 1 mum öncesi gerekir (getiri için bir mum fazladan). */
export function minIndex(window = config.statsWindow): number {
  return window + 1;
}

/**
 * `i` indeksli mumun sinyalleri. Taban çizgisi, o mumdan ÖNCEKİ `window` mumdur
 * (mumun kendisi kendi taban çizgisine katılmaz).
 */
export function computeSignals(candles: Candle[], i: number, window = config.statsWindow): Signals {
  if (i < minIndex(window) || i >= candles.length) throw new Error(`indeks ${i} için yeterli geçmiş yok`);
  const rets: number[] = [];
  for (let k = i - window; k < i; k++) rets.push(Math.log(candles[k].close / candles[k - 1].close));
  const logVols = candles.slice(i - window, i).map((c) => Math.log(c.vol + VOL_FLOOR));

  const c = candles[i];
  const ret = Math.log(c.close / candles[i - 1].close);
  const priceZ = robustZ(ret, rets);
  const volZ = robustZ(Math.log(c.vol + VOL_FLOOR), logVols);

  const reasons: string[] = [];
  if (Math.abs(priceZ) >= config.triggerPriceZ) reasons.push(`fiyat |z|=${Math.abs(priceZ).toFixed(2)} ≥ ${config.triggerPriceZ}`);
  if (volZ >= config.triggerVolumeZ) reasons.push(`hacim z=${volZ.toFixed(2)} ≥ ${config.triggerVolumeZ}`);

  return {
    index: i,
    record_id: c.record_id,
    ts: c.ts,
    ret,
    priceZ,
    volZ,
    window,
    triggered: reasons.length > 0,
    triggerReasons: reasons,
    statConfirm: Math.abs(priceZ) >= config.confirmPriceZ && volZ >= config.confirmVolumeZ,
  };
}

// Demo: npx tsx src/stats/robustZ.ts recordings/x.jsonl [--inject drop]
if (isMain(import.meta.url)) {
  const { loadRecording } = await import("../data/replay.js");
  const { injectScenario, isScenario } = await import("../data/inject.js");
  const file = process.argv[2];
  if (!file) {
    log.error("İSTATİSTİK", "Kullanım: npx tsx src/stats/robustZ.ts <kayit.jsonl> [--inject <senaryo>]");
    process.exit(1);
  }
  let { candles } = loadRecording(path.resolve(file));
  const sc = process.argv[process.argv.indexOf("--inject") + 1];
  if (process.argv.includes("--inject") && sc && isScenario(sc)) candles = injectScenario(candles, sc);

  log.info("İSTATİSTİK", `MAD sıfır testi: robustZ(1, [0,0,0]) = ${robustZ(1, [0, 0, 0]).toExponential(2)} (bölme hatası yok)`);
  let triggers = 0;
  for (let i = minIndex(); i < candles.length; i++) {
    const s = computeSignals(candles, i);
    if (!s.triggered) continue;
    triggers++;
    const tag = candles[i].injected ? " [ENJEKTE]" : "";
    log.stage(
      "İSTATİSTİK",
      `${s.record_id}${tag}: fiyat z=${s.priceZ.toFixed(2)} hacim z=${s.volZ.toFixed(2)} | ${s.triggerReasons.join(", ")} | onay: ${s.statConfirm ? "VAR" : "yok"}`,
    );
  }
  log.ok("İSTATİSTİK", `${candles.length - minIndex()} mum tarandı, ${triggers} tetik`);
}
