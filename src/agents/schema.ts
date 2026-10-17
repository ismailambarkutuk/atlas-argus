// Bulgu şeması (ATLAS ve ARGUS aynı formatı döndürür), kodla doğrulama ve
// iki agent'a giden ORTAK ham veri istemi. Hazır istatistik değerleri agent'lara verilmez.
import { isMain, log } from "../util.js";
import type { Candle } from "../data/types.js";

export type AgentName = "ATLAS" | "ARGUS";
export const FINDING_TYPES = ["price_drop", "price_spike", "volume_spike", "none"] as const;
export const DIRECTIONS = ["up", "down", "none"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];
export type Direction = (typeof DIRECTIONS)[number];

export interface Evidence {
  record_id: string;
  note: string;
}

export interface Finding {
  agent: AgentName;
  round_id: string;
  symbol: string;
  anomaly: boolean;
  type: FindingType;
  direction: Direction;
  severity: number;
  confidence: number;
  evidence: Evidence[];
  explanation: string;
}

/** Agent çağrısının sonucu. ok=false → belirsiz (kural 7). */
export interface AgentOutcome {
  agent: AgentName;
  phase: "initial" | "dispute";
  ok: boolean;
  finding?: Finding;
  errors: string[];
  raw?: string;
  cached: boolean;
  model: string;
  durationMs: number;
}

export interface AgentInput {
  round_id: string;
  symbol: string;
  window: Candle[];
}

/** Anthropic structured outputs için JSON şeması. */
export const FINDING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "round_id", "symbol", "anomaly", "type", "direction", "severity", "confidence", "evidence", "explanation"],
  properties: {
    agent: { type: "string", enum: ["ATLAS", "ARGUS"] },
    round_id: { type: "string" },
    symbol: { type: "string" },
    anomaly: { type: "boolean" },
    type: { type: "string", enum: [...FINDING_TYPES] },
    direction: { type: "string", enum: [...DIRECTIONS] },
    severity: { type: "number" },
    confidence: { type: "number" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["record_id", "note"],
        properties: { record_id: { type: "string" }, note: { type: "string" } },
      },
    },
    explanation: { type: "string" },
  },
} as const;

const KEYS = FINDING_JSON_SCHEMA.required;

/** LLM metnini JSON'a çevirir. Yalnızca ```json çiti tolere edilir; başka metin = geçersiz. */
export function parseFindingText(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  return JSON.parse(t);
}

export interface ValidationContext {
  agent: AgentName;
  round_id: string;
  symbol: string;
  validRecordIds: Set<string>;
}

