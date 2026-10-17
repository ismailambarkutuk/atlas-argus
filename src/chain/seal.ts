// Mühür: iki bulgunun hash'i önce commit edilir, iki commit de tamamlanınca reveal edilir.
// hash = keccak256(canonicalJSON(bulgu) + salt), salt bulgu başına rastgele 32 bayt.
// Kanıtın sınırı: mühür, agent'ların diğerinin cevabı açıklandıktan sonra fikir
// değiştirmediğini kanıtlar; ARGUS'un ATLAS'ı görmediği kod yapısıyla sağlanır.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, toHex, stringToHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { config } from "../config.js";
import { ROOT, log, errMsg, withTimeout, isMain } from "../util.js";
import type { Finding } from "../agents/schema.js";
import { loadDeployment, type Deployment } from "./deploy.js";

export interface SealRecord {
  agent: string;
  round_id: string;
  phase: "initial" | "dispute";
  finding: Finding;
  salt: Hex;
  hash: Hex;
}

export interface Receipt {
  provider: "selftx" | "contract" | "local";
  kind: "commit" | "reveal";
  agent: string;
  round_id: string;
  phase: string;
  ok: boolean;
  hash: Hex;
  txHash?: Hex;
  explorerUrl?: string;
  file?: string;
  verified?: boolean;
  error?: string;
}

export interface SealProvider {
  readonly name: string;
  commit(rec: SealRecord): Promise<Receipt>;
  reveal(rec: SealRecord): Promise<Receipt>;
}

export const SNOWTRACE_TX = "https://testnet.snowtrace.io/tx/";
const SEAL_LOG = path.join(ROOT, "recordings", "seals", "seals.jsonl");

/** Anahtarları sıralı, boşluksuz JSON. Aynı bulgu her zaman aynı metni verir. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`)
    .join(",")}}`;
}

export function sealHash(finding: Finding, salt: Hex): Hex {
  return keccak256(stringToHex(canonicalJSON(finding) + salt));
}

export function makeSealRecord(finding: Finding, phase: SealRecord["phase"]): SealRecord {
  const salt = toHex(crypto.randomBytes(32));
  return { agent: finding.agent, round_id: finding.round_id, phase, finding, salt, hash: sealHash(finding, salt) };
}

export function verifySealRecord(rec: SealRecord): boolean {
  return sealHash(rec.finding, rec.salt) === rec.hash;
}

function commitPayload(rec: SealRecord) {
  return { p: "atlas-argus", t: "commit", agent: rec.agent, round_id: rec.round_id, phase: rec.phase, hash: rec.hash };
}
function revealPayload(rec: SealRecord) {
  return { p: "atlas-argus", t: "reveal", agent: rec.agent, round_id: rec.round_id, phase: rec.phase, salt: rec.salt, finding: rec.finding };
}

/** Yedek: aynı kayıt yerel dosyaya yazılır, zincire yazılmaz. */
export class LocalLogSeal implements SealProvider {
  readonly name = "LocalLogSeal";
  private append(obj: object): void {
    fs.mkdirSync(path.dirname(SEAL_LOG), { recursive: true });
    fs.appendFileSync(SEAL_LOG, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n", "utf8");
  }
  async commit(rec: SealRecord): Promise<Receipt> {
    this.append(commitPayload(rec));
    return { provider: "local", kind: "commit", agent: rec.agent, round_id: rec.round_id, phase: rec.phase, ok: true, hash: rec.hash, file: path.relative(ROOT, SEAL_LOG) };
  }
  async reveal(rec: SealRecord): Promise<Receipt> {
    const verified = verifySealRecord(rec);
    this.append({ ...revealPayload(rec), verified });
    return { provider: "local", kind: "reveal", agent: rec.agent, round_id: rec.round_id, phase: rec.phase, ok: verified, verified, hash: rec.hash, file: path.relative(ROOT, SEAL_LOG), error: verified ? undefined : "hash doğrulanamadı" };
  }
}

/** Birincil: cüzdanın kendine 0 değerli tx'i, mühür `data` alanında. İşlemler sırayla gider. */
export class SelfTxSeal implements SealProvider {
  readonly name = "SelfTxSeal";
  private queue: Promise<unknown> = Promise.resolve();
  private chainChecked = false;
  private account;
  private wallet;
  private pub;

  constructor(privateKey: string) {
    const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    this.account = privateKeyToAccount(pk);
    const transport = http(config.avaxRpcUrl, { timeout: config.chainTimeoutMs });
    this.wallet = createWalletClient({ account: this.account, chain: avalancheFuji, transport });
    this.pub = createPublicClient({ chain: avalancheFuji, transport });
  }

