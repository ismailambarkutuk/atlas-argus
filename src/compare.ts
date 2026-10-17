// Karar kuralları (LLM'siz). Örtüşme: anomaly, type ve direction aynı.
import { config } from "./config.js";
import { log, isMain } from "./util.js";
import type { Finding } from "./agents/schema.js";
import type { Signals } from "./stats/robustZ.js";

export type Level = "YUKSEK" | "ORTA" | "BELIRSIZ";
export const LEVEL_TR: Record<Level, string> = { YUKSEK: "yüksek", ORTA: "orta", BELIRSIZ: "belirsiz" };

export interface CompareResult {
  level: Level;
  overlap: boolean;
  statConfirmed: boolean;
  disagreement: string[];
  needsDispute: boolean;
  /** örtüşme varsa ortak karar */
  agreed?: Pick<Finding, "anomaly" | "type" | "direction">;
  reasons: string[];
}

const OVERLAP_FIELDS = ["anomaly", "type", "direction"] as const;

export function diffFields(a: Finding, b: Finding): string[] {
  return OVERLAP_FIELDS.filter((k) => a[k] !== b[k]);
}

/**
 * İstatistik onayı: fiyat |z| ≥ 3 VE hacim z ≥ 2. Ek koşul (daha temkinli):
 * fiyat z'nin işareti bulgunun yönüyle uyumlu olmalı.
 */
export function statConfirmation(s: Pick<Signals, "priceZ" | "volZ">, f?: Pick<Finding, "direction">): { confirmed: boolean; reason: string } {
  const priceOk = Math.abs(s.priceZ) >= config.confirmPriceZ;
  const volOk = s.volZ >= config.confirmVolumeZ;
  const dirOk = !f || f.direction === "none" || (f.direction === "down" ? s.priceZ < 0 : s.priceZ > 0);
  const confirmed = priceOk && volOk && dirOk;
  const reason = `fiyat |z|=${Math.abs(s.priceZ).toFixed(2)} ${priceOk ? "≥" : "<"} ${config.confirmPriceZ}, hacim z=${s.volZ.toFixed(2)} ${volOk ? "≥" : "<"} ${config.confirmVolumeZ}${dirOk ? "" : ", yön uyumsuz"}`;
  return { confirmed, reason };
}

function agreedLevel(a: Finding, b: Finding, stats: Pick<Signals, "priceZ" | "volZ">, reasons: string[]): { level: Level; statConfirmed: boolean } {
  const conf = a.confidence >= config.minConfidence && b.confidence >= config.minConfidence;
  const st = statConfirmation(stats, a);
  reasons.push(`İki agent örtüşüyor: ${a.type}/${a.direction}`);
  reasons.push(`Uyum beyanları ATLAS ${a.confidence}, ARGUS ${b.confidence} → ${conf ? "ikisi de" : "en az biri"} ${conf ? "≥" : "<"} ${config.minConfidence}`);
  reasons.push(`İstatistik onayı ${st.confirmed ? "VAR" : "YOK"} (${st.reason})`);
  return { level: conf && st.confirmed ? "YUKSEK" : "ORTA", statConfirmed: st.confirmed };
}

/** İlk karşılaştırma. Bulgulardan biri geçersizse (null) sonuç belirsizdir. */
export function compareInitial(atlas: Finding | null, argus: Finding | null, stats: Pick<Signals, "priceZ" | "volZ">): CompareResult {
  const reasons: string[] = [];
  if (!atlas || !argus) {
    reasons.push(`${!atlas ? "ATLAS" : "ARGUS"} bulgusu geçersiz veya yok → belirsiz`);
    return { level: "BELIRSIZ", overlap: false, statConfirmed: false, disagreement: [], needsDispute: false, reasons };
  }
  const diff = diffFields(atlas, argus);
  if (diff.length === 0) {
    const { level, statConfirmed } = agreedLevel(atlas, argus, stats, reasons);
    return { level, overlap: true, statConfirmed, disagreement: [], needsDispute: false, agreed: pick(atlas), reasons };
  }
  reasons.push(`Ayrışma: ${diff.map((d) => `${d} farklı`).join(", ")} → tek turluk uyuşmazlık turu`);
  return { level: "BELIRSIZ", overlap: false, statConfirmed: false, disagreement: diff, needsDispute: true, reasons };
}

