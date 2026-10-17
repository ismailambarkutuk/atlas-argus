// Uçtan uca akış:
// collector → stats (robust z) ── tetik? ──┬→ ATLAS ─┐
//                                          └→ ARGUS ─┴→ commit → reveal → compare → risk → execute → report
//
// Örnek: npx tsx src/main.ts --replay recordings/BTC-USDT_demo.jsonl --inject drop --cached
// Sürekli izleme: npx tsx src/main.ts --watch --symbol BTC-USDT  (Ctrl+C ile durur)
import path from "node:path";
import { config, isDryRun, killSwitchStatus } from "./config.js";
import { ROOT, log, parseArgs, errMsg } from "./util.js";
import { appendCandles, fetchClosedCandles, fetchTickerPrice, writeRecording } from "./data/collector.js";
import { loadRecording } from "./data/replay.js";
import { SCENARIOS, injectScenario, isScenario } from "./data/inject.js";
import { Candle, roundIdFor, windowEnding } from "./data/types.js";
import { computeSignals, minIndex, type Signals } from "./stats/robustZ.js";
import { runAtlas, runAtlasDispute } from "./agents/atlas.js";
import { runArgus } from "./agents/argus.js";
import type { AgentMode } from "./agents/cache.js";
import type { AgentInput, AgentOutcome } from "./agents/schema.js";
import { createSealProvider, makeSealRecord, sealAndReveal, type SealOutcome, type SealProvider } from "./chain/seal.js";
import { LEVEL_TR, compareInitial, resolveDispute, type CompareResult } from "./compare.js";
import { evaluateRisk, limitsFromConfig, type Balance } from "./risk.js";
import { executeDecision, loadRiskState, readBalance, readInstrument } from "./execute.js";
import { printSummary, writeReport, type RoundReport } from "./report/report.js";

interface RunContext {
  mode: AgentMode;
  seal: SealProvider;
  fromReplay: boolean;
}

function printAgent(o: AgentOutcome): void {
  const tag = o.cached ? " [KAYITLI YANIT]" : "";
  const phase = o.phase === "dispute" ? " (uyuşmazlık turu)" : "";
  if (o.ok && o.finding) {
    const f = o.finding;
    log.agent(o.agent, `${f.type}/${f.direction}${phase} şiddet ${f.severity} uyum beyanı ${f.confidence}${tag} — ${f.explanation}`);
  } else {
    log.warn(o.agent, `BELİRSİZ${phase}${tag}: ${o.errors.join("; ")}`);
  }
}

function belirsiz(reason: string): CompareResult {
  return { level: "BELIRSIZ", overlap: false, statConfirmed: false, disagreement: [], needsDispute: false, reasons: [reason] };
}

