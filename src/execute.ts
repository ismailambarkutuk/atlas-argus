// Aksiyon: risk motorunun onayladığı emri OKX'te uygular. Varsayılan DRY_RUN=1:
// emir hazırlanır, gösterilir, loglanır ama GÖNDERİLMEZ.
// Hesap türü OKX_ACCOUNT ile seçilir: demo (simülasyon; demo anahtarı olmadığı için bakiye
// SAHTE) veya real (yalnızca bu iş için fonlanmış izole hesap; bakiye ATK ile okunur).
import fs from "node:fs";
import path from "node:path";
import { accountLabel, config, isDryRun, killSwitchStatus } from "./config.js";
import { runOkx } from "./okx.js";
import { ROOT, log, isMain } from "./util.js";
import type { Balance, Instrument, RiskDecision, RiskState, ValidatedOrder } from "./risk.js";

export type ExecStatus = "SKIPPED" | "DRY_RUN" | "BLOCKED_KILL" | "REJECTED" | "SENT" | "FAILED";

export interface ExecResult {
  status: ExecStatus;
  dryRun: boolean;
  args?: string[];
  ordId?: string;
  message: string;
}

const STATE_FILE = path.join(ROOT, "state", "risk-state.json");
const INSTRUMENT_CACHE = path.join(ROOT, "recordings", "instruments.json");

// --- Hesap seçimi ---

/** Hesap türüne göre ATK global bayrakları: demo → --demo, real → bayrak yok. */
export function accountFlags(): string[] {
  return config.okxAccount === "demo" ? ["--demo"] : [];
}

// --- Bakiye ---

/** Demo hesap anahtarı olmadığı için demo modda kullanılan sabit sahte bakiyeler. */
const MOCK_BALANCES: Record<string, number> = { BTC: 0.05, ETH: 1.5, USDT: 1000 };

/**
 * Bakiye okuma. real modda ATK ile gerçekten okunur (`okx account balance <ccy>`);
 * demo modda SAHTE değer döner (source: "mock"). Okunamazsa null → risk motoru reddeder.
 */
export async function readBalance(ccy: string): Promise<Balance | null> {
  if (config.okxAccount === "demo") {
    const available = MOCK_BALANCES[ccy] ?? 0;
    log.warn("BAKİYE", `SAHTE BAKİYE kullanılıyor: ${available} ${ccy} (demo hesap anahtarı yok)`);
    return { ccy, available, source: "mock" };
  }
  const r = await runOkx([...accountFlags(), "account", "balance", ccy]);
  const row = Array.isArray(r.data) ? (r.data[0] as { details?: { ccy?: string; availBal?: string }[] } | undefined) : undefined;
  const detail = row?.details?.find((x) => x.ccy === ccy);
  // Bakiye hiç yoksa OKX o para biriminin satırını döndürmeyebilir: bu 0 demektir
  const available = detail ? Number(detail.availBal) : r.ok && Array.isArray(row?.details) ? 0 : NaN;
  if (!r.ok || !Number.isFinite(available)) {
    log.error("BAKİYE", `bakiye okunamadı → emir yok: ${r.error ?? "beklenmeyen yanıt biçimi"}`);
    return null;
  }
  log.info("BAKİYE", `${accountLabel()}: ${available} ${ccy} kullanılabilir`);
  return { ccy, available, source: "okx" };
}

// --- Enstrüman bilgisi (halka açık piyasa verisi) ---

export async function readInstrument(instId: string): Promise<Instrument | null> {
  const r = await runOkx(["market", "instruments", "--instType", "SPOT", "--instId", instId]);
  const row = Array.isArray(r.data) ? (r.data[0] as Partial<Instrument> | undefined) : undefined;
  if (r.ok && row?.instId === instId && typeof row.lotSz === "string" && typeof row.minSz === "string") {
    const inst = { instId, lotSz: row.lotSz, minSz: row.minSz };
    try {
      const all = fs.existsSync(INSTRUMENT_CACHE) ? JSON.parse(fs.readFileSync(INSTRUMENT_CACHE, "utf8")) : {};
      all[instId] = inst;
      fs.mkdirSync(path.dirname(INSTRUMENT_CACHE), { recursive: true });
      fs.writeFileSync(INSTRUMENT_CACHE, JSON.stringify(all, null, 2), "utf8");
    } catch {
      // önbellek yazılamazsa önemli değil
    }
    return inst;
  }
  // Ağ yoksa son bilinen enstrüman bilgisi (replay demosu için)
  try {
    const cached = JSON.parse(fs.readFileSync(INSTRUMENT_CACHE, "utf8"))[instId];
    if (cached) {
      log.warn("ENSTRÜMAN", `canlı bilgi alınamadı (${r.error}); kayıtlı lot bilgisi kullanılıyor`);
      return cached as Instrument;
    }
  } catch {
    // yok
  }
  log.error("ENSTRÜMAN", `lot bilgisi alınamadı: ${r.error}`);
  return null;
}

// --- Risk durumu (bütçe/günlük takip) ---

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadRiskState(): RiskState {
  const fresh: RiskState = { date: today(), spentTodayUsdt: 0, totalSpentUsdt: 0, realizedLossTodayUsdt: 0 };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RiskState;
    if (s.date !== today()) return { ...fresh, totalSpentUsdt: s.totalSpentUsdt };
    return s;
  } catch {
    return fresh;
  }
}

