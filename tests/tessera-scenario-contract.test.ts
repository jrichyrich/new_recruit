import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTesseraScenarioContractProvider,
  assertTesseraScenarioContractScope,
  canonicalTesseraScenarioContract,
  localTesseraScenarioContract,
  projectTesseraScenarioContract,
  tesseraScenarioContractSha256,
} from "../local/tessera/scenario-contract";

test("iteration sugar and explicit JSON canonicalize to one scenario contract", () => {
  const generated = localTesseraScenarioContract(2_000);
  const explicit = canonicalTesseraScenarioContract(
    [...generated]
      .reverse()
      .map((entry) => ({
        ...entry,
        settings: Object.fromEntries(
          Object.entries(entry.settings).reverse(),
        ),
      })),
  );
  assert.deepEqual(explicit, generated);
  assert.equal(
    tesseraScenarioContractSha256(explicit),
    tesseraScenarioContractSha256(generated),
  );
  assert.equal(generated.length, 16);
});

test("scenario contracts reject missing, repeated, invalid, and provider-mismatched entries", () => {
  const generated = localTesseraScenarioContract(2_000);
  assert.throws(
    () =>
      assertTesseraScenarioContractScope(
        generated.slice(1),
        ["shooting", "fight"],
        [
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ],
      ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      ),
  );
  assert.throws(
    () =>
      canonicalTesseraScenarioContract([
        generated[0],
        generated[0],
      ]),
    /repeats/i,
  );
  assert.throws(
    () =>
      canonicalTesseraScenarioContract([
        { ...generated[0], iterations: 0 },
      ]),
    /invalid/i,
  );
  assert.throws(
    () =>
      assertTesseraScenarioContractProvider(
        generated,
        "website",
      ),
    /does not match/i,
  );
});

test("stress-stage projection is explicit and retains exact iteration/settings values", () => {
  const generated = localTesseraScenarioContract(777);
  const screening = projectTesseraScenarioContract(
    generated,
    ["shooting", "fight"],
    ["half-wipe-probability"],
  );
  const deepDive = projectTesseraScenarioContract(
    generated,
    ["shooting", "fight"],
    ["wipe-probability", "mean-kills", "mean-damage"],
  );
  assert.equal(screening.length, 4);
  assert.equal(deepDive.length, 12);
  assert.equal(
    [...screening, ...deepDive].every(
      (entry) => entry.iterations === 777,
    ),
    true,
  );
});
