// ARGUS: OpenAI ile bağımsız analiz (farklı sağlayıcı bilinçli bir seçim).
// ARGUS'a yalnızca ham pencere gider; bu dosya ATLAS'tan hiçbir şey içe aktarmaz.
import OpenAI from "openai";
import { config } from "../config.js";
import { log, errMsg, withTimeout, isMain } from "../util.js";
import { AgentMode, callOrReplay, inputHash } from "./cache.js";
import { AgentInput, AgentOutcome, dataPrompt, failedOutcome, outcomeFromRaw, systemPrompt } from "./schema.js";

const AGENT = "ARGUS" as const;

async function callOpenAI(user: string): Promise<string> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY tanımlı değil");
  if (!config.argusModel) throw new Error("ARGUS_MODEL tanımlı değil");
  const client = new OpenAI({ apiKey: config.openaiApiKey, timeout: config.llmTimeoutMs, maxRetries: 1 });
  const res = await withTimeout(
    client.chat.completions.create({
      model: config.argusModel,
      messages: [
        { role: "system", content: systemPrompt(AGENT) },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
    config.llmTimeoutMs,
    "ARGUS LLM çağrısı",
  );
  const choice = res.choices[0];
  if (!choice) throw new Error("boş yanıt");
  if (choice.finish_reason === "length") throw new Error("yanıt uzunluk sınırında kesildi");
  if (choice.message.refusal) throw new Error("model isteği reddetti (refusal)");
  const text = choice.message.content ?? "";
  if (!text.trim()) throw new Error("boş yanıt");
  return text;
}

export async function runArgus(input: AgentInput, mode: AgentMode): Promise<AgentOutcome> {
  const started = Date.now();
  const user = dataPrompt(input);
  const hash = inputHash(AGENT, "initial", systemPrompt(AGENT), user);
  try {
    log.agent(AGENT, `analiz başladı (${mode === "cached" ? "KAYITLI YANIT" : config.argusModel || "model yok"})`);
    const { raw, cached } = await callOrReplay(
      mode,
      { agent: AGENT, phase: "initial", round_id: input.round_id, input_hash: hash, model: config.argusModel },
      () => callOpenAI(user),
    );
    return outcomeFromRaw(raw, AGENT, input, { phase: "initial", cached, model: config.argusModel, durationMs: Date.now() - started });
  } catch (e) {
    return failedOutcome(AGENT, "initial", config.argusModel, started, errMsg(e));
  }
}

// Demo: npx tsx src/agents/argus.ts recordings/x.jsonl [--inject drop] [--cached|--record-agents]
if (isMain(import.meta.url)) {
  const { demoInput, demoMode, printOutcome } = await import("./demo.js");
  const input = demoInput(process.argv.slice(2));
  printOutcome(await runArgus(input, demoMode(process.argv.slice(2))));
}