function recordSpend(notional: number): void {
  const s = loadRiskState();
  s.spentTodayUsdt += notional;
  s.totalSpentUsdt += notional;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// --- Emir ---

/** Argümanlar yalnızca risk.ts'in doğrulanmış emrinden kurulur. Hesap türü her çağrıda açıkça seçilir. */
export function buildOrderArgs(o: ValidatedOrder): string[] {
  return [...accountFlags(), "spot", "place", "--instId", o.instId, "--side", o.side, "--ordType", o.ordType, "--sz", o.sz, "--tdMode", o.tdMode];
}

/**
 * Çalışma anı güvenlik kontrolü (kural 1): "live" içeren argüman → ret. Argüman yapısı
 * seçili hesap türüyle birebir uyuşmalı: demo'da başta tek bir --demo, real'de hiç yok.
 */
export function assertSafeOrderArgs(args: string[]): void {
  const bad = args.find((a) => a.toLowerCase().includes("live"));
  if (bad !== undefined) throw new Error(`emir reddedildi: yasaklı argüman "${bad}"`);
  const demoCount = args.filter((a) => a === "--demo").length;
  if (config.okxAccount === "demo" && (args[0] !== "--demo" || demoCount !== 1)) throw new Error("emir reddedildi: demo modu açıkça seçilmemiş");
  if (config.okxAccount === "real" && (demoCount !== 0 || args[0] !== "spot")) throw new Error("emir reddedildi: beklenmeyen argüman yapısı");
}

export async function executeDecision(decision: RiskDecision, balance: Balance | null): Promise<ExecResult> {
  const dryRun = isDryRun();
  if (!decision.approved || !decision.order) {
    const message = decision.action === "ALERT" ? "Yalnızca uyarı; emir yok" : "Risk motoru onaylamadı; emir yok";
    log.info("EMİR", message);
    return { status: "SKIPPED", dryRun, message };
  }

  // Kill switch emir anında yeniden kontrol edilir
  const kill = killSwitchStatus();
  if (kill.on) {
    log.error("EMİR", `KILL SWITCH AÇIK (${kill.reason}) → hiçbir emir gönderilmez`);
    return { status: "BLOCKED_KILL", dryRun, message: `kill switch: ${kill.reason}` };
  }

  const args = buildOrderArgs(decision.order);
  try {
    assertSafeOrderArgs(args);
  } catch (e) {
    log.error("EMİR", (e as Error).message);
    return { status: "REJECTED", dryRun, args, message: (e as Error).message };
  }

  const shown = `okx ${args.join(" ")}`;
  if (dryRun) {
    log.warn("EMİR", `DRY_RUN=1 → emir HAZIRLANDI ama GÖNDERİLMEDİ: ${shown}`);
    return { status: "DRY_RUN", dryRun, args, message: "DRY_RUN: gönderilmedi" };
  }

  if (!balance || balance.source === "mock") {
    const message = "SAHTE BAKİYE ile emir gönderilmez; gerçek bakiye için OKX_ACCOUNT=real ve hesap anahtarı gerekli";
    log.error("EMİR", message);
    return { status: "REJECTED", dryRun, args, message };
  }

  log.stage("EMİR", `${accountLabel()} → gönderiliyor: ${shown}`);
  const r = await runOkx(args, { timeoutMs: 30000 });
  if (!r.ok) {
    log.error("EMİR", `gönderim başarısız → belirsiz: ${r.error}`);
    return { status: "FAILED", dryRun, args, message: r.error ?? "bilinmeyen hata" };
  }
  const row = Array.isArray(r.data) ? (r.data[0] as { ordId?: string; sCode?: string; sMsg?: string } | undefined) : undefined;
  if (!row?.ordId || (row.sCode !== undefined && row.sCode !== "0")) {
    log.error("EMİR", `borsa emri kabul etmedi: ${row?.sMsg ?? "yanıtta ordId yok"}`);
    return { status: "FAILED", dryRun, args, message: row?.sMsg ?? "ordId yok" };
  }
  recordSpend(decision.order.notionalUsdt);
  log.ok("EMİR", `emir gönderildi (${accountLabel()}), ordId ${row.ordId}`);
  return { status: "SENT", dryRun, args, ordId: row.ordId, message: "gönderildi" };
}

// Demo: npx tsx src/execute.ts  → onaylı örnek kararla DRY_RUN akışı
if (isMain(import.meta.url)) {
  const { evaluateRisk, limitsFromConfig } = await import("./risk.js");
  const balance = await readBalance("BTC");
  const instrument = await readInstrument("BTC-USDT");
  const decision = evaluateRisk({
    symbol: "BTC-USDT",
    type: "price_drop",
    level: "YUKSEK",
    price: 80000,
    balance,
    instrument,
    state: loadRiskState(),
    killSwitch: killSwitchStatus(),
    limits: limitsFromConfig(),
  });
  for (const reason of decision.reasons) log.info("RİSK", reason);
  const res = await executeDecision(decision, balance);
  log.stage("EMİR", `sonuç: ${res.status} — ${res.message}`);
}