async function runRound(candles: Candle[], i: number, signals: Signals, ctx: RunContext): Promise<RoundReport> {
  const c = candles[i];
  const window = windowEnding(candles, i, config.statsWindow);
  const input: AgentInput = { round_id: roundIdFor(c), symbol: c.symbol, window };
  const uncertainties: string[] = [];
  const injectedIds = window.filter((w) => w.injected).map((w) => w.record_id);

  log.stage("TUR", `${input.round_id} başladı · pencere ${window.length} mum (${window[0].iso} → ${c.iso})`);
  if (injectedIds.length) log.warn("ENJEKTE", `pencerede ${injectedIds.length} yapay kayıt var: ${injectedIds.join(", ")}`);

  // Paralel ve birbirinden habersiz: iki ayrı çağrı, ikisine de yalnızca ham pencere
  log.stage("AGENT", "ATLAS ve ARGUS paralel başlatılıyor (aynı ham veri, birbirinden habersiz)");
  const [atlas, argus] = await Promise.all([runAtlas(input, ctx.mode), runArgus(input, ctx.mode)]);
  printAgent(atlas);
  printAgent(argus);
  const agents: AgentOutcome[] = [atlas, argus];
  for (const a of [atlas, argus]) if (!a.ok) uncertainties.push(`${a.agent} geçerli bulgu üretmedi: ${a.errors.join("; ")}`);

  let seal: SealOutcome | undefined;
  let disputeSeal: SealOutcome | undefined;
  let compare: CompareResult;

  if (atlas.finding && argus.finding) {
    log.stage("MÜHÜR", `${ctx.seal.name}: iki bulgu commit ediliyor`);
    seal = await sealAndReveal(ctx.seal, [makeSealRecord(atlas.finding, "initial"), makeSealRecord(argus.finding, "initial")]);
    if (!seal.ok) {
      compare = belirsiz(`Mühür tamamlanamadı (${seal.error}); mühürsüz karşılaştırma yapılmaz → belirsiz`);
      uncertainties.push(compare.reasons[0]);
    } else {
      compare = compareInitial(atlas.finding, argus.finding, signals);
      if (compare.needsDispute) {
        log.warn("KARŞILAŞTIRMA", compare.reasons[0]);
        const dispute = await runAtlasDispute(input, atlas, compare.disagreement, ctx.mode);
        printAgent(dispute);
        agents.push(dispute);
        let newAtlas = dispute.finding ?? null;
        if (!dispute.ok) uncertainties.push(`Uyuşmazlık turunda ATLAS geçersiz: ${dispute.errors.join("; ")}`);
        if (newAtlas) {
          disputeSeal = await sealAndReveal(ctx.seal, [makeSealRecord(newAtlas, "dispute")]);
          if (!disputeSeal.ok) {
            uncertainties.push(`Uyuşmazlık turu mühürlenemedi (${disputeSeal.error})`);
            newAtlas = null;
          }
        }
        const prior = compare.reasons;
        compare = resolveDispute(atlas.finding, newAtlas, argus.finding, signals);
        compare.reasons = [...prior, ...compare.reasons];
      }
    }
  } else {
    compare = compareInitial(atlas.finding ?? null, argus.finding ?? null, signals);
  }
  for (const reason of compare.reasons) log.info("KARŞILAŞTIRMA", reason);
  (compare.level === "BELIRSIZ" ? log.warn : log.ok)("KARŞILAŞTIRMA", `Uyum seviyesi: ${LEVEL_TR[compare.level].toLocaleUpperCase("tr-TR")}`);
  if (compare.level === "BELIRSIZ") uncertainties.push("Uyum belirsiz → kural gereği işlem yapılmaz");

  // Risk girdileri yalnızca azaltma adayı varsa okunur
  const type = compare.level === "BELIRSIZ" ? null : (compare.agreed?.type ?? null);
  let price: RoundReport["price"];
  let balance: Balance | null = null;
  let instrument = null;
  if (type === "price_drop") {
    if (ctx.fromReplay) {
      price = { value: c.close, source: c.injected ? "replay son kapanış (ENJEKTE)" : "replay son kapanış" };
    } else {
      try {
        price = { value: await fetchTickerPrice(c.symbol), source: "okx ticker" };
      } catch (e) {
        uncertainties.push(`Fiyat alınamadı: ${errMsg(e)}`);
      }
    }
    balance = await readBalance(c.symbol.split("-")[0]);
    instrument = await readInstrument(c.symbol);
    if (balance.source === "mock") uncertainties.push("Bakiye SAHTE (mock); gerçek bakiye okuması henüz bağlı değil");
  }

  const kill = killSwitchStatus();
  const risk = evaluateRisk({
    symbol: c.symbol,
    type,
    level: compare.level,
    price: price?.value ?? null,
    balance,
    instrument,
    state: loadRiskState(),
    killSwitch: kill,
    limits: limitsFromConfig(),
  });
  for (const reason of risk.reasons) log.info("RİSK", reason);
  const exec = await executeDecision(risk, balance);

  if (atlas.cached || argus.cached) uncertainties.push("Agent yanıtları KAYITLI YANIT'tan oynatıldı (canlı LLM çağrısı yapılmadı)");
  if (c.injected) uncertainties.push(`Tetik mumu ENJEKTE (yapay senaryo: ${c.inject_scenario})`);

  const report: RoundReport = {
    round_id: input.round_id,
    symbol: c.symbol,
    created_at: new Date().toISOString(),
    trigger: { record_id: c.record_id, iso: c.iso, injected: !!c.injected, scenario: c.inject_scenario },
    signals,
    windowSize: window.length,
    injectedRecordIds: injectedIds,
    agents,
    seal,
    disputeSeal,
    compare,
    price,
    balance,
    risk,
    exec,
    uncertainties,
    flags: { dryRun: exec.dryRun, killSwitch: kill.reason, cached: ctx.mode === "cached", sealProvider: ctx.seal.name },
  };
  const files = writeReport(report);
  printSummary(report, files);
  return report;
}

/**
 * Sürekli izleme: her dakika yeni kapanmış mumu çeker ve kontrol eder. Ctrl+C veya
 * kill switch ile durur. Korumalar: tur sonrası bekleme süresi, oturum başına tur tavanı.
 */
