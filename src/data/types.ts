// Kayıt formatı: recordings/*.jsonl içindeki her satır bir Candle (veya ilk satırda meta).

export interface Candle {
  kind: "candle";
  record_id: string;
  symbol: string;
  ts: number; // mum açılış zamanı (ms)
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number; // baz para birimi cinsinden hacim, yalnızca kapanmış 1m mumdan
  volCcy: number;
  confirm: "1";
  injected?: true;
  inject_scenario?: string;
}

export interface RecordingMeta {
  kind: "meta";
  symbol: string;
  bar: "1m";
  created_at: string;
  source: string;
  count: number;
}

export function candleRecordId(symbol: string, ts: number, injected = false): string {
  return `${symbol}-1m-${ts}${injected ? "-INJ" : ""}`;
}

/** Tur kimliği deterministiktir (kayıtlı yanıtların eşleşebilmesi için). */
export function roundIdFor(c: Candle): string {
  return `R-${c.symbol}-${c.ts}${c.injected ? `-INJ-${c.inject_scenario ?? "x"}` : ""}`;
}

/** `i` indeksli mumla biten son `n` mum (agent'ların gördüğü ham pencere; sonrası asla yok). */
export function windowEnding(candles: Candle[], i: number, n: number): Candle[] {
  return candles.slice(Math.max(0, i - n + 1), i + 1);
}
