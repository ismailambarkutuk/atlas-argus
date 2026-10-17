// Risk motoru: saf, deterministik TypeScript. LLM yok; aksiyonu bu kod onaylar.
// Emir argümanları yalnızca buradan çıkan doğrulanmış değerlerden oluşur (kural 4).
import { config } from "./config.js";
import { log, isMain } from "./util.js";
import type { Level } from "./compare.js";
import type { FindingType } from "./agents/schema.js";

export interface RiskLimits {
  totalBudgetUsdt: number;
  maxPerTradeUsdt: number;
  maxDailyLossUsdt: number;
  allowedPairs: string[];
  reduceFraction: number;
}

export interface Balance {
  ccy: string;
  available: number;
  source: "mock" | "okx";
}

export interface Instrument {
  instId: string;
  lotSz: string;
  minSz: string;
}

export interface RiskState {
  date: string; // UTC gün (YYYY-MM-DD)
  spentTodayUsdt: number;
  totalSpentUsdt: number;
  realizedLossTodayUsdt: number;
}

export interface RiskInput {
  symbol: string;
  type: FindingType | null; // örtüşen bulgu tipi; örtüşme yoksa null
  level: Level;
  price: number | null;
  balance: Balance | null;
  instrument: Instrument | null;
  state: RiskState;
  killSwitch: { on: boolean; reason: string };
  limits: RiskLimits;
}

/** Sabit emir şekli: yalnızca spot, piyasa emri, nakit modu, satış (azaltma). */
export interface ValidatedOrder {
  instId: string;
  side: "sell";
  ordType: "market";
  tdMode: "cash";
  sz: string;
  notionalUsdt: number;
  opensRisk: false;
  stopLoss?: never;
}

export type RiskAction = "REDUCE" | "ALERT" | "NONE";

export interface RiskDecision {
  action: RiskAction;
  approved: boolean;
  order?: ValidatedOrder;
  reasons: string[];
}

export function limitsFromConfig(): RiskLimits {
  return {
    totalBudgetUsdt: config.totalBudgetUsdt,
    maxPerTradeUsdt: config.maxPerTradeUsdt,
    maxDailyLossUsdt: config.maxDailyLossUsdt,
    allowedPairs: [...config.allowedPairs],
    reduceFraction: config.reduceFraction,
  };
}

const DECIMAL = /^\d+(\.\d+)?$/;

function decimals(step: string): number {
  const i = step.indexOf(".");
  return i < 0 ? 0 : step.length - i - 1;
}

/**
 * q × 10^d değerini aşağı yuvarlanmış tam sayı olarak verir. q önce 15 anlamlı basamaklı
 * ondalığa çevrilir (Number'ın güvenilir hassasiyeti): float gürültüsü atılır, "0.29" gibi
 * borsadan gelen ondalıklar birebir korunur. Kesme BigInt ile yapılır; asla yukarı yuvarlamaz.
 */