/** Şema + tutarlılık + halüsinasyon (record_id gerçek veride var mı) kontrolü. */
export function validateFinding(obj: unknown, ctx: ValidationContext): { ok: true; finding: Finding } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, errors: ["çıktı bir JSON nesnesi değil"] };
  const o = obj as Record<string, unknown>;

  for (const k of KEYS) if (!(k in o)) errors.push(`eksik alan: ${k}`);
  for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) errors.push(`şemada olmayan alan: ${k}`);
  if (errors.length) return { ok: false, errors };

  if (o.agent !== ctx.agent) errors.push(`agent "${String(o.agent)}" beklenen "${ctx.agent}" değil`);
  if (o.round_id !== ctx.round_id) errors.push(`round_id "${String(o.round_id)}" beklenen "${ctx.round_id}" değil`);
  if (o.symbol !== ctx.symbol) errors.push(`symbol "${String(o.symbol)}" beklenen "${ctx.symbol}" değil`);
  if (typeof o.anomaly !== "boolean") errors.push("anomaly boolean değil");
  if (!FINDING_TYPES.includes(o.type as FindingType)) errors.push(`geçersiz type: ${String(o.type)}`);
  if (!DIRECTIONS.includes(o.direction as Direction)) errors.push(`geçersiz direction: ${String(o.direction)}`);
  for (const k of ["severity", "confidence"] as const) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) errors.push(`${k} 0 ile 1 arasında bir sayı değil`);
  }
  if (typeof o.explanation !== "string") errors.push("explanation metin değil");

  // İç tutarlılık
  if (o.anomaly === false && o.type !== "none") errors.push("anomaly=false iken type 'none' olmalı");
  if (o.anomaly === true && o.type === "none") errors.push("anomaly=true iken type 'none' olamaz");
  if (o.type === "price_drop" && o.direction !== "down") errors.push("price_drop için direction 'down' olmalı");
  if (o.type === "price_spike" && o.direction !== "up") errors.push("price_spike için direction 'up' olmalı");
  if (o.type === "none" && o.direction !== "none") errors.push("type 'none' iken direction 'none' olmalı");

  // Kanıt: her record_id gerçek veride bulunmalı
  if (!Array.isArray(o.evidence)) errors.push("evidence dizi değil");
  else {
    if (o.anomaly === true && o.evidence.length === 0) errors.push("anomali iddiası kanıtsız");
    for (const e of o.evidence) {
      if (typeof e !== "object" || e === null || typeof (e as Evidence).record_id !== "string" || typeof (e as Evidence).note !== "string") {
        errors.push("evidence öğesi {record_id, note} biçiminde değil");
        continue;
      }
      if (Object.keys(e).some((k) => k !== "record_id" && k !== "note")) errors.push("evidence öğesinde şemada olmayan alan");
      if (!ctx.validRecordIds.has((e as Evidence).record_id)) errors.push(`HALÜSİNASYON: record_id "${(e as Evidence).record_id}" veride yok`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, finding: o as unknown as Finding };
}

/** Ham metni ayrıştırıp doğrular; her hata (geçersiz JSON dahil) ok=false yani belirsizdir. */
export function outcomeFromRaw(
  raw: string,
  ctx: ValidationContext,
  meta: { phase: AgentOutcome["phase"]; cached: boolean; model: string; durationMs: number },
): AgentOutcome {
  let parsed: unknown;
  try {
    parsed = parseFindingText(raw);
  } catch {
    return { agent: ctx.agent, ...meta, ok: false, errors: ["geçersiz JSON"], raw };
  }
  const v = validateFinding(parsed, ctx);
  return v.ok
    ? { agent: ctx.agent, ...meta, ok: true, finding: v.finding, errors: [], raw }
    : { agent: ctx.agent, ...meta, ok: false, errors: v.errors, raw };
}

export function failedOutcome(agent: AgentName, phase: AgentOutcome["phase"], model: string, started: number, error: string): AgentOutcome {
  return { agent, phase, ok: false, errors: [error], cached: false, model, durationMs: Date.now() - started };
}

export function validationContext(agent: AgentName, input: AgentInput): ValidationContext {
  return { agent, round_id: input.round_id, symbol: input.symbol, validRecordIds: new Set(input.window.map((c) => c.record_id)) };
}

// --- Ortak istem (iki agent'a da birebir aynısı gider) ---

export function systemPrompt(agent: AgentName): string {
  return [
    `Sen ${agent} adlı bağımsız bir kripto piyasa anomali analistisin.`,
    "Sana bir spot çiftin son 1 dakikalık kapanmış mumları verilecek. Her mumun benzersiz bir record_id'si var.",
    "Görevin: SON mumda veya son birkaç mumda olağandışı bir hareket olup olmadığını yalnızca bu ham veriye bakarak değerlendirmek.",
    "Türler: price_drop (sert düşüş), price_spike (sert yükseliş), volume_spike (fiyat belirgin değişmeden hacim patlaması), none (olağan).",
    "Kurallar:",
    "- Yalnızca aşağıdaki JSON nesnesini döndür. Başka hiçbir metin, açıklama veya kod çiti yazma.",
    "- evidence içinde yalnızca veride gerçekten bulunan record_id'leri kullan; uydurma.",
    "- anomaly=false ise type ve direction 'none' olmalı. price_drop → direction 'down', price_spike → direction 'up'.",
    "- severity ve confidence 0 ile 1 arasında. confidence senin kendi uyum beyanındır.",
    "- Emin değilsen bunu düşük confidence ile belirt.",
    "Şema:",
    `{"agent":"${agent}","round_id":"<verilen>","symbol":"<verilen>","anomaly":true|false,"type":"price_drop|price_spike|volume_spike|none","direction":"up|down|none","severity":0.0,"confidence":0.0,"evidence":[{"record_id":"...","note":"..."}],"explanation":"kısa Türkçe gerekçe"}`,
  ].join("\n");
}

/** Ham pencere: yalnızca mum verisi ve record_id; hesaplanmış istatistik yok. */
export function dataPrompt(input: AgentInput): string {
  const rows = input.window.map(
    (c) => `${c.record_id},${c.iso},${c.open},${c.high},${c.low},${c.close},${c.vol}`,
  );
  return [
    `round_id: ${input.round_id}`,
    `symbol: ${input.symbol}`,
    `mum sayısı: ${input.window.length} (eskiden yeniye, 1m, kapanmış)`,
    "record_id,zaman_utc,acilis,yuksek,dusuk,kapanis,hacim",
    ...rows,
  ].join("\n");
}

/**
 * Uyuşmazlık turu istemi: yalnızca HANGİ alanlarda ayrışıldığı söylenir,
 * diğer agent'ın gerekçesi veya değerleri asla gösterilmez.
 */
export function disputePrompt(fields: string[], usedIds: string[]): string {
  return [
    `Bağımsız ikinci bir analiz bulgunla şu alan(lar)da ayrıştı: ${fields.join(", ")}.`,
    "Diğer analizin gerekçesi ve değerleri sana gösterilmeyecek.",
    "Bulgunu aynı veri üzerinde yeniden değerlendir.",
    "Fikrini (anomaly, type veya direction) DEĞİŞTİRECEKSEN, ilk bulgunda kullanmadığın record_id'lerle yeni kanıt sunmak ZORUNDASIN.",
    `İlk bulgunda kullandığın record_id'ler: ${usedIds.length ? usedIds.join(", ") : "(yok)"}`,
    "Yeni kanıtın yoksa önceki bulgunu aynen koru. Yine yalnızca aynı şemadaki JSON nesnesini döndür.",
  ].join("\n");
}

// Demo: npx tsx src/agents/schema.ts
if (isMain(import.meta.url)) {
  const ctx: ValidationContext = { agent: "ATLAS", round_id: "R1", symbol: "BTC-USDT", validRecordIds: new Set(["A", "B"]) };
  const good = { agent: "ATLAS", round_id: "R1", symbol: "BTC-USDT", anomaly: true, type: "price_drop", direction: "down", severity: 0.8, confidence: 0.9, evidence: [{ record_id: "B", note: "sert düşüş" }], explanation: "test" };
  const halu = { ...good, evidence: [{ record_id: "UYDURMA", note: "x" }] };
  const bad = { ...good, type: "price_drop", direction: "up" };
  log.ok("ŞEMA", `geçerli bulgu: ${JSON.stringify(validateFinding(good, ctx).ok)}`);
  log.warn("ŞEMA", `halüsinasyon: ${JSON.stringify(validateFinding(halu, ctx))}`);
  log.warn("ŞEMA", `tutarsız: ${JSON.stringify(validateFinding(bad, ctx))}`);
  try {
    parseFindingText("İşte bulgum: {}");
  } catch {
    log.warn("ŞEMA", "serbest metin → JSON değil → belirsiz");
  }
}
