// OpenAI uyumlu sohbet uç noktası (OpenAI, Gemini, Groq). Yalnızca JSON nesnesi istenir.
import OpenAI from "openai";
import { config, type AgentLlm } from "../config.js";
import { withTimeout } from "../util.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function callOpenAICompatible(llm: AgentLlm, messages: ChatMessage[], label: string): Promise<string> {
  if (!llm.apiKey) throw new Error(`${llm.keyEnv} tanımlı değil`);
  if (!llm.model) throw new Error(`${label} için model tanımlı değil`);
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, timeout: config.llmTimeoutMs, maxRetries: 1 });
  const res = await withTimeout(
    client.chat.completions.create({ model: llm.model, messages, response_format: { type: "json_object" } }),
    config.llmTimeoutMs,
    `${label} LLM çağrısı`,
  );
  const choice = res.choices[0];
  if (!choice) throw new Error("boş yanıt");
  if (choice.finish_reason === "length") throw new Error("yanıt uzunluk sınırında kesildi");
  if (choice.message.refusal) throw new Error("model isteği reddetti (refusal)");
  const text = choice.message.content ?? "";
  if (!text.trim()) throw new Error("boş yanıt");
  return text;
}