function scaledFloor(q: number, d: number): bigint {
  const [mantissa, exp] = q.toExponential(14).split("e"); // "2.90000000000000e-1"
  const digits = BigInt(mantissa.replace(".", "")); // 15 basamak
  const shift = Number(exp) - 14 + d; // q × 10^d = digits × 10^shift
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/** İki ondalık metni ortak ölçekte tam olarak karşılaştırır: a ≥ b. */
export function atLeast(a: string, b: string): boolean {
  const d = Math.max(decimals(a), decimals(b));
  const scaled = (s: string) => BigInt(s.replace(".", "") + "0".repeat(d - decimals(s)));
  return scaled(a) >= scaled(b);
}

/** Miktarı lot adımına aşağı yuvarlar. Dönen `units`, 10^-d biriminde tam sayıdır. */
export function floorToLot(qty: number, lotSz: string): { units: bigint; text: string } {
  const d = decimals(lotSz);
  if (!Number.isFinite(qty) || qty <= 0) return { units: 0n, text: (0).toFixed(d) };
  const lotUnits = BigInt(lotSz.replace(".", "")); // "0.00000001" → 1n, "0.0010" → 10n
  const units = (scaledFloor(qty, d) / lotUnits) * lotUnits;
  const s = units.toString().padStart(d + 1, "0");
  return { units, text: d === 0 ? s : `${s.slice(0, -d)}.${s.slice(-d)}` };
}

function reject(action: RiskAction, reasons: string[], why: string): RiskDecision {
  return { action, approved: false, reasons: [...reasons, `RET: ${why}`] };
}

export function evaluateRisk(input: RiskInput): RiskDecision {
  const r: string[] = [];
  const { limits } = input;

  // 1) Aksiyon tablosu
  if (input.level === "BELIRSIZ" || input.type === null) {
    return { action: "NONE", approved: false, reasons: ["Uyum belirsiz → aksiyon yok"] };
  }
  if (input.type === "none") return { action: "NONE", approved: false, reasons: ["Bulgu tipi none → aksiyon yok"] };
  if (input.type === "price_spike" || input.type === "volume_spike") {
    return { action: "ALERT", approved: false, reasons: [`${input.type} → yalnızca uyarı, emir yok`] };
  }
  // price_drop + yüksek/orta → azaltma adayı
  const sizeFactor = input.level === "YUKSEK" ? 1 : 0.5;
  r.push(`price_drop + uyum ${input.level === "YUKSEK" ? "yüksek → tam boyut" : "orta → yarım boyut"}`);

  // 2) Kill switch
  if (input.killSwitch.on) return reject("REDUCE", r, `KILL SWITCH AÇIK (${input.killSwitch.reason})`);

  // 3) İzinli çift
  const instId = input.symbol.toUpperCase();
  if (!limits.allowedPairs.includes(instId)) return reject("REDUCE", r, `${instId} izinli çiftlerde değil (${limits.allowedPairs.join(",")})`);
  const [baseCcy, quoteCcy] = instId.split("-");
  if (quoteCcy !== "USDT") return reject("REDUCE", r, "yalnızca USDT kotasyonlu çiftler desteklenir");

  // 4) Girdi doğrulama
  if (input.price === null || !Number.isFinite(input.price) || input.price <= 0) return reject("REDUCE", r, "geçerli fiyat yok");
  if (!input.balance) return reject("REDUCE", r, "bakiye okunamadı");
  if (input.balance.ccy !== baseCcy) return reject("REDUCE", r, `bakiye para birimi ${input.balance.ccy}, beklenen ${baseCcy}`);
  if (!Number.isFinite(input.balance.available) || input.balance.available <= 0) return reject("REDUCE", r, `satılabilecek ${baseCcy} yok`);
  if (!input.instrument || input.instrument.instId !== instId) return reject("REDUCE", r, "enstrüman bilgisi (lot/min miktar) yok");
  const { lotSz, minSz } = input.instrument;
  if (!DECIMAL.test(lotSz) || !DECIMAL.test(minSz) || Number(lotSz) <= 0) return reject("REDUCE", r, "enstrüman lot bilgisi geçersiz");

  // 5) Günlük zarar ve bütçe
  if (input.state.realizedLossTodayUsdt >= limits.maxDailyLossUsdt) {
    return reject("REDUCE", r, `günlük maksimum zarar aşıldı (${input.state.realizedLossTodayUsdt} ≥ ${limits.maxDailyLossUsdt} USDT)`);
  }
  const budgetLeft = limits.totalBudgetUsdt - input.state.totalSpentUsdt;
  if (budgetLeft <= 0) return reject("REDUCE", r, `toplam bütçe tavanı doldu (${input.state.totalSpentUsdt}/${limits.totalBudgetUsdt} USDT)`);

  // 6) Boyut: min(işlem başı limit, kalan bütçe, eldeki varlığın izinli kısmı) × boyut çarpanı
  const holdingUsdt = input.balance.available * input.price;
  const target =
    Math.min(limits.maxPerTradeUsdt, budgetLeft, holdingUsdt * limits.reduceFraction) * sizeFactor;
  r.push(
    `Boyut: min(işlem başı ${limits.maxPerTradeUsdt}, kalan bütçe ${budgetLeft.toFixed(2)}, varlığın %${(limits.reduceFraction * 100).toFixed(0)}'i ${(holdingUsdt * limits.reduceFraction).toFixed(2)}) × ${sizeFactor} = ${target.toFixed(2)} USDT`,
  );
  const qty = floorToLot(target / input.price, lotSz);
  const maxQty = floorToLot(input.balance.available, lotSz);
  if (qty.units > maxQty.units) return reject("REDUCE", r, "emir bakiyeyi aşıyor");
  if (qty.units <= 0n || !atLeast(qty.text, minSz)) return reject("REDUCE", r, `miktar ${qty.text} ${baseCcy} minimum ${minSz} altında`);
  if (!DECIMAL.test(qty.text)) return reject("REDUCE", r, "miktar biçimi geçersiz");

  const order: ValidatedOrder = {
    instId,
    side: "sell",
    ordType: "market",
    tdMode: "cash",
    sz: qty.text,
    notionalUsdt: Number((Number(qty.text) * input.price).toFixed(2)),
    opensRisk: false,
  };

  // 7) Stop-loss yalnızca yeni risk açan emirlere zorunlu; azaltma risk açmaz.
  if (order.opensRisk && !order.stopLoss) return reject("REDUCE", r, "yeni risk açan emirde stop-loss zorunlu");
  r.push("Azaltma emri risk açmaz → stop-loss gerekmez");
  r.push(`ONAY: ${order.sz} ${baseCcy} sat (~${order.notionalUsdt} USDT), bakiye ${input.balance.available} ${baseCcy}${input.balance.source === "mock" ? " [SAHTE BAKİYE]" : ""}`);
  return { action: "REDUCE", approved: true, order, reasons: r };
}

// Demo: npx tsx src/risk.ts
if (isMain(import.meta.url)) {
  const base: RiskInput = {
    symbol: "BTC-USDT",
    type: "price_drop",
    level: "YUKSEK",
    price: 80000,
    balance: { ccy: "BTC", available: 0.05, source: "mock" },
    instrument: { instId: "BTC-USDT", lotSz: "0.00000001", minSz: "0.00001" },
    state: { date: "2026-10-17", spentTodayUsdt: 0, totalSpentUsdt: 0, realizedLossTodayUsdt: 0 },
    killSwitch: { on: false, reason: "kapalı" },
    limits: limitsFromConfig(),
  };
  const show = (name: string, d: RiskDecision) =>
    log.stage("RİSK", `${name}: ${d.action} ${d.approved ? "ONAY" : "ret/yok"} | ${d.reasons.join(" | ")}`);
  show("yüksek", evaluateRisk(base));
  show("orta", evaluateRisk({ ...base, level: "ORTA" }));
  show("belirsiz", evaluateRisk({ ...base, level: "BELIRSIZ" }));
  show("spike", evaluateRisk({ ...base, type: "price_spike" }));
  show("kill", evaluateRisk({ ...base, killSwitch: { on: true, reason: "KILL_SWITCH=1" } }));
  show("izinsiz çift", evaluateRisk({ ...base, symbol: "DOGE-USDT" }));
  show("bakiye yok", evaluateRisk({ ...base, balance: null }));
  show("bütçe dolu", evaluateRisk({ ...base, state: { ...base.state, totalSpentUsdt: 1000 } }));
}