  /** Sıralı gönderim: bir tx onaylanmadan diğeri gönderilmez (nonce çakışmaz). */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(data: Hex): Promise<Hex> {
    if (!this.chainChecked) {
      const id = await this.pub.getChainId();
      if (id !== config.fujiChainId) throw new Error(`RPC zinciri ${id}, beklenen Fuji ${config.fujiChainId}`);
      this.chainChecked = true;
    }
    const nonce = await this.pub.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    const txHash = await this.wallet.sendTransaction({ to: this.account.address, value: 0n, data, nonce });
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: config.chainTimeoutMs });
    if (receipt.status !== "success") throw new Error(`tx başarısız: ${txHash}`);
    return txHash;
  }

  private async tx(kind: Receipt["kind"], rec: SealRecord, payload: object): Promise<Receipt> {
    const base = { provider: "selftx" as const, kind, agent: rec.agent, round_id: rec.round_id, phase: rec.phase, hash: rec.hash };
    try {
      const txHash = await this.enqueue(() =>
        withTimeout(this.send(stringToHex(JSON.stringify(payload))), config.chainTimeoutMs + 5000, `Fuji ${kind} tx`),
      );
      return { ...base, ok: true, txHash, explorerUrl: SNOWTRACE_TX + txHash, verified: kind === "reveal" ? true : undefined };
    } catch (e) {
      return { ...base, ok: false, error: errMsg(e) };
    }
  }

  commit(rec: SealRecord): Promise<Receipt> {
    return this.tx("commit", rec, commitPayload(rec));
  }

  async reveal(rec: SealRecord): Promise<Receipt> {
    if (!verifySealRecord(rec)) {
      return { provider: "selftx", kind: "reveal", agent: rec.agent, round_id: rec.round_id, phase: rec.phase, ok: false, hash: rec.hash, verified: false, error: "hash doğrulanamadı, reveal gönderilmedi" };
    }
    return this.tx("reveal", rec, revealPayload(rec));
  }
}

/** Birincil başarısız olursa logla ve yedekle devam et. */
export class FallbackSeal implements SealProvider {
  readonly name: string;
  constructor(private primary: SealProvider, private fallback: SealProvider) {
    this.name = `${primary.name}→${fallback.name}`;
  }
  private async run(kind: "commit" | "reveal", rec: SealRecord): Promise<Receipt> {
    const r = await this.primary[kind](rec);
    if (r.ok) return r;
    log.warn("MÜHÜR", `${this.primary.name} ${kind} başarısız (${r.error}); ${this.fallback.name} ile devam`);
    return this.fallback[kind](rec);
  }
  commit(rec: SealRecord) {
    return this.run("commit", rec);
  }
  reveal(rec: SealRecord) {
    return this.run("reveal", rec);
  }
}

/**
 * Kontrat mührü: AtlasArgusSeal (contracts/). Reveal'da keccak256(bulgu + salt) ZİNCİR
 * ÜZERİNDE yeniden hesaplanır; uyuşmazsa kontrat işlemi reddeder. Her çağrı önce ücretsiz
 * simüle edilir, reddedilecek işlem gönderilmez. İşlemler sırayla gider.
 */
export class ContractSeal implements SealProvider {
  readonly name = "ContractSeal";
  private queue: Promise<unknown> = Promise.resolve();
  private account;
  private wallet;
  private pub;

  constructor(privateKey: string, private dep: Deployment & { abi: Abi }) {
    const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    this.account = privateKeyToAccount(pk);
    const transport = http(config.avaxRpcUrl, { timeout: config.chainTimeoutMs });
    this.wallet = createWalletClient({ account: this.account, chain: avalancheFuji, transport });
    this.pub = createPublicClient({ chain: avalancheFuji, transport });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(kind: Receipt["kind"], rec: SealRecord, args: readonly unknown[]): Promise<Receipt> {
    const base = { provider: "contract" as const, kind, agent: rec.agent, round_id: rec.round_id, phase: rec.phase, hash: rec.hash };
    const send = async (): Promise<Hex> => {
      const { request } = await this.pub.simulateContract({ account: this.account, address: this.dep.address, abi: this.dep.abi, functionName: kind, args });
      const txHash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: config.chainTimeoutMs });
      if (receipt.status !== "success") throw new Error(`tx başarısız: ${txHash}`);
      return txHash;
    };
    try {
      const txHash = await this.enqueue(() => withTimeout(send(), config.chainTimeoutMs + 5000, `kontrat ${kind}`));
      return { ...base, ok: true, txHash, explorerUrl: SNOWTRACE_TX + txHash, verified: kind === "reveal" ? true : undefined };
    } catch (e) {
      const reason = (e as { shortMessage?: string }).shortMessage ?? errMsg(e);
      return { ...base, ok: false, verified: kind === "reveal" ? false : undefined, error: `kontrat reddetti/başarısız: ${reason}` };
    }
  }

  commit(rec: SealRecord): Promise<Receipt> {
    return this.write("commit", rec, [rec.round_id, rec.agent, rec.phase, rec.hash]);
  }

  /** Bulgu, hash'te kullanılan canonical JSON metniyle birebir gönderilir. */
  reveal(rec: SealRecord): Promise<Receipt> {
    return this.write("reveal", rec, [rec.round_id, rec.agent, rec.phase, canonicalJSON(rec.finding), rec.salt]);
  }
}