/**
 * Uyuşmazlık turu sonucu. ATLAS fikrini yalnızca daha önce kullanmadığı
 * record_id'lerle yeni kanıt sunarsa değiştirebilir. Örtüşme sağlansa bile en fazla "orta".
 */
export function resolveDispute(
  atlasOld: Finding,
  atlasNew: Finding | null,
  argus: Finding,
  stats: Pick<Signals, "priceZ" | "volZ">,
): CompareResult & { newEvidence: string[] } {
  const reasons: string[] = [];
  const base = { overlap: false, statConfirmed: false, needsDispute: false, newEvidence: [] as string[] };
  if (!atlasNew) {
    reasons.push("Uyuşmazlık turunda ATLAS geçerli bulgu döndürmedi → belirsiz");
    return { ...base, level: "BELIRSIZ", disagreement: diffFields(atlasOld, argus), reasons };
  }
  const changed = diffFields(atlasOld, atlasNew).length > 0;
  if (!changed) {
    reasons.push("ATLAS fikrini korudu; ayrışma sürüyor → belirsiz, aksiyon yok");
    return { ...base, level: "BELIRSIZ", disagreement: diffFields(atlasNew, argus), reasons };
  }
  const used = new Set(atlasOld.evidence.map((e) => e.record_id));
  const fresh = [...new Set(atlasNew.evidence.map((e) => e.record_id).filter((id) => !used.has(id)))];
  if (fresh.length === 0) {
    reasons.push("ATLAS fikrini değiştirdi ama YENİ kanıt (daha önce kullanılmamış record_id) sunmadı → belirsiz");
    return { ...base, level: "BELIRSIZ", disagreement: diffFields(atlasNew, argus), reasons };
  }
  reasons.push(`ATLAS yeni kanıtla fikrini değiştirdi: ${fresh.join(", ")}`);
  const diff = diffFields(atlasNew, argus);
  if (diff.length > 0) {
    reasons.push(`Hâlâ ayrışıyor (${diff.join(", ")}) → belirsiz`);
    return { ...base, newEvidence: fresh, level: "BELIRSIZ", disagreement: diff, reasons };
  }
  const { statConfirmed } = agreedLevel(atlasNew, argus, stats, reasons);
  reasons.push("Uyuşmazlık turu sonrası örtüşme → uyum en fazla orta");
  return { ...base, newEvidence: fresh, overlap: true, statConfirmed, level: "ORTA", disagreement: [], agreed: pick(atlasNew), reasons };
}

function pick(f: Finding): Pick<Finding, "anomaly" | "type" | "direction"> {
  return { anomaly: f.anomaly, type: f.type, direction: f.direction };
}

// Demo: npx tsx src/compare.ts
if (isMain(import.meta.url)) {
  const f = (agent: "ATLAS" | "ARGUS", over: Partial<Finding> = {}): Finding => ({
    agent, round_id: "R", symbol: "BTC-USDT", anomaly: true, type: "price_drop", direction: "down", severity: 0.8, confidence: 0.85,
    evidence: [{ record_id: "A", note: "" }], explanation: "", ...over,
  });
  const strong = { priceZ: -8, volZ: 5 };
  const show = (name: string, r: CompareResult) => log.stage("KARŞILAŞTIRMA", `${name}: ${LEVEL_TR[r.level]} | ${r.reasons.join(" | ")}`);
  show("örtüşme+güven+istatistik", compareInitial(f("ATLAS"), f("ARGUS"), strong));
  show("örtüşme, düşük güven", compareInitial(f("ATLAS", { confidence: 0.5 }), f("ARGUS"), strong));
  show("örtüşme, istatistik yok", compareInitial(f("ATLAS"), f("ARGUS"), { priceZ: -1, volZ: 4 }));
  show("geçersiz bulgu", compareInitial(null, f("ARGUS"), strong));
  const a0 = f("ATLAS", { type: "volume_spike", direction: "none" });
  show("ayrışma", compareInitial(a0, f("ARGUS"), strong));
  show("tur: fikir korundu", resolveDispute(a0, a0, f("ARGUS"), strong));
  show("tur: yeni kanıtsız değişim", resolveDispute(a0, f("ATLAS"), f("ARGUS"), strong));
  show("tur: yeni kanıtla değişim", resolveDispute(a0, f("ATLAS", { evidence: [{ record_id: "B", note: "" }] }), f("ARGUS"), strong));
}
