/**
 * Parity test for scripts/error-codes.mjs (#858).
 *
 * Parses each contract's error.rs to build the ground-truth set of
 * (code → name) pairs, then asserts the hand-maintained errorMappings
 * table matches exactly — no missing entries, no stale ones.
 *
 * Run with: node --test scripts/error-codes.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMappings } from "./error-codes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

/** Parse `Variant = N,` lines from a Rust #[contracterror] enum. */
function parseErrorRs(contractDir) {
  const src = readFileSync(
    resolve(root, "contracts", contractDir, "src", "error.rs"),
    "utf8",
  );
  const result = {};
  // Match lines like: `    SomeName = 42,` or `    SomeName = 42` (last variant has no comma)
  for (const [, name, code] of src.matchAll(/^\s+(\w+)\s*=\s*(\d+)\s*,?$/gm)) {
    result[Number(code)] = name;
  }
  return result;
}

const groundTruth = {
  escrow: parseErrorRs("escrow"),
  milestones: parseErrorRs("milestones"),
  maintenancePool: parseErrorRs("maintenance-pool"),
};

describe("error-codes.mjs parity with error.rs (#858)", () => {
  for (const [contract, rsMap] of Object.entries(groundTruth)) {
    const jsMap = errorMappings[contract];

    describe(`${contract}`, () => {
      test("errorMappings key exists for this contract", () => {
        assert.ok(jsMap, `errorMappings has no '${contract}' key`);
      });

      // Every code in error.rs must appear in errorMappings.
      for (const [code, name] of Object.entries(rsMap)) {
        test(`code ${code} (${name}) is present in errorMappings`, () => {
          assert.strictEqual(
            jsMap[code],
            name,
            `errorMappings.${contract}[${code}] should be "${name}" but got "${jsMap[code]}"`,
          );
        });
      }

      // Every code in errorMappings must still exist in error.rs (no stale entries).
      for (const [code, name] of Object.entries(jsMap ?? {})) {
        test(`errorMappings code ${code} (${name}) still exists in error.rs`, () => {
          assert.strictEqual(
            rsMap[code],
            name,
            `errorMappings.${contract}[${code}] = "${name}" but error.rs has "${rsMap[code] ?? "(nothing)"}"`,
          );
        });
      }
    });
  }
});
