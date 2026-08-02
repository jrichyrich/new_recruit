import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProviderCompatibilityRollout,
  type ProviderCompatibilityRotationObservation,
} from "../local/certification/provider-compatibility-rollout";

const CANARIES = ["custodes-aeldari", "death-guard-orks"];

function observation(
  index: number,
  status: "pass" | "fail" | "unavailable" = "pass",
  providerCompatibilityMode: "observe" | "enforce" = "observe",
): ProviderCompatibilityRotationObservation {
  return {
    schemaVersion: 1,
    observationKind: "provider-compatibility-rotation",
    rotationId: `rotation-${index}`,
    observedAt: new Date(Date.UTC(2026, 7, index)).toISOString(),
    bundleId: "a".repeat(64),
    bundleTrustIdentitySha256: "c".repeat(64),
    providerCompatibilityMode,
    canaries: CANARIES.map((canaryId) => ({
      canaryId,
      status,
      compatibilityComplete: status === "pass",
      envelopeSha256: status === "pass" ? "b".repeat(64) : null,
    })),
  };
}

test("provider compatibility observes until three consecutive live rotations pass", () => {
  const first = evaluateProviderCompatibilityRollout({
    observations: [observation(1), observation(2)],
    requiredCanaryIds: CANARIES,
  });
  assert.equal(first.enforcementActive, false);
  assert.equal(first.releaseGate, "observe");
  assert.equal(first.consecutivePasses, 2);

  const activated = evaluateProviderCompatibilityRollout({
    observations: [observation(3), observation(1), observation(2)],
    requiredCanaryIds: CANARIES,
  });
  assert.equal(activated.enforcementActive, true);
  assert.equal(
    activated.enforcementActivatedAtRotationId,
    "rotation-3",
  );
  assert.equal(activated.releaseGate, "pass");
});

test("a failed live rotation resets the pre-enforcement streak", () => {
  const evaluated = evaluateProviderCompatibilityRollout({
    observations: [
      observation(1),
      observation(2, "fail"),
      observation(3),
      observation(4),
    ],
    requiredCanaryIds: CANARIES,
  });
  assert.equal(evaluated.enforcementActive, false);
  assert.equal(evaluated.consecutivePasses, 2);
  assert.equal(evaluated.releaseGate, "observe");
});

test("enforcement is sticky and an outage blocks release without becoming rollback evidence", () => {
  const evaluated = evaluateProviderCompatibilityRollout({
    observations: [
      observation(1),
      observation(2),
      observation(3),
      observation(4, "unavailable"),
    ],
    requiredCanaryIds: CANARIES,
  });
  assert.equal(evaluated.enforcementActive, true);
  assert.equal(evaluated.latestStatus, "unavailable");
  assert.equal(evaluated.releaseGate, "block");
  assert.match(evaluated.reasons.join("\n"), /not rolled back/i);
});

test("the durable latch blocks without retained evidence and requires enforced runtime evidence", () => {
  const expired = evaluateProviderCompatibilityRollout({
    observations: [],
    requiredCanaryIds: CANARIES,
    enforcementLatchActive: true,
  });
  assert.equal(expired.enforcementActive, true);
  assert.equal(expired.latestStatus, "missing");
  assert.equal(expired.releaseGate, "block");

  const observed = evaluateProviderCompatibilityRollout({
    observations: [observation(4)],
    requiredCanaryIds: CANARIES,
    enforcementLatchActive: true,
  });
  assert.equal(observed.releaseGate, "block");
  assert.match(observed.reasons.join("\n"), /observation mode/i);

  const enforced = evaluateProviderCompatibilityRollout({
    observations: [observation(5, "pass", "enforce")],
    requiredCanaryIds: CANARIES,
    enforcementLatchActive: true,
  });
  assert.equal(enforced.releaseGate, "pass");
  assert.equal(enforced.latestProviderCompatibilityMode, "enforce");
});

test("missing, duplicate, or hash-incomplete canaries cannot activate enforcement", () => {
  const missing = observation(1);
  missing.canaries.pop();
  const duplicate = observation(2);
  duplicate.canaries[1].canaryId = duplicate.canaries[0].canaryId;
  const incomplete = observation(3);
  incomplete.canaries[0].envelopeSha256 = null;
  const evaluated = evaluateProviderCompatibilityRollout({
    observations: [missing, duplicate, incomplete],
    requiredCanaryIds: CANARIES,
  });
  assert.equal(evaluated.enforcementActive, false);
  assert.equal(evaluated.releaseGate, "observe");
  assert.equal(evaluated.consecutivePasses, 0);
});
