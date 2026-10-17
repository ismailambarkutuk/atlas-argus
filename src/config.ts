// Tüm ayarlar .env'den okunur; kodda limit sabit yazılmaz.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT, registerSecret, isMain, log } from "./util.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

function str(name: string, def = ""): string {
  const v = process.env[name];
  return v === undefined ? def : v.trim();
}

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Yapılandırma hatası: ${name}="${raw}" bir sayı değil`);
  return v;
}

function positive(name: string, def: number): number {
  const v = num(name, def);
  if (v <= 0) throw new Error(`Yapılandırma hatası: ${name} pozitif olmalı (şu an ${v})`);
  return v;
}

export const config = Object.freeze({
  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  openaiApiKey: str("OPENAI_API_KEY"),
  atlasModel: str("ATLAS_MODEL", "claude-haiku-5-5"),
  argusModel: str("ARGUS_MODEL"),
  llmTimeoutMs: positive("LLM_TIMEOUT_MS", 45000),

  avaxRpcUrl: str("AVAX_RPC_URL", "https://api.avax-test.network/ext/bc/C/rpc"),
  avaxPrivateKey: str("AVAX_PRIVATE_KEY"),
  sealProvider: str("SEAL_PROVIDER", "selftx").toLowerCase(),
  chainTimeoutMs: positive("CHAIN_TIMEOUT_MS", 60000),
  fujiChainId: 43113,

  totalBudgetUsdt: positive("TOTAL_BUDGET_USDT", 1000),
  maxPerTradeUsdt: positive("MAX_PER_TRADE_USDT", 100),
  maxDailyLossUsdt: positive("MAX_DAILY_LOSS_USDT", 50),
  allowedPairs: str("ALLOWED_PAIRS", "BTC-USDT,ETH-USDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  reduceFraction: positive("REDUCE_FRACTION", 0.25),
  minConfidence: positive("MIN_CONFIDENCE", 0.7),

  statsWindow: positive("STATS_WINDOW", 60),
  // Tetik ve istatistik onayı eşikleri (CLAUDE.md)
  triggerPriceZ: positive("TRIGGER_PRICE_Z", 2),
  triggerVolumeZ: positive("TRIGGER_VOLUME_Z", 3),
  confirmPriceZ: positive("CONFIRM_PRICE_Z", 3),
  confirmVolumeZ: positive("CONFIRM_VOLUME_Z", 2),
});

if (config.reduceFraction > 1) throw new Error("Yapılandırma hatası: REDUCE_FRACTION 0 ile 1 arasında olmalı");

registerSecret(config.anthropicApiKey);
registerSecret(config.openaiApiKey);
registerSecret(config.avaxPrivateKey);

/** DRY_RUN her çağrıda ortamdan okunur. Yalnızca tam olarak "0" gerçek (demo) emre izin verir. */
export function isDryRun(): boolean {
  return (process.env.DRY_RUN ?? "1").trim() !== "0";
}

export const KILL_FILE = path.join(ROOT, "KILL");

/** Kill switch çalışma anında kontrol edilir: KILL_SWITCH=1 veya proje kökünde KILL dosyası. */
export function killSwitchStatus(): { on: boolean; reason: string } {
  if ((process.env.KILL_SWITCH ?? "0").trim() === "1") return { on: true, reason: "KILL_SWITCH=1" };
  if (fs.existsSync(KILL_FILE)) return { on: true, reason: "proje kökünde KILL dosyası var" };
  return { on: false, reason: "kapalı" };
}

if (isMain(import.meta.url)) {
  log.stage("CONFIG", `DRY_RUN: ${isDryRun() ? "AÇIK (emir gönderilmez)" : "KAPALI (demo emir gönderilebilir)"}`);
  log.stage("CONFIG", `Kill switch: ${killSwitchStatus().reason}`);
  log.stage("CONFIG", `ATLAS modeli: ${config.atlasModel || "(yok)"} | anahtar: ${config.anthropicApiKey ? "var" : "YOK"}`);
  log.stage("CONFIG", `ARGUS modeli: ${config.argusModel || "(yok)"} | anahtar: ${config.openaiApiKey ? "var" : "YOK"}`);
  log.stage("CONFIG", `Mühür: ${config.sealProvider} | cüzdan anahtarı: ${config.avaxPrivateKey ? "var" : "YOK"}`);
  log.stage(
    "CONFIG",
    `Bütçe ${config.totalBudgetUsdt} USDT, işlem başı ${config.maxPerTradeUsdt}, günlük zarar ${config.maxDailyLossUsdt}, çiftler ${config.allowedPairs.join(",")}`,
  );
}