async function watch(symbol: string, mode: AgentMode): Promise<void> {
  const cooldownMs = config.watchCooldownMin * 60_000;
  const maxRounds = Math.floor(config.watchMaxRounds);
  let stopping = false;
  let wake: (() => void) | undefined;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130); // ikinci Ctrl+C: hemen çık
    stopping = true;
    log.warn("İZLEME", "Ctrl+C alındı → oturum kapanıyor (devam eden tur varsa bitmesi bekleniyor; hemen çıkmak için tekrar Ctrl+C)");
    wake?.();
  });
  // Bir sonraki dakikanın 5. saniyesine kadar bekle (mumun kapanıp borsada onaylanması için pay)
  const sleepToNextMinute = () =>
    new Promise<void>((resolve) => {
      const ms = 60_000 - (Date.now() % 60_000) + 5_000;
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  let candles = await fetchClosedCandles(symbol, 300);
  const file = writeRecording(candles, path.join(ROOT, "recordings", `${symbol}_watch_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.jsonl`));
  log.stage("İZLEME", `${symbol} izleniyor · başlangıç ${candles.length} mum → ${path.relative(ROOT, file)}`);
  log.stage("İZLEME", `Korumalar: tur sonrası ${config.watchCooldownMin} dk bekleme, oturum başına en fazla ${maxRounds} LLM turu. Durdurmak için Ctrl+C`);

  const seal = createSealProvider();
  let rounds = 0;
  let triggers = 0;
  let minutes = 0;
  let lastRoundAt = -Infinity;

  while (!stopping) {
    const kill = killSwitchStatus();
    if (kill.on) {
      log.error("İZLEME", `KILL SWITCH AÇIK (${kill.reason}) → izleme durduruldu`);
      break;
    }
    try {
      const lastTs = candles[candles.length - 1].ts;
      const fresh = (await fetchClosedCandles(symbol, 20)).filter((c) => c.ts > lastTs);
      if (fresh.length === 0) {
        log.info("İZLEME", "yeni kapanmış mum yok (borsa henüz onaylamadı), sonraki dakika tekrar bakılacak");
      } else {
        appendCandles(file, fresh);
        candles = [...candles, ...fresh].slice(-300);
        minutes += fresh.length;
        if (fresh.length > 1) log.warn("İZLEME", `${fresh.length - 1} mum kaçırılmıştı; yalnızca en yenisi tura aday (eskiler bayat)`);
        const i = candles.length - 1;
        const s = computeSignals(candles, i);
        const zs = `fiyat z=${s.priceZ.toFixed(2)}, hacim z=${s.volZ.toFixed(2)}`;
        if (!s.triggered) {
          log.ok("İZLEME", `${candles[i].iso.slice(11, 16)} UTC · ${zs} · normal → LLM yok`);
        } else {
          triggers++;
          const sinceMs = Date.now() - lastRoundAt;
          if (sinceMs < cooldownMs) {
            log.warn("İZLEME", `${candles[i].iso.slice(11, 16)} UTC · TETİK (${s.triggerReasons.join(", ")}) ama bekleme süresinde (${Math.max(1, Math.round((cooldownMs - sinceMs) / 60_000))} dk kaldı) → LLM çağrılmadı`);
          } else if (rounds >= maxRounds) {
            log.warn("İZLEME", `${candles[i].iso.slice(11, 16)} UTC · TETİK ama oturum tur tavanı (${maxRounds}) doldu → LLM çağrılmadı`);
          } else {
            rounds++;
            lastRoundAt = Date.now();
            log.stage("İSTATİSTİK", `TETİK ${s.record_id}: ${zs} (${s.triggerReasons.join(", ")}) → tur ${rounds}/${maxRounds}`);
            await runRound(candles, i, s, { mode, seal, fromReplay: false });
          }
        }
      }
    } catch (e) {
      // Ağ/borsa hatası: çökme, logla ve bir sonraki dakikada tekrar dene
      log.error("İZLEME", `bu dakika atlandı: ${errMsg(e)}`);
    }
    if (!stopping) await sleepToNextMinute();
  }
  log.banner([
    `İZLEME OTURUMU BİTTİ · ${symbol}`,
    `İzlenen yeni mum: ${minutes} · tetik: ${triggers} · LLM turu: ${rounds}/${maxRounds}`,
    `Kayıt: ${path.relative(ROOT, file)}`,
  ]);
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("kill")) process.env.KILL_SWITCH = "1";
  const mode: AgentMode = flags.has("cached") ? "cached" : flags.has("record-agents") ? "record" : "call";
  const scenario = values.get("inject");
  if (scenario !== undefined && !isScenario(scenario)) {
    throw new Error(`bilinmeyen senaryo "${scenario}"; seçenekler: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  const replayFile = values.get("replay");
  if (scenario && !replayFile) throw new Error("--inject yalnızca --replay ile kullanılır");
  if (flags.has("watch")) {
    if (replayFile) throw new Error("--watch anlık veriyle çalışır; --replay ile birlikte kullanılmaz");
    if (mode === "cached") throw new Error("--watch ile --cached kullanılmaz (anlık veride kayıtlı yanıt olamaz)");
    const symbol = (values.get("symbol") ?? "BTC-USDT").toUpperCase();
    const kill = killSwitchStatus();
    log.banner([
      "ATLAS–ARGUS · SÜREKLİ İZLEME (--watch)",
      `Sembol: ${symbol} · veri: OKX anlık, her dakika`,
      `DRY_RUN: ${isDryRun() ? "AÇIK — emir gönderilmez" : "KAPALI — demo hesaba emir gidebilir"}`,
      `Kill switch: ${kill.on ? `AÇIK (${kill.reason})` : "kapalı"}`,
    ]);
    return watch(symbol, mode);
  }
  const maxRounds = Number(values.get("max-rounds") ?? 1);
  const kill = killSwitchStatus();

  log.banner([
    "ATLAS–ARGUS · Bağımsız doğrulamalı kripto koruma agent'ı",
    `Veri: ${replayFile ? `REPLAY ${replayFile}` : "OKX piyasa verisi (anlık)"}${scenario ? ` + ENJEKTE: ${scenario}` : ""}`,
    `Agent modu: ${mode === "cached" ? "KAYITLI YANIT" : mode === "record" ? "çağır + kaydet" : "çağır"}`,
    `DRY_RUN: ${isDryRun() ? "AÇIK — emir gönderilmez" : "KAPALI — demo hesaba emir gidebilir"}`,
    `Kill switch: ${kill.on ? `AÇIK (${kill.reason}) — hiçbir emir gitmez` : "kapalı"}`,
  ]);

  // 1) Veri
  let candles: Candle[];
  let symbol: string;
  if (replayFile) {
    candles = loadRecording(path.resolve(replayFile)).candles;
    symbol = candles[0]?.symbol ?? "?";
    log.stage("VERİ", `replay: ${candles.length} kapanmış 1m mum (${symbol})`);
  } else {
    symbol = (values.get("symbol") ?? "BTC-USDT").toUpperCase();
    candles = await fetchClosedCandles(symbol, 300);
    const f = writeRecording(candles);
    log.stage("VERİ", `${candles.length} kapanmış 1m mum alındı ve kaydedildi → ${path.relative(ROOT, f)}`);
  }
  if (scenario) {
    candles = injectScenario(candles, scenario);
    log.warn("ENJEKTE", `${SCENARIOS[scenario]} → ${candles[candles.length - 1].record_id}`);
  }
  if (candles.length <= minIndex()) throw new Error(`en az ${minIndex() + 1} mum gerekli, ${candles.length} var`);

  // 2) İstatistik taraması: enjeksiyonda ve anlık modda yalnızca son mum; replay'de tüm mumlar
  const last = candles.length - 1;
  const scanAll = !!replayFile && !scenario;
  const indices = scanAll ? Array.from({ length: candles.length - minIndex() }, (_, k) => minIndex() + k) : [last];
  const seal = createSealProvider();
  let rounds = 0;
  let triggers = 0;
  for (const i of indices) {
    const s = computeSignals(candles, i);
    if (!s.triggered) continue;
    triggers++;
    log.stage(
      "İSTATİSTİK",
      `TETİK ${s.record_id}${candles[i].injected ? " [ENJEKTE]" : ""}: fiyat z=${s.priceZ.toFixed(2)}, hacim z=${s.volZ.toFixed(2)} (${s.triggerReasons.join(", ")})`,
    );
    if (rounds >= maxRounds) continue;
    rounds++;
    await runRound(candles, i, s, { mode, seal, fromReplay: !!replayFile });
  }
  if (triggers === 0) {
    const s = computeSignals(candles, last);
    log.ok("İSTATİSTİK", `tetik yok (son mum fiyat z=${s.priceZ.toFixed(2)}, hacim z=${s.volZ.toFixed(2)}) → LLM çağrılmadı, işlem yok`);
  } else if (triggers > rounds) {
    log.info("İSTATİSTİK", `${triggers} tetikten ${rounds} tanesi işlendi (--max-rounds ${maxRounds})`);
  }
}

main().catch((e) => {
  log.error("ANA", `beklenmeyen hata: ${errMsg(e)} → işlem yapılmadı`);
  process.exitCode = 1;
});
