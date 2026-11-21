import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Operation,
  Address,
  rpc,
} from "@stellar/stellar-sdk";
import { submitAndWait } from "./lib/submit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const NETWORK = process.env.NETWORK || "testnet";

const server = new rpc.Server(RPC_URL);
const deployerSecret = process.env.DEPLOYER_SECRET;
const wasmPath = process.argv[2];
const contractName = process.argv[3] ?? "contract";

// Optional: --out <path> writes the JSON record to a file instead of stdout.
const outFlagIdx = process.argv.indexOf("--out");
const outPath = outFlagIdx !== -1 ? process.argv[outFlagIdx + 1] : null;

if (!deployerSecret || !wasmPath) {
  process.stderr.write(
    "Usage: DEPLOYER_SECRET=S... node deploy.mjs <wasm-path> [name] [--out <file>]\n",
  );
  process.exit(1);
}

const kp = Keypair.fromSecret(deployerSecret);

async function main() {
  const wasmBuffer = fs.readFileSync(path.resolve(process.cwd(), wasmPath));

  const account = await server.getAccount(kp.publicKey());

  // 1. Upload the contract WASM, get its hash.
  const uploadTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.uploadContractWasm({ wasm: wasmBuffer }))
    .setTimeout(60)
    .build();

  const { getResult: uploadResult } = await submitAndWait(server, kp, uploadTx);
  const wasmHash = uploadResult.returnValue.bytes();
  const wasmHashHex = wasmHash.toString("hex");
  process.stderr.write(`[${contractName}] wasm uploaded, hash: ${wasmHashHex}\n`);

  // 2. Create the contract instance from that wasm hash.
  const account2 = await server.getAccount(kp.publicKey());
  const createTx = new TransactionBuilder(account2, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(kp.publicKey()),
        wasmHash,
        salt: crypto.randomBytes(32),
      }),
    )
    .setTimeout(60)
    .build();

  const { getResult: createResult } = await submitAndWait(server, kp, createTx);
  const contractAddress = Address.fromScAddress(
    createResult.returnValue.address(),
  ).toString();

  process.stderr.write(`[${contractName}] deployed at: ${contractAddress}\n`);

  const ledger = (await server.getLatestLedger()).sequence;

  const record = {
    contractName,
    contractAddress,
    wasmHash: wasmHashHex,
    network: NETWORK,
    rpcUrl: RPC_URL,
    ledger,
  };

  const json = JSON.stringify(record, null, 2) + "\n";
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), outPath)), {
      recursive: true,
    });
    fs.writeFileSync(path.resolve(process.cwd(), outPath), json);
    process.stderr.write(`[${contractName}] record written to ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }

  return contractAddress;
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
