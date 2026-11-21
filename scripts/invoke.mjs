import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Contract,
  Address,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { submitAndWait } from "./lib/submit.mjs";
import { formatError } from "./error-codes.mjs";

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const server = new rpc.Server(RPC_URL);

export function parseArg(raw) {
  if (raw === "none") return nativeToScVal(null, { type: "void" });

  const [type, value] = raw.split(":");
  if (type === "address") return nativeToScVal(new Address(value), { type: "address" });
  if (type === "recipients") {
    if (!value) {
      throw new Error("Invalid recipients argument: expected address=u32,...");
    }

    const recipients = value.split(",").map((entry) => {
      const [address, bps, ...extra] = entry.split("=");
      if (!address || !bps || extra.length > 0 || !/^\d+$/.test(bps)) {
        throw new Error(`Invalid recipients entry: ${entry}`);
      }
      const share = Number(bps);
      if (!Number.isSafeInteger(share) || share > 0xffffffff) {
        throw new Error(`Recipient basis points must fit u32: ${bps}`);
      }
      return xdr.ScVal.scvVec([
        nativeToScVal(new Address(address), { type: "address" }),
        nativeToScVal(share, { type: "u32" }),
      ]);
    });
    return xdr.ScVal.scvVec(recipients);
  }
  if (type === "u32") return nativeToScVal(parseInt(value, 10), { type: "u32" });
  if (type === "u64") return nativeToScVal(BigInt(value), { type: "u64" });
  if (type === "i128" || type === "some-i128") {
    return nativeToScVal(BigInt(value), { type: "i128" });
  }
  if (type === "bool") {
    if (value !== "true" && value !== "false") {
      throw new Error(`Invalid bool argument: ${value}`);
    }
    return nativeToScVal(value === "true", { type: "bool" });
  }
  if (type === "bytes32") {
    const hex = value?.replace(/^0x/i, "");
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("bytes32 arguments must be exactly 32 bytes of hexadecimal");
    }
    return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
  }
  throw new Error(`Unknown arg type: ${type}`);
}

// Well-known read-only view methods that never need a signer.  Passing
// --simulate is always explicit; this list lets the script auto-infer it
// when the caller omits the flag but the method is obviously a read.
export const VIEW_METHODS = new Set([
  "is_paused",
  "version",
  "get_escrow",
  "get_bounty",
  "get_config",
  "get_recipient",
  "get_recipients",
  "total_bounties",
  "owner",
]);

/** Decode a simulation return value to a human-readable string. */
function formatRetval(retval) {
  if (!retval) return "(void)";
  try {
    const { scValToNative } = await import("@stellar/stellar-sdk");
    return JSON.stringify(scValToNative(retval));
  } catch {
    return retval.toXDR("base64");
  }
}

async function main() {
  const rawArgv = process.argv.slice(2);

  // --simulate flag: stop after simulateTransaction, no signing key required.
  const simulateIdx = rawArgv.indexOf("--simulate");
  const explicitSimulate = simulateIdx !== -1;
  const positional = explicitSimulate
    ? rawArgv.filter((_, i) => i !== simulateIdx)
    : rawArgv;

  const [contractId, method, ...args] = positional;

  const simulateMode = explicitSimulate || VIEW_METHODS.has(method);

  const secret = process.env.INVOKER_SECRET || process.env.DEPLOYER_SECRET;

  if (!contractId || !method) {
    console.error("Usage: INVOKER_SECRET=S... node invoke.mjs <contractId> <method> [args...]");
    console.error("   or: node invoke.mjs --simulate <contractId> <method> [args...]");
    process.exitCode = 1;
    return;
  }

  if (!simulateMode && !secret) {
    console.error("Usage: INVOKER_SECRET=S... node invoke.mjs <contractId> <method> [args...]");
    console.error("   or: DEPLOYER_SECRET=S... node invoke.mjs <contractId> <method> [args...]");
    console.error("   or: node invoke.mjs --simulate <contractId> <method> [args...]");
    process.exitCode = 1;
    return;
  }

  const contract = new Contract(contractId);
  const scArgs = args.map(parseArg);

  if (simulateMode) {
    // Simulation only: build a transaction from a throwaway keypair so the RPC
    // has a valid source account without needing a funded signer.
    const throwaway = Keypair.random();
    const account = new rpc.Account(throwaway.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...scArgs))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new Error("Simulation requires ledger entry restore; run without --simulate to submit.");
    }

    const retval = sim.result?.retval;
    console.log(`${method} (simulated):`, retval ? retval.toXDR("base64") : "(void)");
    try {
      const { scValToNative } = await import("@stellar/stellar-sdk");
      console.log("decoded:", JSON.stringify(scValToNative(retval), null, 2));
    } catch {
      // scValToNative unavailable or type not decodable — raw XDR already printed above
    }
    return;
  }

  const kp = Keypair.fromSecret(secret);
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...scArgs))
    .setTimeout(60)
    .build();

  const { sendResult } = await submitAndWait(server, kp, tx);
  console.log(`${method} succeeded. hash: ${sendResult.hash}`);
}

// Derive the contract name from the CONTRACT_NAME env var (set by deploy
// scripts) or from the method prefix so formatError can narrow error meanings
// to the contract that was actually called.
const CONTRACT_NAME = process.env.CONTRACT_NAME ?? null;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(formatError(err, CONTRACT_NAME));
    process.exit(1);
  });
}
