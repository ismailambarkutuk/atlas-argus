// OpenAI uyumlu sohbet uç noktası (OpenAI, Gemini, Groq). Yalnızca JSON nesnesi istenir.
import OpenAI from "openai";
import { config, type AgentLlm } from "../config.js";
import { log, withTimeout } from "../util.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_ATTEMPTS = 3;

/**
 * Geçici hatalarda (429 dakika limiti, 5xx) bekleyip yeniden dener. Günlük kota
 * bitti hatası beklemekle düzelmez; yeniden denenmez, doğrudan belirsiz olur.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status: number | undefined = e?.status;
      const quota = /quota/i.test(String(e?.message));
      const transient = (status === 429 && !quota) || (status !== undefined && status >= 500);
      if (!transient || attempt >= MAX_ATTEMPTS) throw e;
      const hdr = Number(e?.headers?.get?.("retry-after") ?? e?.headers?.["retry-after"]);
      const waitMs = Math.min(Number.isFinite(hdr) && hdr > 0 ? hdr * 1000 : 5000 * attempt, 30000);
      log.warn(label, `geçici hata (${status}), ${Math.round(waitMs / 1000)} sn sonra yeniden deneniyor (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function callOpenAICompatible(llm: AgentLlm, messages: ChatMessage[], label: string): Promise<string> {
  if (!llm.apiKey) throw new Error(`${llm.keyEnv} tanımlı değil`);
  if (!llm.model) throw new Error(`${label} için model tanımlı değil`);
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL, timeout: config.llmTimeoutMs, maxRetries: 1 });
  const res = await withRetry(label, () =>
    withTimeout(
      client.chat.completions.create({ model: llm.model, messages, response_format: { type: "json_object" } }),
      config.llmTimeoutMs,
      `${label} LLM çağrısı`,
    ),
  );
  const choice = res.choices[0];
  if (!choice) throw new Error("boş yanıt");
  if (choice.finish_reason === "length") throw new Error("yanıt uzunluk sınırında kesildi");
  if (choice.message.refusal) throw new Error("model isteği reddetti (refusal)");
  const text = choice.message.content ?? "";
  if (!text.trim()) throw new Error("boş yanıt");
  return text;
}