export function createSealProvider(): SealProvider {
  const local = new LocalLogSeal();
  if (config.sealProvider !== "selftx" && config.sealProvider !== "contract") return local;
  if (!config.avaxPrivateKey) {
    log.warn("MÜHÜR", "AVAX_PRIVATE_KEY yok; LocalLogSeal (yerel, zincire yazılmaz) kullanılıyor");
    return local;
  }
  try {
    if (config.sealProvider === "contract") {
      const dep = loadDeployment();
      if (!dep) {
        log.warn("MÜHÜR", "contracts/deployment.json yok (önce: npx tsx src/chain/deploy.ts --deploy); SelfTxSeal kullanılıyor");
        return new FallbackSeal(new SelfTxSeal(config.avaxPrivateKey), local);
      }
      log.info("MÜHÜR", `AtlasArgusSeal kontratı: ${dep.address}`);
      return new FallbackSeal(new ContractSeal(config.avaxPrivateKey, dep), local);
    }
    return new FallbackSeal(new SelfTxSeal(config.avaxPrivateKey), local);
  } catch (e) {
    log.warn("MÜHÜR", `zincir mührü kurulamadı (${errMsg(e)}); LocalLogSeal kullanılıyor`);
    return local;
  }
}

export interface SealOutcome {
  ok: boolean;
  records: SealRecord[];
  commits: Receipt[];
  reveals: Receipt[];
  error?: string;
}

/** Önce TÜM commit'ler (sırayla), hepsi tamamlanınca TÜM reveal'ler. */
export async function sealAndReveal(provider: SealProvider, records: SealRecord[]): Promise<SealOutcome> {
  const commits: Receipt[] = [];
  for (const rec of records) {
    const r = await provider.commit(rec);
    commits.push(r);
    if (r.ok) log.ok("MÜHÜR", `${rec.agent} commit ${r.hash.slice(0, 18)}… ${r.explorerUrl ?? `(yerel: ${r.file})`}`);
    else {
      log.error("MÜHÜR", `${rec.agent} commit başarısız: ${r.error}`);
      return { ok: false, records, commits, reveals: [], error: `${rec.agent} commit edilemedi` };
    }
  }
  log.stage("MÜHÜR", "tüm commit'ler tamam → reveal");
  const reveals: Receipt[] = [];
  for (const rec of records) {
    const r = await provider.reveal(rec);
    reveals.push(r);
    if (r.ok) log.ok("MÜHÜR", `${rec.agent} reveal, hash doğrulandı ${r.explorerUrl ?? `(yerel: ${r.file})`}`);
    else {
      log.error("MÜHÜR", `${rec.agent} reveal başarısız: ${r.error}`);
      return { ok: false, records, commits, reveals, error: `${rec.agent} reveal edilemedi` };
    }
  }
  return { ok: true, records, commits, reveals };
}

// Demo: npx tsx src/chain/seal.ts  → örnek bulguyu mühürler (anahtar yoksa yerel)
if (isMain(import.meta.url)) {
  const f: Finding = {
    agent: "ATLAS",
    round_id: "R-DEMO",
    symbol: "BTC-USDT",
    anomaly: false,
    type: "none",
    direction: "none",
    severity: 0,
    confidence: 0.5,
    evidence: [],
    explanation: "mühür demo",
  };
  const rec = makeSealRecord(f, "initial");
  log.info("MÜHÜR", `canonical: ${canonicalJSON(f)}`);
  log.info("MÜHÜR", `doğrulama: ${verifySealRecord(rec)} | kurcalanmış: ${verifySealRecord({ ...rec, finding: { ...f, confidence: 0.9 } })}`);
  const out = await sealAndReveal(createSealProvider(), [rec]);
  log.stage("MÜHÜR", `sonuç: ${out.ok ? "TAMAM" : "BAŞARISIZ"}`);
}
