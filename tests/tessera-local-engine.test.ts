import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  currentRosterSourceData,
  type ProfilePolicyV1,
} from "../lib/rosterpilot";
import {
  compileEnrichedRoszForLocalEngine,
  LOCAL_TESSERA_ENGINE_IDENTITY,
  runLocalTesseraEngineMatchup,
} from "../local/tessera/local-engine";
import {
  LOCAL_TESSERA_COMPILER_VERSION,
  localInputSha256,
  serializeLocalTesseraEngineInput,
  type LocalTesseraEngineInput,
  type LocalTesseraEngineUnit,
} from "../local/tessera/local-engine-input";
import { composeSelectedLocalTesseraFormations } from
  "../local/tessera/local-engine-formation";
import { profilePolicyHash } from "../local/tessera/profile-policy";
import {
  activationEnvelopeTesseraScenarioPolicyContractV2,
  withSelectedTesseraAttachmentBindingsV2,
} from "../local/tessera/scenario-contract-v2";
import {
  activationEnvelopeTesseraScenarioPolicyContractV3,
  withSelectedTesseraAttachmentBindingsV3,
} from "../local/tessera/scenario-contract-v3";
import { projectLocalTesseraScenarioV3Cell } from
  "../local/tessera/scenario-v3-execution";

function enrichedRosz(input: {
  rosterName: string;
  unitName: string;
  selectionId: string;
  weaponKeyword?: string;
  ability?: string;
  rule?: string;
  pistolChoice?: boolean;
  extraMeleeChoice?: boolean;
  uppercaseSave?: boolean;
  invulnerableAbility?: boolean;
  alternateRifleProfiles?: boolean;
}): Uint8Array {
  const ability = input.ability
    ? `<profile name="Active ability" typeName="Abilities"><characteristics><characteristic name="Description">${input.ability}</characteristic></characteristics></profile>`
    : "";
  const rule = input.rule
    ? `<rules><rule name="Selected combat rule"><description>${input.rule}</description></rule></rules>`
    : "";
  const invulnerableAbility = input.invulnerableAbility
    ? `<profile name="Invulnerable Save" typeName="Abilities"><characteristics><characteristic name="Description">4+ invulnerable save</characteristic></characteristics></profile>`
    : "";
  const rifleProfiles = input.alternateRifleProfiles
    ? `<profile name="➤ Fixture rifle - focused" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">2</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">${input.weaponKeyword ?? "Rapid Fire 1"}</characteristic>
        </characteristics></profile><profile name="➤ Fixture rifle - dispersed" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">4</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">3</characteristic><characteristic name="AP">0</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile>`
    : `<profile name="Fixture rifle" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">2</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">${input.weaponKeyword ?? "Rapid Fire 1"}</characteristic>
        </characteristics></profile>`;
  const pistol = input.pistolChoice
    ? `<selection id="${input.selectionId}-pistol" name="Fixture pistol" number="2" type="upgrade"><profiles><profile name="Fixture pistol" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">12&quot;</characteristic><characteristic name="A">1</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">0</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">Pistol</characteristic>
        </characteristics></profile></profiles></selection>`
    : "";
  const secondBlade = input.extraMeleeChoice
    ? `<selection id="${input.selectionId}-axe" name="Fixture axe" number="2" type="upgrade"><profiles><profile name="Fixture axe" typeName="Melee Weapons"><characteristics>
          <characteristic name="Range">Melee</characteristic><characteristic name="A">2</characteristic><characteristic name="WS">3+</characteristic><characteristic name="S">5</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>`
    : "";
  const xml = `<?xml version="1.0"?>
<roster name="${input.rosterName}" generatedBy="https://newrecruit.eu" gameSystemId="fixture-system" gameSystemName="Warhammer 40,000 11th Edition" gameSystemRevision="1">
  <costs><cost name="pts" value="100" /></costs>
  <forces><force name="Fixture" catalogueName="Fixture Faction" catalogueId="fixture" catalogueRevision="1"><selections>
    <selection id="${input.selectionId}" name="${input.unitName}" number="1" type="unit">
      <profiles>
        <profile name="${input.unitName}" typeName="Unit"><characteristics>
          <characteristic name="M">6&quot;</characteristic><characteristic name="T">4</characteristic><characteristic name="${input.uppercaseSave ? "SV" : "Sv"}">3+</characteristic><characteristic name="W">2</characteristic><characteristic name="LD">6+</characteristic><characteristic name="OC">1</characteristic>${input.invulnerableAbility ? "" : '<characteristic name="InSv">-</characteristic>'}
        </characteristics></profile>
        ${ability}
        ${invulnerableAbility}
      </profiles>
      ${rule}
      <selections>
        <selection id="${input.selectionId}-models" name="Fixture models" number="2" type="model" />
        <selection id="${input.selectionId}-rifle" name="Fixture rifle" number="2" type="upgrade"><profiles>${rifleProfiles}</profiles></selection>
        ${pistol}
        <selection id="${input.selectionId}-blade" name="Fixture blade" number="2" type="upgrade"><profiles><profile name="Fixture blade" typeName="Melee Weapons"><characteristics>
          <characteristic name="Range">Melee</characteristic><characteristic name="A">2</characteristic><characteristic name="WS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>
        ${secondBlade}
      </selections>
      <costs><cost name="pts" value="100" /></costs>
      <categories><category name="Infantry" /></categories>
    </selection>
  </selections></force></forces>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

test("strict local compiler preserves selected counts, profiles, and immutable identity", () => {
  const compiled = compileEnrichedRoszForLocalEngine(
    enrichedRosz({
      rosterName: "Player",
      unitName: "Wardens",
      selectionId: "wardens-1",
    }),
  );

  assert.equal(compiled.units.length, 1);
  assert.equal(compiled.units[0].selectionId, "wardens-1");
  assert.equal(compiled.units[0].models, 2);
  assert.equal(compiled.units[0].weapons.length, 2);
  assert.equal(compiled.units[0].weapons[0].count, 2);
  assert.deepEqual(compiled.units[0].keywords, ["INFANTRY"]);
  assert.equal(LOCAL_TESSERA_ENGINE_IDENTITY.promotion, "candidate");
  assert.equal(LOCAL_TESSERA_ENGINE_IDENTITY.licenseState, "evaluation-only");
});

test("selected attachment bindings preserve the activation envelope and exact side scope", () => {
  const v2 = withSelectedTesseraAttachmentBindingsV2(
    activationEnvelopeTesseraScenarioPolicyContractV2(
      10,
      ["shooting"],
      ["mean-damage"],
    ),
    [{
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: ["support-b", "support-a"],
    }],
  );
  assert.equal(v2.policy.activations.mode, "envelope");
  assert.deepEqual(v2.policy.attachments, {
    mode: "selected",
    bindings: [{
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: ["support-a", "support-b"],
    }],
  });

  const baselineV3 = activationEnvelopeTesseraScenarioPolicyContractV3(
    10,
    {
      playerSelectionIds: ["player-unit"],
      opponentSelectionIds: [
        "opponent-leader",
        "opponent-bodyguard",
        "opponent-bodyguard-2",
        "support-a",
        "support-b",
      ],
    },
    ["shooting"],
    ["mean-damage"],
  );
  const v3 = withSelectedTesseraAttachmentBindingsV3(
    baselineV3,
    [{
      side: "opponent",
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: ["support-b", "support-a"],
    }],
  );
  assert.equal(v3.policy.activations.mode, "envelope");
  assert.deepEqual(v3.policy.attachments, {
    mode: "selected",
    bindings: [{
      side: "opponent",
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: ["support-a", "support-b"],
    }],
  });

  assert.throws(
    () =>
      withSelectedTesseraAttachmentBindingsV3(baselineV3, [{
        side: "player",
        leaderSelectionId: "opponent-leader",
        bodyguardSelectionId: "opponent-bodyguard",
        supportingSelectionIds: [],
      }]),
    /is not declared on the player side/,
  );
  assert.throws(
    () =>
      withSelectedTesseraAttachmentBindingsV3(baselineV3, [
        {
          side: "opponent",
          leaderSelectionId: "opponent-leader",
          bodyguardSelectionId: "opponent-bodyguard",
          supportingSelectionIds: [],
        },
        {
          side: "opponent",
          leaderSelectionId: "opponent-leader",
          bodyguardSelectionId: "opponent-bodyguard-2",
          supportingSelectionIds: [],
        },
      ]),
    /occurs in bindings 0 and 1/,
  );
});

test("selected attachment activation envelope executes one physical formation", async () => {
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "rosterpilot-local-engine-attached-state-",
  ));
  try {
    const profilePolicy = {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [],
    } satisfies ProfilePolicyV1;
    const bundleId = currentRosterSourceData("adeptus-custodes").bundleId;
    const unit = (
      selectionId: string,
      label: string,
      instance: number,
    ): LocalTesseraEngineUnit => ({
      instanceId: instance.toString(16).padStart(24, "0"),
      selectionId,
      occurrence: 1,
      label,
      name: label,
      models: 1,
      T: 4,
      SV: 3,
      W: 2,
      INV: null,
      FNP: null,
      points: 100,
      keywords: ["INFANTRY"],
      weapons: [{
        name: `${label} rifle`,
        type: "ranged",
        rangeInches: 24,
        count: 1,
        A: 1,
        BS: 3,
        S: 4,
        AP: 0,
        D: 1,
        keywords: [],
      }],
    });
    const playerUnit = unit("player-unit", "Player unit", 1);
    const opponentLeader = unit("opponent-leader", "Opponent leader", 2);
    const opponentBodyguard = unit(
      "opponent-bodyguard",
      "Opponent bodyguard",
      3,
    );
    const input = (
      rosterId: string,
      rosterName: string,
      units: LocalTesseraEngineUnit[],
    ): LocalTesseraEngineInput => ({
      schemaVersion: 1,
      kind: "rosterpilot-local-engine-input",
      compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      evaluationMode: "base-profile-evaluation",
      bundleId,
      rosterId,
      rosterFingerprint: `${rosterId}-fingerprint`,
      rosterName,
      factionId: "adeptus-custodes",
      factionName: "Adeptus Custodes",
      totalPoints: units.reduce(
        (sum, candidate) => sum + (candidate.points ?? 0),
        0,
      ),
      profilePolicySha256: profilePolicyHash(profilePolicy),
      profileRequirements: [],
      units,
      limitations: {
        unmodeledSystems: ["fixture-only systems"],
        omittedDatasheetAbilities: [],
        omittedWargear: [],
        omittedEnhancements: [],
        unsupportedWeaponKeywords: [],
        frozenChoices: [],
      },
    });
    const playerInput = input("player", "Player", [playerUnit]);
    const opponentInput = input("opponent", "Opponent", [
      opponentLeader,
      opponentBodyguard,
    ]);
    const scenarioPolicyContractV3 =
      withSelectedTesseraAttachmentBindingsV3(
        activationEnvelopeTesseraScenarioPolicyContractV3(
          5,
          {
            playerSelectionIds: [playerUnit.selectionId],
            opponentSelectionIds: opponentInput.units.map(
              (candidate) => candidate.selectionId,
            ),
          },
          ["shooting"],
          ["mean-damage"],
        ),
        [{
          side: "opponent",
          leaderSelectionId: opponentLeader.selectionId,
          bodyguardSelectionId: opponentBodyguard.selectionId,
          supportingSelectionIds: [],
        }],
      );
    const opponentFormation = composeSelectedLocalTesseraFormations({
      rosterFingerprint: opponentInput.rosterFingerprint,
      attachmentPlanId: "selected-attachment",
      units: opponentInput.units,
      bindings: scenarioPolicyContractV3.policy.attachments.bindings,
    })[0]!;
    assert.equal(opponentFormation.attachmentPlanId, "selected-attachment");
    assert.notEqual(opponentFormation.attachmentPlanId, "unattached");
    assert.deepEqual(opponentFormation.memberSelectionIds, [
      "opponent-bodyguard",
      "opponent-leader",
    ]);

    const playerToOpponent = scenarioPolicyContractV3.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    )!;
    const attachedProjection = projectLocalTesseraScenarioV3Cell({
      scenario: playerToOpponent,
      attacker: playerUnit,
      target: opponentFormation,
    });
    const bodyguardOnlyProjection = projectLocalTesseraScenarioV3Cell({
      scenario: playerToOpponent,
      attacker: playerUnit,
      target: opponentBodyguard,
    });
    assert.notEqual(
      attachedProjection.combatStateSha256,
      bodyguardOnlyProjection.combatStateSha256,
      "formation membership must remain part of the combat-state identity",
    );
    const inconsistent = structuredClone(playerToOpponent);
    inconsistent.state.pairs.find(
      (pair) => pair.targetSelectionId === "opponent-leader",
    )!.targetVisible = false;
    assert.throws(
      () =>
        projectLocalTesseraScenarioV3Cell({
          scenario: inconsistent,
          attacker: playerUnit,
          target: opponentFormation,
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_FORMATION_STATE_INCONSISTENT",
    );

    const playerContent = serializeLocalTesseraEngineInput(playerInput);
    const opponentContent = serializeLocalTesseraEngineInput(opponentInput);
    const playerPath = path.join(directory, "player.json");
    const opponentPath = path.join(directory, "opponent.json");
    await Promise.all([
      writeFile(playerPath, playerContent),
      writeFile(opponentPath, opponentContent),
    ]);
    const result = await runLocalTesseraEngineMatchup({
      profileDirectory: directory,
      playerRoszPath: playerPath,
      playerName: playerInput.rosterName,
      opponentRoszPath: opponentPath,
      opponentName: opponentInput.rosterName,
      playerSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: playerPath,
        sha256: localInputSha256(playerContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      opponentSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: opponentPath,
        sha256: localInputSha256(opponentContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      phases: ["shooting"],
      metrics: ["mean-damage"],
      profilePolicy,
      scenarioPolicyContractV3,
    });
    assert.equal(result.scenarios.length, 2);
    assert.equal(
      result.scenarios.every((scenario) => scenario.cells.length === 1),
      true,
    );
    assert.equal(
      result.scenarios.some((scenario) =>
        scenario.cells.some(
          (cell) =>
            cell.attacker === "Opponent bodyguard + Opponent leader" ||
            cell.target === "Opponent bodyguard + Opponent leader",
        )
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local compiler accepts New Recruit save casing, numeric invulnerable profiles, and frozen alternate names", () => {
  const compiled = compileEnrichedRoszForLocalEngine(
    enrichedRosz({
      rosterName: "Player",
      unitName: "Wardens",
      selectionId: "wardens-1",
      uppercaseSave: true,
      invulnerableAbility: true,
      alternateRifleProfiles: true,
    }),
    {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [
        {
          faction: "Fixture Faction",
          unit: "Wardens",
          unitOccurrence: 1,
          modelCount: 2,
          weaponGroup: "Fixture rifle",
          phase: "shooting",
          selectedProfile: "focused",
          activeCount: 2,
        },
      ],
    },
  );

  assert.equal(compiled.units[0].SV, 3);
  assert.equal(compiled.units[0].INV, 4);
  assert.equal(compiled.units[0].weapons[0].name, "➤ Fixture rifle - focused");
});

test("local runner emits deterministic browser-compatible full matrices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-local-engine-"));
  try {
    const playerPath = path.join(directory, "player.rosz");
    const opponentPath = path.join(directory, "opponent.rosz");
    await Promise.all([
      writeFile(
        playerPath,
        enrichedRosz({
          rosterName: "Player",
          unitName: "Wardens",
          selectionId: "wardens-1",
        }),
      ),
      writeFile(
        opponentPath,
        enrichedRosz({
          rosterName: "Opponent",
          unitName: "Guardians",
          selectionId: "guardians-1",
        }),
      ),
    ]);
    const input = {
      profileDirectory: directory,
      playerRoszPath: playerPath,
      playerName: "Player",
      opponentRoszPath: opponentPath,
      opponentName: "Opponent",
    };
    const first = await runLocalTesseraEngineMatchup(input);
    const second = await runLocalTesseraEngineMatchup(input);

    assert.equal(first.scenarios.length, 16);
    assert.equal(first.scenarios.every((scenario) => scenario.cells.length === 1), true);
    assert.deepEqual(
      first.scenarios.map((scenario) => scenario.matrixSha256),
      second.scenarios.map((scenario) => scenario.matrixSha256),
    );
    assert.equal(
      first.scenarios.every((scenario) =>
        scenario.cells.every(
          (cell) =>
            cell.uncertainty?.completeness === "complete" &&
            cell.uncertainty.sampleCount === scenario.iterations &&
            cell.uncertainty.standardDeviation !== null &&
            cell.uncertainty.standardError ===
              cell.uncertainty.standardDeviation /
                Math.sqrt(scenario.iterations!),
        ),
      ),
      true,
      "local simulations must retain per-cell sample count, deviation, and standard error",
    );
    assert.equal(first.uiIdentity, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local runner falls back from null phase saves and honors numeric phase overrides", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-local-engine-invulnerable-"));
  try {
    const bundleId = currentRosterSourceData("adeptus-custodes").bundleId;
    const profilePolicy = {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [],
    } satisfies ProfilePolicyV1;
    const baseInput = {
      schemaVersion: 1,
      kind: "rosterpilot-local-engine-input",
      compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      evaluationMode: "base-profile-evaluation",
      bundleId,
      rosterId: "invulnerable-save-fixture",
      rosterFingerprint: "invulnerable-save-fixture-fingerprint",
      rosterName: "Invulnerable save fixture",
      factionId: "adeptus-custodes",
      factionName: "Adeptus Custodes",
      totalPoints: 100,
      profilePolicySha256: profilePolicyHash(profilePolicy),
      profileRequirements: [],
      limitations: {
        unmodeledSystems: ["fixture-only systems"],
        omittedDatasheetAbilities: [],
        omittedWargear: [],
        omittedEnhancements: [],
        unsupportedWeaponKeywords: [],
        frozenChoices: [],
      },
    } satisfies Omit<LocalTesseraEngineInput, "units">;
    const playerInput: LocalTesseraEngineInput = {
      ...baseInput,
      rosterId: "invulnerable-save-attacker",
      rosterName: "Invulnerable save attacker",
      units: [
        {
          instanceId: "111111111111111111111111",
          selectionId: "attacker-1",
          occurrence: 1,
          label: "Attack fixture",
          name: "Attack fixture",
          models: 1,
          T: 4,
          SV: 3,
          W: 2,
          INV: null,
          FNP: null,
          points: 100,
          keywords: ["INFANTRY"],
          weapons: [
            {
              name: "Ranged fixture",
              type: "ranged",
              count: 1,
              A: 120,
              BS: 2,
              S: 20,
              AP: -6,
              D: 1,
              keywords: [],
            },
            {
              name: "Melee fixture",
              type: "melee",
              count: 1,
              A: 120,
              WS: 2,
              S: 20,
              AP: -6,
              D: 1,
              keywords: [],
            },
          ],
        },
      ],
    };
    const opponentInput: LocalTesseraEngineInput = {
      ...baseInput,
      rosterId: "invulnerable-save-defender",
      rosterName: "Invulnerable save defender",
      units: [
        {
          instanceId: "222222222222222222222222",
          selectionId: "defender-1",
          occurrence: 1,
          label: "Defence fixture",
          name: "Defence fixture",
          models: 200,
          T: 1,
          SV: 7,
          W: 1,
          INV: 4,
          rangedINV: null,
          meleeINV: 6,
          FNP: null,
          points: 100,
          keywords: ["INFANTRY"],
          weapons: [
            {
              name: "Defender ranged fixture",
              type: "ranged",
              count: 1,
              A: 1,
              BS: 4,
              S: 1,
              AP: 0,
              D: 1,
              keywords: [],
            },
            {
              name: "Defender melee fixture",
              type: "melee",
              count: 1,
              A: 1,
              WS: 4,
              S: 1,
              AP: 0,
              D: 1,
              keywords: [],
            },
          ],
        },
      ],
    };
    const playerContent = serializeLocalTesseraEngineInput(playerInput);
    const opponentContent = serializeLocalTesseraEngineInput(opponentInput);
    const playerPath = path.join(directory, "player.json");
    const opponentPath = path.join(directory, "opponent.json");
    await Promise.all([
      writeFile(playerPath, playerContent),
      writeFile(opponentPath, opponentContent),
    ]);

    const matchupInput = {
      profileDirectory: directory,
      playerRoszPath: playerPath,
      playerName: playerInput.rosterName,
      opponentRoszPath: opponentPath,
      opponentName: opponentInput.rosterName,
      playerSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: playerPath,
        sha256: localInputSha256(playerContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      opponentSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: opponentPath,
        sha256: localInputSha256(opponentContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      phases: ["shooting", "fight"],
      metrics: ["mean-damage"],
      profilePolicy,
    } satisfies Parameters<typeof runLocalTesseraEngineMatchup>[0];
    const result = await runLocalTesseraEngineMatchup(matchupInput);
    const playerDamage = Object.fromEntries(
      result.scenarios
        .filter(
          (scenario) =>
            scenario.direction === "player-to-opponent" &&
            scenario.metric === "mean-damage",
        )
        .map((scenario) => [scenario.phase, scenario.cells[0].metricValue]),
    );

    assert.ok(
      playerDamage.shooting > 35 && playerDamage.shooting < 48,
      `Expected rangedINV: null to fall back to the unconditional 4+ save; observed ${playerDamage.shooting}.`,
    );
    assert.ok(
      playerDamage.fight > 62 && playerDamage.fight < 77,
      `Expected meleeINV: 6 to override the unconditional 4+ save; observed ${playerDamage.fight}.`,
    );
    assert.ok(playerDamage.fight > playerDamage.shooting + 20);
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        ...matchupInput,
        profilePolicy: null,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_PROFILE_POLICY_CHANGED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local compiler fails closed on unsupported active rules", () => {
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          weaponKeyword: "Mystery Barrage D3",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_KEYWORD_UNSUPPORTED",
  );
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          ability: "Each time this unit attacks, re-roll the Hit roll.",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_ACTIVE_ABILITY_UNSUPPORTED",
  );
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          rule: "Each time this unit attacks, re-roll the Wound roll.",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_ACTIVE_RULE_UNSUPPORTED",
  );
});

test("local compiler rejects ambiguous phase weapon choices", () => {
  for (const candidate of [
    { pistolChoice: true },
    { extraMeleeChoice: true },
  ]) {
    assert.throws(
      () =>
        compileEnrichedRoszForLocalEngine(
          enrichedRosz({
            rosterName: "Unsupported",
            unitName: "Choice unit",
            selectionId: "choice-1",
            ...candidate,
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
    );
  }
});

test("local runner rejects unknown frozen settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-local-engine-settings-"));
  try {
    const playerPath = path.join(directory, "player.rosz");
    const opponentPath = path.join(directory, "opponent.rosz");
    await Promise.all([
      writeFile(playerPath, enrichedRosz({ rosterName: "Player", unitName: "Wardens", selectionId: "wardens-1" })),
      writeFile(opponentPath, enrichedRosz({ rosterName: "Opponent", unitName: "Guardians", selectionId: "guardians-1" })),
    ]);
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        profileDirectory: directory,
        playerRoszPath: playerPath,
        playerName: "Player",
        opponentRoszPath: opponentPath,
        opponentName: "Opponent",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        frozenScenarioContract: [
          {
            phase: "shooting",
            direction: "player-to-opponent",
            metric: "mean-damage",
            settings: { provider: "local-engine", phase: "shooting", unsupportedToggle: "true" },
            iterations: 1,
          },
          {
            phase: "shooting",
            direction: "opponent-to-player",
            metric: "mean-damage",
            settings: { provider: "local-engine", phase: "shooting", unsupportedToggle: "true" },
            iterations: 1,
          },
        ],
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_SETTING_UNSUPPORTED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
