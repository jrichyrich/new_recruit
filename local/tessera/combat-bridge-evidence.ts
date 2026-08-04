import crypto from "node:crypto";

import type {
  CombatBridgeV2,
  TesseraCombatBridgeEvidence,
} from "../../lib/rosterpilot";
import type { CombatBridgeV3 } from "../../lib/rosterpilot/combat-bridge-v3";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";

export type CompactCombatBridgeEvidenceInput = {
  bridge: CombatBridgeV2 | CombatBridgeV3;
  opponentName: string;
  scenarioPolicyContractV2Sha256?: string | null;
  scenarioPolicyContractV3Sha256?: string | null;
  playerInputSha256: string;
  opponentInputSha256: string;
};

function sha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function sequenceSha256(values: Iterable<unknown>): string {
  const hash = crypto.createHash("sha256");
  hash.update("rosterpilot-canonical-sequence-v1\0");
  for (const value of values) {
    const encoded = canonicalJson(value);
    hash.update(String(Buffer.byteLength(encoded, "utf8")));
    hash.update(":");
    hash.update(encoded);
  }
  return hash.digest("hex");
}

function* compactVariantIndex(
  cells: readonly CombatBridgeV2["cells"][number][],
): Generator<unknown> {
  for (const cell of cells) {
    for (const variant of cell.variants) {
      yield {
        mechanicsSha256: cell.mechanicsSha256,
        variantId: variant.variantId,
        variantSha256: variant.variantSha256,
        attachmentPlanId: variant.attachmentPlan.id,
        activationId: variant.activation.id,
      };
    }
  }
}

/**
 * Produces a bounded report record without copying rule text, effects, or
 * resolved modifiers. The two index hashes let a regenerated full bridge be
 * checked at cell/variant granularity while the bridge hash remains the
 * authoritative content identity.
 */
export function compactCombatBridgeEvidence(
  input: CompactCombatBridgeEvidenceInput,
): TesseraCombatBridgeEvidence {
  const cells = [...input.bridge.cells].sort((left, right) =>
    left.cellId < right.cellId ? -1 : left.cellId > right.cellId ? 1 : 0,
  );
  const mechanicsCells = [
    ...new Map(
      cells.map((cell) => [cell.mechanicsSha256, cell]),
    ).values(),
  ].sort((left, right) =>
    left.mechanicsSha256 < right.mechanicsSha256
      ? -1
      : left.mechanicsSha256 > right.mechanicsSha256
        ? 1
        : 0,
  );
  const variantIndexSha256 = sequenceSha256(
    compactVariantIndex(mechanicsCells),
  );
  const uniqueMechanicsCount = mechanicsCells.length;
  if (input.bridge.schemaVersion === 3) {
    const replay = input.bridge.exactness.replay;
    const scenarioPolicyContractV3Sha256 =
      input.scenarioPolicyContractV3Sha256 ?? null;
    if (
      !scenarioPolicyContractV3Sha256 ||
      replay.scenarioContractV3Sha256 !==
        scenarioPolicyContractV3Sha256 ||
      replay.localInputV2Sha256s?.player !==
        input.playerInputSha256 ||
      replay.localInputV2Sha256s?.opponent !==
        input.opponentInputSha256
    ) {
      throw new TypeError(
        "Combat bridge v3 evidence does not match the frozen scenario and local-input replay bindings.",
      );
    }
    const core = {
      schemaVersion: 2 as const,
      kind: "rosterpilot-combat-bridge-evidence" as const,
      opponentName: input.opponentName,
      bridgeSha256: input.bridge.bridgeSha256,
      combatBridgeV3Sha256: input.bridge.bridgeSha256,
      legacyBridgeV2Sha256:
        input.bridge.exactness.legacyBridgeV2Sha256,
      corpusConformanceReportSha256:
        input.bridge.exactness.corpus.reportSha256,
      corpusSourceInventorySha256:
        input.bridge.exactness.corpus.sourceInventorySha256,
      corpusSemanticsOverlaySha256:
        input.bridge.exactness.corpus.overlaySha256,
      compiler: input.bridge.compiler,
      bundle: input.bridge.bundle,
      policySha256: input.bridge.policySha256,
      coverage: input.bridge.coverage,
      coverageUnit: input.bridge.coverageUnit,
      cellCount: cells.length,
      executableMechanicsCount: mechanicsCells.filter(
        (cell) => cell.variants.length > 0,
      ).length,
      variantCount: mechanicsCells.reduce(
        (count, cell) => count + cell.variants.length,
        0,
      ),
      uniqueMechanicsCount,
      cellIndexSha256: input.bridge.cellIndexSha256,
      variantIndexSha256,
      diagnosticsSha256: sha256(input.bridge.diagnostics),
      replay: {
        mode: "deterministic-recompile" as const,
        scenarioPolicyContractV2Sha256:
          input.scenarioPolicyContractV2Sha256 ?? null,
        scenarioPolicyContractV3Sha256,
        playerInputSha256: input.playerInputSha256,
        opponentInputSha256: input.opponentInputSha256,
      },
    };
    return {
      ...core,
      evidenceSha256: sha256(core),
    };
  }
  if (!input.scenarioPolicyContractV2Sha256) {
    throw new TypeError(
      "Combat bridge v2 evidence requires its frozen scenario-policy v2 digest.",
    );
  }
  const core = {
    schemaVersion: 1 as const,
    kind: "rosterpilot-combat-bridge-evidence" as const,
    opponentName: input.opponentName,
    bridgeSha256: input.bridge.bridgeSha256,
    compiler: input.bridge.compiler,
    bundle: input.bridge.bundle,
    policySha256: input.bridge.policySha256,
    coverage: input.bridge.coverage,
    coverageUnit: input.bridge.coverageUnit,
    cellCount: cells.length,
    executableMechanicsCount: mechanicsCells.filter(
      (cell) => cell.variants.length > 0,
    ).length,
    variantCount: mechanicsCells.reduce(
      (count, cell) => count + cell.variants.length,
      0,
    ),
    uniqueMechanicsCount,
    cellIndexSha256: input.bridge.cellIndexSha256,
    variantIndexSha256,
    diagnosticsSha256: sha256(input.bridge.diagnostics),
    replay: {
      mode: "deterministic-recompile" as const,
      scenarioPolicyContractV2Sha256:
        input.scenarioPolicyContractV2Sha256,
      playerInputSha256: input.playerInputSha256,
      opponentInputSha256: input.opponentInputSha256,
    },
  };
  return {
    ...core,
    evidenceSha256: sha256(core),
  };
}
