// Piyasa verisi toplama (yalnızca kimlik doğrulamasız `okx market` komutları).
// Hacim yalnızca kapanmış (confirm == "1") 1m mumlardan alınır; ticker hacmi kullanılmaz.
import fs from "node:fs";
import path from "node:path";
import { runOkx } from "../okx.js";
import { ROOT, log, isMain, parseArgs } from "../util.js";
import { Candle, RecordingMeta, candleRecordId } from "./types.js";

export const RECORDINGS_DIR = path.join(ROOT, "recordings");
const MAX_PER_CALL = 300;

/** OKX mum satırı: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] */
export function parseCandleRow(row: unknown, symbol: string): Candle | null {
  if (!Array.isArray(row) || row.length < 9) return null;
  const [ts, o, h, l, c, vol, volCcy, , confirm] = row.map((x) => String(x));
  const n = [ts, o, h, l, c, vol, volCcy].map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  if (confirm !== "1") return null; // kapanmamış mum: kullanılmaz
  return {
    kind: "candle",
    record_id: candleRecordId(symbol, n[0]),
    symbol,
    ts: n[0],
    iso: new Date(n[0]).toISOString(),
    open: n[1],
    high: n[2],
    low: n[3],
    close: n[4],
    vol: n[5],
    volCcy: n[6],
    confirm: "1",
  };
}

/** Kapanmış 1m mumlar, eskiden yeniye sıralı. `after`: bu zamandan ÖNCEKİ mumlar. */
export async function fetchClosedCandles(symbol: string, limit = MAX_PER_CALL, after?: number): Promise<Candle[]> {
  const args = ["market", "candles", symbol, "--bar", "1m", "--limit", String(Math.min(limit, MAX_PER_CALL))];
  if (after !== undefined) args.push("--after", String(after));
  const r = await runOkx(args);
  if (!r.ok || !Array.isArray(r.data)) throw new Error(`mum verisi alınamadı: ${r.error ?? "beklenmeyen format"}`);
  const candles = r.data.map((row) => parseCandleRow(row, symbol)).filter((c): c is Candle => c !== null);
  return candles.sort((a, b) => a.ts - b.ts);
}

/** `endTs` öncesindeki `count` kapanmış mumu sayfalayarak getirir (değerlendirme için). */
export async function fetchHistory(symbol: string, count: number, endTs?: number): Promise<Candle[]> {
  const byTs = new Map<number, Candle>();
  let cursor = endTs;
  while (byTs.size < count) {
    const batch = await fetchClosedCandles(symbol, MAX_PER_CALL, cursor);
    if (batch.length === 0) break;
    for (const c of batch) byTs.set(c.ts, c);
    const oldest = batch[0].ts;
    if (cursor !== undefined && oldest >= cursor) break;
    cursor = oldest;
    log.info("VERİ", `${symbol}: ${byTs.size}/${count} mum toplandı`);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-count);
}

export async function fetchTickerPrice(symbol: string): Promise<number> {
  const r = await runOkx(["market", "ticker", symbol]);
  const row = Array.isArray(r.data) ? (r.data[0] as { last?: string }) : undefined;
  const px = Number(row?.last);
  if (!r.ok || !Number.isFinite(px) || px <= 0) throw new Error(`fiyat alınamadı: ${r.error ?? "geçersiz ticker"}`);
  return px;
}

export function writeRecording(candles: Candle[], file?: string): string {
  if (candles.length === 0) throw new Error("kaydedilecek mum yok");
  const symbol = candles[0].symbol;
  const out =
    file ??
    path.join(RECORDINGS_DIR, `${symbol}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const meta: RecordingMeta = {
    kind: "meta",
    symbol,
    bar: "1m",
    created_at: new Date().toISOString(),
    source: "okx market candles",
    count: candles.length,
  };
  fs.writeFileSync(out, [meta, ...candles].map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  return out;
}

// Demo: npx tsx src/data/collector.ts --symbol BTC-USDT --count 300 [--out recordings/x.jsonl]
if (isMain(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const symbol = (values.get("symbol") ?? "BTC-USDT").toUpperCase();
  const count = Number(values.get("count") ?? 300);
  const out = values.get("out") ? path.resolve(values.get("out")!) : undefined;
  try {
    log.stage("VERİ", `${symbol} için son ${count} kapanmış 1m mum isteniyor`);
    const candles = count > MAX_PER_CALL ? await fetchHistory(symbol, count) : await fetchClosedCandles(symbol, count);
    const file = writeRecording(candles, out);
    const last = candles[candles.length - 1];
    log.ok("VERİ", `${candles.length} mum kaydedildi → ${path.relative(ROOT, file)}`);
    log.info("VERİ", `Son mum ${last.iso} kapanış ${last.close} hacim ${last.vol}`);
    log.info("VERİ", `Ticker fiyatı: ${await fetchTickerPrice(symbol)}`);
  } catch (e) {
    log.error("VERİ", (e as Error).message);
    process.exitCode = 1;
  }
}
