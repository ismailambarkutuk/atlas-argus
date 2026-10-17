// GitHub Pages vitrini: çalışan arayüz sunucusundan (npm run ui) verileri alır ve docs/'a
// statik olarak yazar. Vitrinde sunucu, anahtar ve emir yoktur; kayıtlı koşular oynatılır.
//   npx tsx ui/build-static.ts   (önce: npm run ui; kayıtlı koşular docs/data/runs/*.jsonl)
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT, log } from "../src/util.js";
import { SECRET_ENV_NAMES } from "../src/config.js";

const BASE = `http://127.0.0.1:${process.env.UI_PORT ?? 4173}`;
const OUT = path.join(ROOT, "docs");
const DATA = path.join(OUT, "data");

// Sırlar asla vitrine çıkmaz: .env'deki her anahtar değeri ve özel anahtar biçimi aranır
const env = dotenv.parse(fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env")) : "");
const secrets = [...SECRET_ENV_NAMES.map((k) => env[k]), env.OKX_API_KEY, env.OKX_SECRET_KEY, env.OKX_PASSPHRASE].filter((v): v is string => !!v && v.length >= 6);
function write(file: string, text: string): void {
  for (const s of secrets) if (text.includes(s)) throw new Error(`${path.relative(ROOT, file)} içinde sır bulundu; yazılmadı`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
async function get(p: string): Promise<unknown> {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

const status = (await get("/api/status")) as Record<string, unknown>;
status.running = null;
write(path.join(DATA, "status.json"), JSON.stringify(status));
const reports = (await get("/api/reports")) as { file: string }[];
write(path.join(DATA, "reports.json"), JSON.stringify(reports));
for (const r of reports) write(path.join(DATA, "reports", r.file), JSON.stringify(await get(`/api/reports/${encodeURIComponent(r.file)}`)));
write(path.join(DATA, "evaluation.json"), JSON.stringify(await get("/api/evaluation")));
for (const inj of ["drop", "whipsaw"]) write(path.join(DATA, `candles-${inj}.json`), JSON.stringify(await get(`/api/demo-candles?inject=${inj}`)));
for (const sc of ["drop", "diverge", "kill"]) {
  const f = path.join(DATA, "runs", `${sc}.jsonl`);
  if (!fs.existsSync(f)) throw new Error(`kayıtlı koşu yok: ${path.relative(ROOT, f)}`);
  write(f, fs.readFileSync(f, "utf8")); // sır taraması
}
const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8").replace("<head>", "<head>\n<script>window.AA_STATIC = true;</script>");
write(path.join(OUT, "index.html"), html);
write(path.join(OUT, ".nojekyll"), "");
log.ok("VİTRİN", `docs/ hazır: ${reports.length} rapor, 3 kayıtlı koşu`);
