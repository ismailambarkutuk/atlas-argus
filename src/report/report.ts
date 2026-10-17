// Rapor: kanıtlar, uyum seviyesi, belirsizlikler, alınan/alınmayan aksiyon,
// etiketler (ENJEKTE / KAYITLI YANIT / SAHTE BAKİYE) ve Snowtrace linkleri.
// "confidence" raporda "uyum beyanı" olarak geçer; asla "doğruluk olasılığı" denmez.
import fs from "node:fs";
import path from "node:path";
import { ROOT, log, redact, isMain } from "../util.js";
import { LEVEL_TR, type CompareResult } from "../compare.js";
import type { AgentOutcome } from "../agents/schema.js";
import type { Signals } from "../stats/robustZ.js";
import type { SealOutcome } from "../chain/seal.js";
import type { Balance, RiskDecision } from "../risk.js";
import type { ExecResult } from "../execute.js";

export const REPORTS_DIR = path.join(ROOT, "reports");

export interface RoundReport {
  round_id: string;
  symbol: string;
  created_at: string;
  trigger: { record_id: string; iso: string; injected: boolean; scenario?: string };
  signals: Signals;
  windowSize: number;
  injectedRecordIds: string[];
  agents: AgentOutcome[];
  seal?: SealOutcome;
  disputeSeal?: SealOutcome;
  compare: CompareResult;
  price?: { value: number; source: string };
  balance?: Balance | null;
  risk: RiskDecision;
  exec: ExecResult;
  uncertainties: string[];
  flags: { dryRun: boolean; killSwitch: string; cached: boolean; sealProvider: string };
}

