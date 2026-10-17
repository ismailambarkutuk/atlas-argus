// Kayıtlı veriyi (recordings/*.jsonl) canlı toplamayla aynı formatta oynatır.
import fs from "node:fs";
import path from "node:path";
import { ROOT, log, isMain } from "../util.js";
import { Candle, RecordingMeta } from "./types.js";

function isCandle(x: any): x is Candle {
  return (
    x &&
    x.kind === "candle" &&
    typeof x.record_id === "string" &&
    typeof x.symbol === "string" &&
    [x.ts, x.open, x.high, x.low, x.close, x.vol].every((v) => typeof v === "number" && Number.isFinite(v)) &&
    x.confirm === "1"
  );
}

export function loadRecording(file: string): { meta?: RecordingMeta; candles: Candle[]; skipped: number } {
  const text = fs.readFileSync(file, "utf8");
  let meta: RecordingMeta | undefined;
  const byId = new Map<string, Candle>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (obj?.kind === "meta") meta = obj;
    else if (isCandle(obj)) byId.set(obj.record_id, obj);
    else skipped++;
  }
  const candles = [...byId.values()].sort((a, b) => a.ts - b.ts);
  const symbols = new Set(candles.map((c) => c.symbol));
  if (symbols.size > 1) throw new Error(`kayıtta birden fazla sembol var: ${[...symbols].join(",")}`);
  if (skipped > 0) log.warn("REPLAY", `${skipped} geçersiz satır atlandı`);
  return { meta, candles, skipped };
}

// Demo: npx tsx src/data/replay.ts recordings/x.jsonl
if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    log.error("REPLAY", "Kullanım: npx tsx src/data/replay.ts <kayit.jsonl>");
    process.exit(1);
  }
  const { candles } = loadRecording(path.resolve(file));
  const first = candles[0];
  const last = candles[candles.length - 1];
  log.ok("REPLAY", `${path.relative(ROOT, path.resolve(file))}: ${candles.length} mum, ${first?.iso} → ${last?.iso}`);
  const injected = candles.filter((c) => c.injected).length;
  if (injected) log.warn("REPLAY", `${injected} ENJEKTE kayıt içeriyor`);
}
