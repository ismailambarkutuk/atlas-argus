// atlas.ts / argus.ts tek başına çalıştırıldığında kullanılan küçük demo girişi.
import path from "node:path";
import { config } from "../config.js";
import { log, parseArgs } from "../util.js";
import { loadRecording } from "../data/replay.js";
import { injectScenario, isScenario } from "../data/inject.js";
import { roundIdFor, windowEnding } from "../data/types.js";
import type { AgentMode } from "./cache.js";
import type { AgentInput, AgentOutcome } from "./schema.js";

export function demoInput(argv: string[]): AgentInput {
  const file = argv.find((a) => !a.startsWith("--") && a.endsWith(".jsonl"));
  if (!file) {
    log.error("DEMO", "Kullanım: <kayit.jsonl> [--inject <senaryo>] [--cached|--record-agents]");
    process.exit(1);
  }
  let { candles } = loadRecording(path.resolve(file));
  const sc = parseArgs(argv).values.get("inject");
  if (sc && isScenario(sc)) candles = injectScenario(candles, sc);
  const last = candles[candles.length - 1];
  return { round_id: roundIdFor(last), symbol: last.symbol, window: windowEnding(candles, candles.length - 1, config.statsWindow) };
}

export function demoMode(argv: string[]): AgentMode {
  return argv.includes("--cached") ? "cached" : argv.includes("--record-agents") ? "record" : "call";
}

export function printOutcome(o: AgentOutcome): void {
  const label = o.cached ? " [KAYITLI YANIT]" : "";
  if (o.ok && o.finding) {
    const f = o.finding;
    log.ok(o.agent, `${f.type}/${f.direction} anomali=${f.anomaly} şiddet=${f.severity} uyum beyanı=${f.confidence}${label} (${o.durationMs} ms)`);
    log.info(o.agent, `kanıt: ${f.evidence.map((e) => e.record_id).join(", ") || "-"} | ${f.explanation}`);
  } else {
    log.warn(o.agent, `BELİRSİZ${label}: ${o.errors.join("; ")}`);
  }
}
