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

/**
 * LLM sağlayıcıları. OpenAI uyumlu olanlar (openai, gemini, groq) aynı istemciden geçer.
 * Her sağlayıcının anahtarı kendi değişkeninden okunur.
 */
export const PROVIDERS = {
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", baseURL: undefined, defaultModel: "claude-haiku-5-5" },
  openai: { keyEnv: "OPENAI_API_KEY", baseURL: undefined, defaultModel: "" },
  gemini: { keyEnv: "GEMINI_API_KEY", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-3.5-flash" },
  groq: { keyEnv: "GROQ_API_KEY", baseURL: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-120b" },
} as const;
export type ProviderName = keyof typeof PROVIDERS;
export const SECRET_ENV_NAMES = [...new Set(Object.values(PROVIDERS).map((p) => p.keyEnv)), "AVAX_PRIVATE_KEY"];

function provider(name: string, def: ProviderName): ProviderName {
  const v = str(name, def).toLowerCase();
  if (!(v in PROVIDERS)) throw new Error(`Yapılandırma hatası: ${name}="${v}"; seçenekler: ${Object.keys(PROVIDERS).join(", ")}`);
  return v as ProviderName;
}

export interface AgentLlm {
  provider: ProviderName;
  model: string;
  apiKey: string;
  keyEnv: string;
  baseURL?: string;
}

function agentLlm(prefix: "ATLAS" | "ARGUS", def: ProviderName): AgentLlm {
  const p = provider(`${prefix}_PROVIDER`, def);
  const spec = PROVIDERS[p];
  return { provider: p, model: str(`${prefix}_MODEL`) || spec.defaultModel, apiKey: str(spec.keyEnv), keyEnv: spec.keyEnv, baseURL: spec.baseURL };
}

export const config = Object.freeze({
  atlas: agentLlm("ATLAS", "anthropic"),
  argus: agentLlm("ARGUS", "openai"),
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

  // --watch: bir turdan sonra yeni tur açılmadan beklenen süre ve oturum başına en fazla tur
  watchCooldownMin: positive("WATCH_COOLDOWN_MIN", 10),
  watchMaxRounds: positive("WATCH_MAX_ROUNDS", 10),
});

if (config.reduceFraction > 1) throw new Error("Yapılandırma hatası: REDUCE_FRACTION 0 ile 1 arasında olmalı");

for (const k of SECRET_ENV_NAMES) registerSecret(str(k));

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
  for (const [name, a] of [["ATLAS", config.atlas], ["ARGUS", config.argus]] as const) {
    log.stage("CONFIG", `${name}: ${a.provider} / ${a.model || "(model yok)"} | ${a.keyEnv}: ${a.apiKey ? "var" : "YOK"}`);
  }
  if (config.atlas.provider === config.argus.provider) log.warn("CONFIG", "ATLAS ve ARGUS aynı sağlayıcıda: bağımsızlık zayıflar");
  log.stage("CONFIG", `Mühür: ${config.sealProvider} | cüzdan anahtarı: ${config.avaxPrivateKey ? "var" : "YOK"}`);
  log.stage(
    "CONFIG",
    `Bütçe ${config.totalBudgetUsdt} USDT, işlem başı ${config.maxPerTradeUsdt}, günlük zarar ${config.maxDailyLossUsdt}, çiftler ${config.allowedPairs.join(",")}`,
  );
}
