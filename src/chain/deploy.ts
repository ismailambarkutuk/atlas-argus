// AtlasArgusSeal kontratını derler (solc 0.8.26) ve isteğe bağlı olarak Fuji'ye deploy eder.
//   npx tsx src/chain/deploy.ts            → yalnızca derle, contracts/AtlasArgusSeal.json yaz
//   npx tsx src/chain/deploy.ts --deploy   → derle + Fuji'ye deploy et, contracts/deployment.json yaz
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { config } from "../config.js";
import { ROOT, log, errMsg, isMain } from "../util.js";
const SNOWTRACE_TX = "https://testnet.snowtrace.io/tx/";

const require = createRequire(import.meta.url);
const SOURCE = path.join(ROOT, "contracts", "AtlasArgusSeal.sol");
export const ARTIFACT = path.join(ROOT, "contracts", "AtlasArgusSeal.json");
export const DEPLOYMENT = path.join(ROOT, "contracts", "deployment.json");
export const SNOWTRACE_ADDRESS = "https://testnet.snowtrace.io/address/";

export interface Deployment {
  network: "avalanche-fuji";
  chainId: number;
  address: Hex;
  txHash: Hex;
  deployer: Hex;
  deployedAt: string;
  compiler: string;
}

export function compile(): { abi: Abi; bytecode: Hex; compiler: string } {
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: { "AtlasArgusSeal.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(`derleme hatası: ${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")}`);
  const c = out.contracts["AtlasArgusSeal.sol"].AtlasArgusSeal;
  const artifact = { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex, compiler: `solc ${solc.version()}` };
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return artifact;
}

export function loadDeployment(): (Deployment & { abi: Abi }) | null {
  try {
    const d = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")) as Deployment;
    const { abi } = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")) as { abi: Abi };
    return { ...d, abi };
  } catch {
    return null;
  }
}

async function deploy(): Promise<void> {
  if (!config.avaxPrivateKey) throw new Error("AVAX_PRIVATE_KEY yok");
  const { abi, bytecode, compiler } = compile();
  const pk = (config.avaxPrivateKey.startsWith("0x") ? config.avaxPrivateKey : `0x${config.avaxPrivateKey}`) as Hex;
  const account = privateKeyToAccount(pk);
  const transport = http(config.avaxRpcUrl, { timeout: config.chainTimeoutMs });
  const pub = createPublicClient({ chain: avalancheFuji, transport });
  const wallet = createWalletClient({ account, chain: avalancheFuji, transport });
  const chainId = await pub.getChainId();
  if (chainId !== config.fujiChainId) throw new Error(`RPC zinciri ${chainId}, beklenen Fuji ${config.fujiChainId}`);

  log.stage("DEPLOY", `AtlasArgusSeal Fuji'ye deploy ediliyor (deployer ${account.address})`);
  const txHash = await wallet.deployContract({ abi, bytecode });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: config.chainTimeoutMs });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy başarısız: ${txHash}`);
  const d: Deployment = {
    network: "avalanche-fuji",
    chainId,
    address: receipt.contractAddress,
    txHash,
    deployer: account.address,
    deployedAt: new Date().toISOString(),
    compiler,
  };
  fs.writeFileSync(DEPLOYMENT, JSON.stringify(d, null, 2) + "\n", "utf8");
  log.ok("DEPLOY", `kontrat adresi: ${d.address}`);
  log.ok("DEPLOY", `${SNOWTRACE_ADDRESS}${d.address}`);
  log.ok("DEPLOY", `deploy tx: ${SNOWTRACE_TX}${txHash}`);
}

if (isMain(import.meta.url)) {
  try {
    const { abi, compiler } = compile();
    log.ok("DERLEME", `${compiler} · ${abi.filter((x) => x.type === "function").length} fonksiyon → ${path.relative(ROOT, ARTIFACT)}`);
    if (process.argv.includes("--deploy")) await deploy();
  } catch (e) {
    log.error("DEPLOY", errMsg(e));
    process.exitCode = 1;
  }
}
