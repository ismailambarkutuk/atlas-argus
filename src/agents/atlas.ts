// ATLAS: Anthropic (Claude) ile bağımsız analiz. Uyuşmazlık turunda yalnızca
// hangi alanda ayrışıldığını öğrenir; ARGUS'un gerekçesini asla görmez.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { log, errMsg, withTimeout, isMain } from "../util.js";
import { AgentMode, callOrReplay, inputHash } from "./cache.js";
import {
  AgentInput,
  AgentOutcome,
  FINDING_JSON_SCHEMA,
  Finding,
  agentView,
  dataPrompt,
  disputePrompt,
  failedOutcome,
  outcomeFromRaw,
  systemPrompt,
} from "./schema.js";

const AGENT = "ATLAS" as const;

async function callClaude(messages: Anthropic.MessageParam[]): Promise<string> {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY tanımlı değil");
  if (!config.atlasModel) throw new Error("ATLAS_MODEL tanımlı değil");
  const client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: config.llmTimeoutMs, maxRetries: 1 });
  const res = await withTimeout(
    client.messages.create({
      model: config.atlasModel,
      max_tokens: 4096,
      system: systemPrompt(AGENT),
      messages,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: FINDING_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
    }),
    config.llmTimeoutMs,
    "ATLAS LLM çağrısı",
  );
  if (res.stop_reason === "refusal") throw new Error("model isteği reddetti (refusal)");
  if (res.stop_reason === "max_tokens") throw new Error("yanıt max_tokens sınırında kesildi");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (!text.trim()) throw new Error("boş yanıt");
  return text;
}

export async function runAtlas(input: AgentInput, mode: AgentMode): Promise<AgentOutcome> {
  const started = Date.now();
  const user = dataPrompt(input);
  const hash = inputHash(AGENT, "initial", systemPrompt(AGENT), user);
  try {
    log.agent(AGENT, `analiz başladı (${mode === "cached" ? "KAYITLI YANIT" : config.atlasModel})`);
    const { raw, cached } = await callOrReplay(
      mode,
      { agent: AGENT, phase: "initial", round_id: input.round_id, input_hash: hash, model: config.atlasModel },
      () => callClaude([{ role: "user", content: user }]),
    );
    return outcomeFromRaw(raw, AGENT, input, { phase: "initial", cached, model: config.atlasModel, durationMs: Date.now() - started });
  } catch (e) {
    return failedOutcome(AGENT, "initial", config.atlasModel, started, errMsg(e));
  }
}

/**
 * Tek turluk uyuşmazlık turu. ATLAS'a yalnızca ayrışılan alan adları ve kendi
 * önceki bulgusu verilir. Yeni kanıt şartı compare.ts'te kodla denetlenir.
 */
export async function runAtlasDispute(input: AgentInput, previous: AgentOutcome, fields: string[], mode: AgentMode): Promise<AgentOutcome> {
  const started = Date.now();
  if (!previous.ok || !previous.finding || !previous.raw) return failedOutcome(AGENT, "dispute", config.atlasModel, started, "önceki ATLAS bulgusu geçersiz");
  const prev: Finding = previous.finding;
  const user = dataPrompt(input);
  // ATLAS'a kendi kullandığı kanıtlar, gördüğü opak kimliklerle hatırlatılır
  const view = agentView(input);
  const followUp = disputePrompt(fields, prev.evidence.map((e) => view.toOpaque.get(e.record_id) ?? e.record_id));
  const hash = inputHash(AGENT, "dispute", systemPrompt(AGENT), user, previous.raw, followUp);
  try {
    log.agent(AGENT, `uyuşmazlık turu: yalnızca "${fields.join(", ")}" alanında ayrışıldığı bildirildi`);
    const { raw, cached } = await callOrReplay(
      mode,
      { agent: AGENT, phase: "dispute", round_id: input.round_id, input_hash: hash, model: config.atlasModel },
      () =>
        callClaude([
          { role: "user", content: user },
          { role: "assistant", content: previous.raw! },
          { role: "user", content: followUp },
        ]),
    );
    return outcomeFromRaw(raw, AGENT, input, { phase: "dispute", cached, model: config.atlasModel, durationMs: Date.now() - started });
  } catch (e) {
    return failedOutcome(AGENT, "dispute", config.atlasModel, started, errMsg(e));
  }
}

// Demo: npx tsx src/agents/atlas.ts recordings/x.jsonl [--inject drop] [--cached|--record-agents]
if (isMain(import.meta.url)) {
  const { demoInput, demoMode, printOutcome } = await import("./demo.js");
  const input = demoInput(process.argv.slice(2));
  printOutcome(await runAtlas(input, demoMode(process.argv.slice(2))));
}
