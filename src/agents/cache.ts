// Agent yanıtlarını kaydetme (--record-agents) ve oynatma (--cached).
// Kayıtlı yanıt, girdinin hash'iyle eşleşir; eşleşme yoksa gerçek çağrıya DÜŞÜLMEZ,
// sonuç belirsiz olur. Oynatılan yanıt raporda "KAYITLI YANIT" olarak etiketlenir.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, log, isMain } from "../util.js";
import type { AgentName } from "./schema.js";

export type AgentMode = "call" | "record" | "cached" | "resume";
export const AGENT_CACHE_DIR = path.join(ROOT, "recordings", "agents");

interface CachedResponse {
  agent: AgentName;
  phase: string;
  round_id: string;
  input_hash: string;
  model: string;
  recorded_at: string;
  raw_text: string;
}

export function inputHash(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cacheFile(agent: AgentName, phase: string, roundId: string, hash: string): string {
  return path.join(AGENT_CACHE_DIR, `${safeName(roundId)}__${agent}__${phase}__${hash}.json`);
}

export function loadCached(agent: AgentName, phase: string, roundId: string, hash: string): CachedResponse | undefined {
  const f = cacheFile(agent, phase, roundId, hash);
  if (!fs.existsSync(f)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as CachedResponse;
  } catch {
    return undefined;
  }
}

export function saveCached(r: Omit<CachedResponse, "recorded_at">): string {
  fs.mkdirSync(AGENT_CACHE_DIR, { recursive: true });
  const f = cacheFile(r.agent, r.phase, r.round_id, r.input_hash);
  fs.writeFileSync(f, JSON.stringify({ ...r, recorded_at: new Date().toISOString() }, null, 2), "utf8");
  return f;
}

/**
 * Moda göre ham yanıt metnini döndürür.
 * - cached: yalnızca kayıttan; yoksa hata (gerçek çağrı yapılmaz)
 * - record: gerçek çağrı + kayıt
 * - call:   gerçek çağrı
 * - resume: kayıt varsa onu kullan, yoksa gerçek çağrı + kayıt (yarım kalan değerlendirme için)
 */
export async function callOrReplay(
  mode: AgentMode,
  meta: { agent: AgentName; phase: string; round_id: string; input_hash: string; model: string },
  call: () => Promise<string>,
): Promise<{ raw: string; cached: boolean; model: string }> {
  if (mode === "cached" || mode === "resume") {
    const hit = loadCached(meta.agent, meta.phase, meta.round_id, meta.input_hash);
    if (hit) return { raw: hit.raw_text, cached: true, model: hit.model };
    if (mode === "cached") throw new Error(`KAYITLI YANIT bulunamadı (${meta.agent}/${meta.phase}/${meta.round_id}/${meta.input_hash}); --record-agents ile kaydedin`);
  }
  const raw = await call();
  if (mode === "record" || mode === "resume") {
    const f = saveCached({ ...meta, raw_text: raw });
    log.info(meta.agent, `yanıt kaydedildi → ${path.relative(ROOT, f)}`);
  }
  return { raw, cached: false, model: meta.model };
}

// Demo: npx tsx src/agents/cache.ts  → kayıtlı yanıtları listeler
if (isMain(import.meta.url)) {
  const files = fs.existsSync(AGENT_CACHE_DIR) ? fs.readdirSync(AGENT_CACHE_DIR).filter((f) => f.endsWith(".json")) : [];
  log.stage("ÖNBELLEK", `${files.length} KAYITLI YANIT (${path.relative(ROOT, AGENT_CACHE_DIR)})`);
  for (const f of files) log.info("ÖNBELLEK", f);
}
