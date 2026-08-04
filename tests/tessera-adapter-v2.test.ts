import assert from "node:assert/strict";
import test from "node:test";

import type {
  LocalTesseraEngineUnit,
} from "../local/tessera/local-engine-input";
import {
  LOCAL_TESSERA_ADAPTER_VERSION,
  LOCAL_TESSERA_CAPABILITY_MANIFEST,
  LOCAL_TESSERA_ENGINE_IDENTITY,
} from "../local/tessera/local-engine";
import {
  applyTrackedTesseraAdapterV2Patches,
  TRACKED_TESSERA_ADAPTER_V2_VERSION,
  TrackedTesseraAdapterV2Error,
  type TesseraDefenderUnitPatchV2,
} from "../local/tessera/tessera-adapter-v2";

type AttachedUnitFixture = LocalTesseraEngineUnit & {
  attached: LocalTesseraEngineUnit[];
};

function defender(): AttachedUnitFixture {
  return {
    instanceId: "body-instance",
    selectionId: "body-selection",
    unitId: "body-unit",
    occurrence: 1,
    label: "Bodyguard",
    name: "Bodyguard",
    models: 5,
    T: 4,
    SV: 4,
    W: 2,
    INV: null,
    FNP: null,
    points: 100,
    keywords: ["INFANTRY"],
    weapons: [],
    profiles: [{
      name: "Champion",
      count: 1,
      T: 3,
      SV: 5,
      W: 2,
      INV: null,
      FNP: null,
    }],
    attached: [
      {
        instanceId: "leader-instance",
        selectionId: "leader-selection",
        unitId: "leader-unit",
        occurrence: 1,
        label: "Leader",
        name: "Leader",
        models: 1,
        T: 5,
        SV: 3,
        W: 5,
        INV: null,
        FNP: null,
        points: 80,
        keywords: ["CHARACTER"],
        weapons: [],
      },
      {
        instanceId: "support-instance",
        selectionId: "support-selection",
        unitId: "support-unit",
        occurrence: 1,
        label: "Support",
        name: "Support",
        models: 1,
        T: 4,
        SV: 4,
        W: 4,
        INV: null,
        FNP: null,
        points: 60,
        keywords: ["CHARACTER"],
        weapons: [],
      },
    ],
  };
}

function patch(
  input: Partial<TesseraDefenderUnitPatchV2> &
    Pick<TesseraDefenderUnitPatchV2, "id" | "scope">,
): TesseraDefenderUnitPatchV2 {
  return {
    side: "defender",
    bearerSelectionId: null,
    effectIds: [`${input.id}-effect`],
    ...input,
  };
}

test("tracked adapter-v2 applies unit-wide save and Toughness to every defensive group", () => {
  const original = defender();
  const result = applyTrackedTesseraAdapterV2Patches(original, [
    patch({
      id: "unit-wide",
      scope: "unit-wide",
      saveModifier: 1,
      toughnessModifier: 1,
    }),
  ]) as AttachedUnitFixture;

  assert.deepEqual(
    { SV: result.SV, T: result.T },
    { SV: 3, T: 5 },
  );
  assert.deepEqual(
    result.profiles?.map(({ SV, T }) => ({ SV, T })),
    [{ SV: 4, T: 4 }],
  );
  assert.deepEqual(
    result.attached.map(({ SV, T }) => ({ SV, T })),
    [{ SV: 2, T: 6 }, { SV: 3, T: 5 }],
  );
  assert.deepEqual(
    { SV: original.SV, T: original.T },
    { SV: 4, T: 4 },
    "the tracked adapter must not mutate frozen local input",
  );
});

test("tracked adapter-v2 stacks a bearer patch only on the named attached member", () => {
  const result = applyTrackedTesseraAdapterV2Patches(defender(), [
    patch({
      id: "unit-wide",
      scope: "unit-wide",
      saveModifier: 1,
      toughnessModifier: 1,
    }),
    patch({
      id: "leader-only",
      scope: "bearer",
      bearerSelectionId: "leader-selection",
      saveModifier: 1,
      toughnessModifier: 2,
    }),
  ]) as AttachedUnitFixture;

  assert.deepEqual(
    { SV: result.SV, T: result.T },
    { SV: 3, T: 5 },
  );
  assert.deepEqual(
    result.attached.map(({ selectionId, SV, T }) => ({
      selectionId,
      SV,
      T,
    })),
    [
      { selectionId: "leader-selection", SV: 1, T: 8 },
      { selectionId: "support-selection", SV: 3, T: 5 },
    ],
  );
});

test("tracked adapter-v2 rejects missing and multi-model bearers", () => {
  assert.throws(
    () => applyTrackedTesseraAdapterV2Patches(defender(), [
      patch({
        id: "missing",
        scope: "bearer",
        bearerSelectionId: "not-present",
        toughnessModifier: 1,
      }),
    ]),
    (error: unknown) =>
      error instanceof TrackedTesseraAdapterV2Error &&
      error.code === "TESSERA_ADAPTER_V2_BEARER_NOT_FOUND",
  );
  assert.throws(
    () => applyTrackedTesseraAdapterV2Patches(defender(), [
      patch({
        id: "body-bearer",
        scope: "bearer",
        bearerSelectionId: "body-selection",
        saveModifier: 1,
      }),
    ]),
    (error: unknown) =>
      error instanceof TrackedTesseraAdapterV2Error &&
      error.code === "TESSERA_ADAPTER_V2_BEARER_MODEL_AMBIGUOUS",
  );
});

test("local capability identity declares tracked adapter-v2 and blocking gaps", () => {
  assert.equal(LOCAL_TESSERA_CAPABILITY_MANIFEST.schemaVersion, 2);
  assert.equal(
    LOCAL_TESSERA_CAPABILITY_MANIFEST.trackedAdapterVersion,
    TRACKED_TESSERA_ADAPTER_V2_VERSION,
  );
  assert.equal(
    LOCAL_TESSERA_ENGINE_IDENTITY.adapterVersion,
    LOCAL_TESSERA_ADAPTER_VERSION,
  );
  assert.match(
    LOCAL_TESSERA_ENGINE_IDENTITY.capabilityManifestSha256,
    /^[0-9a-f]{64}$/,
  );
  assert.ok(
    LOCAL_TESSERA_CAPABILITY_MANIFEST.unitCharacteristics.some(
      (entry) => /unit-wide additive save and Toughness/i.test(entry),
    ),
  );
  assert.ok(
    LOCAL_TESSERA_CAPABILITY_MANIFEST.unsupported.every(
      (entry) => !/save modifiers/i.test(entry),
    ),
  );
  assert.ok(
    LOCAL_TESSERA_CAPABILITY_MANIFEST.unsupported.some(
      (entry) => /damage rerolls.*blocking/i.test(entry),
    ),
  );
  assert.ok(
    LOCAL_TESSERA_CAPABILITY_MANIFEST.unsupported.some(
      (entry) => /mortal-only feel-no-pain.*blocking/i.test(entry),
    ),
  );
});
