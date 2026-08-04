import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  TesseraMatchupReport,
  TesseraPreparedRoster,
  TesseraUnitInstance,
} from "../lib/rosterpilot";
import {
  compileRosterForLocalTesseraEngine,
  localInputSha256,
  serializeLocalTesseraEngineInput,
  type LocalTesseraEngineInput,
} from "../local/tessera/local-engine-input";
import {
  compileRosterForLocalTesseraEngineV2,
  serializeLocalTesseraEngineInputV2,
  type LocalTesseraEngineInputV2,
} from "../local/tessera/local-engine-input-v2";
import {
  deriveTesseraLocalProviderParityEvidence,
} from "../local/tessera/local-provider-parity-evidence";
import {
  buildCustodesVsAeldariSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";

function unitsFor(
  side: "player" | "opponent",
  input: LocalTesseraEngineInput | LocalTesseraEngineInputV2,
): TesseraUnitInstance[] {
  return input.units.map((unit) => ({
    instanceId: `${side}:${unit.selectionId}:${unit.occurrence}`,
    selectionId: unit.selectionId,
    side,
    name: unit.name,
    label: unit.label,
    ordinal: unit.occurrence,
    modelCount: unit.models,
    points: unit.points ?? 0,
    tags: [],
  }));
}

function prepared(
  side: "player" | "opponent",
  filename: string,
  sha256: string,
  input: LocalTesseraEngineInput | LocalTesseraEngineInputV2,
): TesseraPreparedRoster {
  return {
    fingerprint: input.rosterFingerprint,
    simulationInput: {
      kind: "rosterpilot-local-engine-input",
      path: filename,
      sha256,
      compilerVersion: input.compilerVersion,
      bundleId: input.bundleId,
    },
    units: unitsFor(side, input),
  } as TesseraPreparedRoster;
}

function reportFor(
  player: TesseraPreparedRoster,
  opponent: TesseraPreparedRoster,
): TesseraMatchupReport {
  return {
    player,
    opponents: [opponent],
    simulation: {
      selectedBackend: "local-engine",
    },
  } as unknown as TesseraMatchupReport;
}

test("local provider parity retains exact v2 range and source identity evidence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-parity-v2-"),
  );
  try {
    const roster = buildCustodesVsAeldariSmokeRoster();
    const input = compileRosterForLocalTesseraEngineV2(
      roster,
      resolvedProfilePolicy(roster),
    );
    const content = serializeLocalTesseraEngineInputV2(input);
    const sha256 = localInputSha256(content);
    await Promise.all([
      writeFile(path.join(directory, "player.json"), content),
      writeFile(path.join(directory, "opponent.json"), content),
    ]);

    const result = await deriveTesseraLocalProviderParityEvidence(
      reportFor(
        prepared("player", "player.json", sha256, input),
        prepared("opponent", "opponent.json", sha256, input),
      ),
      {
        reportPath: path.join(directory, "report.json"),
        dataBundleId: input.bundleId,
        rulesEdition: "warhammer-40000-11e",
        rulesPackageVersion: "fixture-v1",
        engineDataSchemaVersion: 1,
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const profiles = result.combatSnapshot.units.flatMap(
      (unit) => unit.attackProfiles,
    );
    assert.ok(profiles.length > 0);
    assert.ok(
      profiles.every((profile) =>
        profile.phase === "shooting"
          ? Number.isSafeInteger(profile.rangeInches) &&
            Number(profile.rangeInches) > 0
          : profile.rangeInches === null,
      ),
    );
    assert.ok(
      result.combatSnapshot.units.every((unit) =>
        unit.evidence.sourceRefs.some((reference) =>
          /^rosterpilot-local-profile-identity:[0-9a-f]{64}$/.test(
            reference,
          ),
        ),
      ),
    );
    assert.ok(
      result.modelCapabilityEnvelope.modeledMechanics.includes(
        "weapon-range",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local provider parity rejects legacy input without the v2 identity contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-parity-v1-"),
  );
  try {
    const roster = buildCustodesVsAeldariSmokeRoster();
    const input = compileRosterForLocalTesseraEngine(
      roster,
      resolvedProfilePolicy(roster),
    );
    const content = serializeLocalTesseraEngineInput(input);
    const sha256 = localInputSha256(content);
    await Promise.all([
      writeFile(path.join(directory, "player.json"), content),
      writeFile(path.join(directory, "opponent.json"), content),
    ]);

    const result = await deriveTesseraLocalProviderParityEvidence(
      reportFor(
        prepared("player", "player.json", sha256, input),
        prepared("opponent", "opponent.json", sha256, input),
      ),
      {
        reportPath: path.join(directory, "report.json"),
        dataBundleId: input.bundleId,
        rulesEdition: "warhammer-40000-11e",
        rulesPackageVersion: "fixture-v1",
        engineDataSchemaVersion: 1,
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.issues.some(
        (entry) => entry.code === "LOCAL_INPUT_SCHEMA_UNSUPPORTED",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
