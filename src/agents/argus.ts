// ARGUS: bağımsız analiz, ATLAS'tan farklı bir sağlayıcıyla (ARGUS_PROVIDER; varsayılan OpenAI).
// ARGUS'a yalnızca ham pencere gider; bu dosya ATLAS'tan hiçbir şey içe aktarmaz.
import { config } from "../config.js";
import { log, errMsg, isMain } from "../util.js";
import { AgentMode, callOrReplay, inputHash } from "./cache.js";
import { callOpenAICompatible } from "./llm.js";
import { AgentInput, AgentOutcome, dataPrompt, failedOutcome, outcomeFromRaw, systemPrompt } from "./schema.js";

const AGENT = "ARGUS" as const;

const LLM = config.argus;

function callLlm(user: string): Promise<string> {
  return callOpenAICompatible(
    LLM,
    [
      { role: "system", content: systemPrompt(AGENT) },
      { role: "user", content: user },
    ],
    AGENT,
  );
}

export async function runArgus(input: AgentInput, mode: AgentMode): Promise<AgentOutcome> {
  const started = Date.now();
  const user = dataPrompt(input);
  const hash = inputHash(AGENT, "initial", systemPrompt(AGENT), user);
  try {
    log.agent(AGENT, `analiz başladı (${mode === "cached" ? "KAYITLI YANIT" : `${LLM.provider}/${LLM.model || "model yok"}`})`);
    const { raw, cached } = await callOrReplay(
      mode,
      { agent: AGENT, phase: "initial", round_id: input.round_id, input_hash: hash, model: LLM.model },
      () => callLlm(user),
    );
    return outcomeFromRaw(raw, AGENT, input, { phase: "initial", cached, model: LLM.model, durationMs: Date.now() - started });
  } catch (e) {
    return failedOutcome(AGENT, "initial", LLM.model, started, errMsg(e));
  }
}

// Demo: npx tsx src/agents/argus.ts recordings/x.jsonl [--inject drop] [--cached|--record-agents]
if (isMain(import.meta.url)) {
  const { demoInput, demoMode, printOutcome } = await import("./demo.js");
  const input = demoInput(process.argv.slice(2));
  printOutcome(await runArgus(input, demoMode(process.argv.slice(2))));
}