export function labels(r: RoundReport): string[] {
  const out: string[] = [];
  if (r.trigger.injected || r.injectedRecordIds.length) out.push("ENJEKTE");
  if (r.agents.some((a) => a.cached)) out.push("KAYITLI YANIT");
  if (r.balance?.source === "mock") out.push("SAHTE BAKİYE");
  if (r.exec.dryRun) out.push("DRY_RUN");
  return out;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function agentCard(a: AgentOutcome, injected: Set<string>): string {
  const tag = a.cached ? `<span class="tag cached">KAYITLI YANIT</span>` : "";
  const phase = a.phase === "dispute" ? " — uyuşmazlık turu" : "";
  if (!a.ok || !a.finding) {
    return `<div class="card bad"><h3>${a.agent}${phase} ${tag}</h3><p><b>BELİRSİZ</b> (geçersiz çıktı)</p><ul>${a.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
  }
  const f = a.finding;
  const ev = f.evidence
    .map((e) => `<li><code>${esc(e.record_id)}</code>${injected.has(e.record_id) ? ` <span class="tag inj">ENJEKTE</span>` : ""} — ${esc(e.note)}</li>`)
    .join("");
  return `<div class="card"><h3>${a.agent}${phase} ${tag}</h3>
<p><b>${esc(f.type)}</b> / ${esc(f.direction)} · anomali: ${f.anomaly ? "evet" : "hayır"} · şiddet ${f.severity} · uyum beyanı ${f.confidence}</p>
<p>${esc(f.explanation)}</p><ul>${ev || "<li>kanıt yok</li>"}</ul><p class="dim">model: ${esc(a.model || "-")} · ${a.durationMs} ms</p></div>`;
}

function sealRows(s: SealOutcome | undefined, title: string): string {
  if (!s) return "";
  const rows = [...s.commits, ...s.reveals]
    .map(
      (r) =>
        `<tr><td>${r.kind}</td><td>${esc(r.agent)}</td><td><code>${esc(r.hash.slice(0, 20))}…</code></td><td>${r.ok ? "✔" : "✘"}</td><td>${
          r.explorerUrl ? `<a href="${esc(r.explorerUrl)}">Snowtrace</a>` : `yerel kayıt (${esc(r.file ?? "-")}), zincire yazılmadı`
        }</td></tr>`,
    )
    .join("");
  return `<h2>${title}</h2><table><tr><th>adım</th><th>agent</th><th>hash</th><th>durum</th><th>kanıt</th></tr>${rows}</table>${s.error ? `<p class="bad">${esc(s.error)}</p>` : ""}`;
}

export function renderHtml(r: RoundReport): string {
  const injected = new Set(r.injectedRecordIds);
  const tags = labels(r)
    .map((l) => `<span class="tag ${l === "ENJEKTE" ? "inj" : l === "KAYITLI YANIT" ? "cached" : "warn"}">${l}</span>`)
    .join(" ");
  const order = r.risk.order;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATLAS–ARGUS Raporu</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--dim:#6b7280;--card:#f6f7f9;--bad:#b42318;--ok:#067647;--inj:#b54708;--cached:#5925dc;--border:#e4e7ec}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--dim:#9aa1ab;--card:#181b21;--bad:#f97066;--ok:#47cd89;--inj:#fdb022;--cached:#a48afb;--border:#2a2f37}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 8px}h3{margin:0 0 6px;font-size:15px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;margin:8px 0}
.bad{color:var(--bad)}.ok{color:var(--ok)}.dim{color:var(--dim);font-size:13px}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}
.tag.inj{color:var(--inj)}.tag.cached{color:var(--cached)}.tag.warn{color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px}
table{border-collapse:collapse;width:100%;font-size:13px;overflow-x:auto;display:block}td,th{border-bottom:1px solid var(--border);padding:4px 8px;text-align:left}
code{font-size:12px;word-break:break-all}.level{font-size:20px;font-weight:700}
</style></head><body>
<h1>ATLAS–ARGUS · ${esc(r.symbol)}</h1>
<p class="dim">Tur ${esc(r.round_id)} · ${esc(r.created_at)}</p>
<p>${tags}</p>
<h2>Tetik (LLM'siz istatistik)</h2>
<div class="card">Mum <code>${esc(r.trigger.record_id)}</code> (${esc(r.trigger.iso)}) ${r.trigger.injected ? `<span class="tag inj">ENJEKTE: ${esc(r.trigger.scenario)}</span>` : ""}<br>
Fiyat robust z = <b>${r.signals.priceZ.toFixed(2)}</b> · hacim robust z = <b>${r.signals.volZ.toFixed(2)}</b> · pencere ${r.signals.window} mum<br>
Tetik: ${esc(r.signals.triggerReasons.join(", "))} · istatistik onayı (fiyat ve hacim birlikte): ${r.signals.statConfirm ? "VAR" : "yok"}</div>
<h2>Bağımsız analizler</h2><p class="dim">İki agent aynı ${r.windowSize} mumluk ham pencereyi paralel ve birbirinden habersiz analiz etti. Hazır istatistik verilmedi.</p>
<div class="grid">${r.agents.map((a) => agentCard(a, injected)).join("")}</div>
${sealRows(r.seal, "Mühür (commit → reveal)")}${sealRows(r.disputeSeal, "Uyuşmazlık turu mührü")}
<h2>Karşılaştırma</h2><div class="card"><p class="level">Uyum seviyesi: ${LEVEL_TR[r.compare.level]}</p><ul>${r.compare.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p class="dim">"Uyum beyanı" agent'ların kendi beyanıdır, kalibre değildir; doğruluk olasılığı değildir.</p></div>
<h2>Risk motoru ve aksiyon</h2><div class="card"><p><b>${esc(r.risk.action)}</b> · ${r.risk.approved ? '<span class="ok">ONAYLANDI</span>' : "onay yok"}</p>
<ul>${r.risk.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
${order ? `<p>Emir: ${esc(order.side)} ${esc(order.sz)} ${esc(order.instId)} (${esc(order.ordType)}, ${esc(order.tdMode)}) ~${order.notionalUsdt} USDT</p>` : ""}
${r.price ? `<p class="dim">Fiyat: ${r.price.value} (${esc(r.price.source)})</p>` : ""}
${r.balance ? `<p class="dim">Bakiye: ${r.balance.available} ${esc(r.balance.ccy)} ${r.balance.source === "mock" ? '<span class="tag warn">SAHTE BAKİYE</span>' : ""}</p>` : ""}
<p>Sonuç: <b>${esc(r.exec.status)}</b> — ${esc(r.exec.message)}</p>${r.exec.args ? `<p><code>okx ${esc(r.exec.args.join(" "))}</code></p>` : ""}</div>
<h2>Belirsizlikler</h2><div class="card"><ul>${(r.uncertainties.length ? r.uncertainties : ["(yok)"]).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
<p class="dim">DRY_RUN: ${r.flags.dryRun ? "açık" : "kapalı"} · kill switch: ${esc(r.flags.killSwitch)} · mühür: ${esc(r.flags.sealProvider)} · Kanıtın sınırı: mühür, agent'ların diğerinin cevabı açıklandıktan sonra fikir değiştirmediğini kanıtlar; ARGUS'un ATLAS'ı görmediği kod yapısıyla sağlanır.</p>
</body></html>`;
}

export function writeReport(r: RoundReport): { json: string; html: string } {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const base = path.join(REPORTS_DIR, r.round_id.replace(/[^A-Za-z0-9._-]/g, "_"));
  const json = `${base}.json`;
  const html = `${base}.html`;
  fs.writeFileSync(json, redact(JSON.stringify(r, null, 2)), "utf8");
  fs.writeFileSync(html, redact(renderHtml(r)), "utf8");
  return { json, html };
}

export function printSummary(r: RoundReport, files: { html: string }): void {
  const tags = labels(r);
  log.banner([
    `SONUÇ · ${r.symbol} · tur ${r.round_id}`,
    `Etiketler: ${tags.length ? tags.join(", ") : "-"}`,
    `Uyum seviyesi: ${LEVEL_TR[r.compare.level].toLocaleUpperCase("tr-TR")}`,
    `Aksiyon: ${r.risk.action}${r.risk.order ? ` ${r.risk.order.sz} ${r.risk.order.instId}` : ""} → ${r.exec.status}`,
    `Belirsizlik: ${r.uncertainties.length ? r.uncertainties.length + " madde" : "yok"}`,
    `Rapor: ${path.relative(ROOT, files.html)}`,
  ]);
}

// Demo: npx tsx src/report/report.ts reports/<tur>.json → HTML'i yeniden üretir
if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    log.error("RAPOR", "Kullanım: npx tsx src/report/report.ts reports/<tur>.json");
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as RoundReport;
  const out = writeReport(r);
  printSummary(r, out);
}
