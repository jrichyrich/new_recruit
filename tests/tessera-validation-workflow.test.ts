import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  TesseraStressPortfolio,
  TesseraStressRepresentative,
} from "../lib/rosterpilot/types";
import {
  TESSERA_WEB_CAPTURES_PER_OPPONENT,
  advanceTesseraValidationWorkflow,
  confirmTesseraValidationRemainingSix,
  confirmTesseraValidationSuccessor,
  createTesseraValidationWorkflow,
  readTesseraValidationWorkflow,
  validateTesseraValidationRepresentatives,
  verifyTesseraValidationWorkflow,
  type TesseraValidationLocalJobSnapshot,
  type TesseraValidationLocalLaunchRequest,
  type TesseraValidationWebJobSnapshot,
  type TesseraValidationWebLaunchRequest,
  type TesseraValidationWorkflowDependencies,
} from "../local/tessera/validation-workflow";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const postures = [
  "balanced-control",
  "ranged-pressure",
  "assault-pressure",
] as const;
const compositions = ["mixed", "mass", "elite-heavy"] as const;

function portfolio(): TesseraStressPortfolio {
  const items = postures.flatMap((posture, postureIndex) =>
    compositions.map((composition, compositionIndex) => {
      const templateId = `${posture}-${composition}`;
      return {
        templateId,
        posture,
        composition,
        status: "ready" as const,
        roster: {
          schemaVersion: 1,
          rosterId: `roster-${templateId}`,
          name: templateId,
        } as unknown as TesseraStressPortfolio["items"][number]["roster"],
        fingerprint: hash(`structural-${templateId}`),
        simulationFingerprint: hash(`simulation-${templateId}`),
        structuralDistance: postureIndex + compositionIndex / 10,
        detachmentId: `detachment-${postureIndex}`,
        allowNamedCharacters: compositionIndex === 0,
        traits: null,
        compositionEvidence: [`${posture}/${composition}`],
        containsNamedCharacter: compositionIndex === 0,
        omissionReason: null,
        warnings: [],
      };
    }),
  );
  return {
    schemaVersion: 1,
    generatorVersion: "test-v1",
    suite: "diverse-9",
    factionId: "adepta-sororitas",
    factionName: "Adepta Sororitas",
    pointsLimit: 2_000,
    pointsTolerancePercent: 5,
    sourceData: {} as TesseraStressPortfolio["sourceData"],
    items,
    coverage: {
      intended: 9,
      ready: 9,
      unavailable: 0,
      representedPostures: [...postures],
      missingPostures: [],
      representedCompositions: [...compositions],
      missingCompositions: [],
      representedCells: items.map((item) => ({
        templateId: item.templateId,
        posture: item.posture,
        composition: item.composition,
      })),
      missingCells: [],
      uniqueSimulationPayloads: 9,
      namedCharacterCoverage: true,
      namedCharacterCoverageStatus: "included",
      namedCharacterCoverageReason: null,
      maximumResultStatus: "complete",
    },
  };
}

function representatives(): TesseraStressRepresentative[] {
  return [
    {
      kind: "stress",
      templateId: "balanced-control-mixed",
      rationale: "Highest observed risk.",
    },
    {
      kind: "central",
      templateId: "ranged-pressure-mass",
      rationale: "Closest portfolio medoid.",
    },
    {
      kind: "contrast",
      templateId: "assault-pressure-elite-heavy",
      rationale: "Most distinct remaining result.",
    },
  ];
}

type Harness = {
  dependencies: TesseraValidationWorkflowDependencies;
  localLaunches: TesseraValidationLocalLaunchRequest[];
  webLaunches: TesseraValidationWebLaunchRequest[];
  setLocal: (snapshot: TesseraValidationLocalJobSnapshot) => void;
  setWeb: (snapshot: TesseraValidationWebJobSnapshot) => void;
};

function harness(): Harness {
  let tick = 0;
  let localJob = 0;
  let webJob = 0;
  let localSnapshot: TesseraValidationLocalJobSnapshot = {
    executionStatus: "running",
    trustedEvidence: false,
    portfolioSha256: null,
    completedTemplateIds: [],
    representatives: [],
    errorCode: null,
  };
  let webSnapshot: TesseraValidationWebJobSnapshot = {
    executionStatus: "running",
    trustedEvidence: false,
    completedTemplateIds: [],
    comparison: "not-evaluated",
    requiresSuccessor: false,
    errorCode: null,
  };
  const localLaunches: TesseraValidationLocalLaunchRequest[] = [];
  const webLaunches: TesseraValidationWebLaunchRequest[] = [];
  return {
    localLaunches,
    webLaunches,
    setLocal(snapshot) {
      localSnapshot = structuredClone(snapshot);
    },
    setWeb(snapshot) {
      webSnapshot = structuredClone(snapshot);
    },
    dependencies: {
      async launchLocalNine(request) {
        localLaunches.push(structuredClone(request));
        localJob += 1;
        return { jobId: `local-${localJob}`, runId: `local-run-${localJob}` };
      },
      async pollLocalNine() {
        return structuredClone(localSnapshot);
      },
      async launchWebBatch(request) {
        webLaunches.push(structuredClone(request));
        webJob += 1;
        return { jobId: `web-${webJob}`, runId: `web-run-${webJob}` };
      },
      async pollWebBatch() {
        return structuredClone(webSnapshot);
      },
      now() {
        tick += 1;
        return new Date(Date.UTC(2026, 7, 3, 12, 0, tick)).toISOString();
      },
    },
  };
}

async function withStore(
  callback: (storeRoot: string) => Promise<void>,
): Promise<void> {
  const storeRoot = await mkdtemp(
    path.join(os.tmpdir(), "tessera-validation-workflow-"),
  );
  try {
    await callback(storeRoot);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
}

async function startAndCompleteLocal(
  storeRoot: string,
  workflowId: string,
  testHarness: Harness,
): Promise<void> {
  await advanceTesseraValidationWorkflow(
    storeRoot,
    workflowId,
    testHarness.dependencies,
  );
  const created = await readTesseraValidationWorkflow(storeRoot, workflowId);
  testHarness.setLocal({
    executionStatus: "complete",
    trustedEvidence: true,
    portfolioSha256: created.portfolioSha256,
    completedTemplateIds: [...created.frozenTemplateIds],
    representatives: representatives(),
    errorCode: null,
  });
  await advanceTesseraValidationWorkflow(
    storeRoot,
    workflowId,
    testHarness.dependencies,
  );
}

test("standard is the default and the durable document is hash-sealed", async () => {
  await withStore(async (storeRoot) => {
    const state = await createTesseraValidationWorkflow({
      storeRoot,
      workflowId: "standard-default",
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
      now: "2026-08-03T12:00:00.000Z",
    });

    assert.equal(state.validationDepth, "standard");
    assert.equal(state.pendingAction, "start-local-nine");
    assert.equal(state.frozenTemplateIds.length, 9);
    const verified = await verifyTesseraValidationWorkflow(
      storeRoot,
      state.workflowId,
    );
    assert.equal(verified.revisionCount, 1);
    assert.equal(verified.head.sequence, 1);
    assert.equal(verified.state.portfolioSha256, state.portfolioSha256);
  });
});

test("exhaustive Web-nine requires explicit confirmation", async () => {
  await withStore(async (storeRoot) => {
    await assert.rejects(
      createTesseraValidationWorkflow({
        storeRoot,
        workflowId: "exhaustive-not-confirmed",
        playerFingerprint: hash("player"),
        portfolio: portfolio(),
        validationDepth: "exhaustive",
      }),
      /explicitly confirmed/,
    );
    const state = await createTesseraValidationWorkflow({
      storeRoot,
      workflowId: "exhaustive-confirmed",
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
      validationDepth: "exhaustive",
      exhaustiveConfirmation: true,
    });
    assert.equal(state.exhaustiveExplicitlyConfirmed, true);
  });
});

test("standard runs local nine then freezes and completes a Web-three plan", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "standard-happy-path";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
    });

    const started = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(started.action, "local-started");
    assert.equal(testHarness.localLaunches.length, 1);
    assert.equal(testHarness.localLaunches[0].templateIds.length, 9);
    assert.equal(testHarness.localLaunches[0].analysisStrategy, "full-all");
    assert.equal(testHarness.localLaunches[0].metrics, "full-supported");

    const pending = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(pending.changed, false);
    assert.equal(pending.action, "local-pending");

    const current = await readTesseraValidationWorkflow(storeRoot, workflowId);
    testHarness.setLocal({
      executionStatus: "complete",
      trustedEvidence: true,
      portfolioSha256: current.portfolioSha256,
      completedTemplateIds: [...current.frozenTemplateIds],
      representatives: representatives(),
      errorCode: null,
    });
    const planned = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(planned.action, "web-plan-frozen");
    assert.equal(planned.state.web.plannedBatchKind, "representative-three");
    assert.equal(planned.state.web.plannedTemplateIds.length, 3);
    assert.equal(planned.state.web.plannedCaptureCount, 48);
    assert.equal(planned.state.local.evidence, "trusted");

    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(testHarness.webLaunches.length, 1);
    assert.equal(testHarness.webLaunches[0].templateIds.length, 3);
    assert.equal(testHarness.webLaunches[0].expectedCaptureCount, 48);
    assert.equal(
      testHarness.webLaunches[0].comparisonMode,
      "diagnostic-cross-provider",
    );
    testHarness.setWeb({
      executionStatus: "complete",
      trustedEvidence: true,
      completedTemplateIds: [...planned.state.web.plannedTemplateIds],
      comparison: "within-local-bands",
      requiresSuccessor: false,
      errorCode: null,
    });
    const completed = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(completed.state.status, "complete");
    assert.equal(completed.state.web.execution, "succeeded");
    assert.equal(completed.state.web.evidence, "trusted");
    assert.equal(completed.state.pendingAction, "none");
    assert.equal(
      (await verifyTesseraValidationWorkflow(storeRoot, workflowId))
        .revisionCount,
      5,
    );
  });
});

test("untrusted or incomplete local evidence blocks Web before launch", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "local-gate";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
    });
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    testHarness.setLocal({
      executionStatus: "degraded",
      trustedEvidence: false,
      portfolioSha256: hash("wrong-portfolio"),
      completedTemplateIds: ["balanced-control-mixed"],
      representatives: [],
      errorCode: "LOCAL_PARTIAL",
    });
    const rejected = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(rejected.state.status, "needs-review");
    assert.equal(rejected.state.local.execution, "degraded");
    assert.equal(rejected.state.local.evidence, "untrusted");
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(testHarness.webLaunches.length, 0);
  });
});

test("representatives require unique roles and adequate portfolio coverage", () => {
  const value = portfolio();
  const completed = value.items.map((item) => item.templateId);
  const coverage = validateTesseraValidationRepresentatives(
    value,
    representatives(),
    completed,
  );
  assert.equal(coverage.adequate, true);
  assert.equal(coverage.representedPostures.length, 3);

  assert.throws(
    () =>
      validateTesseraValidationRepresentatives(
        value,
        [
          {
            kind: "stress",
            templateId: "balanced-control-mixed",
            rationale: "Risk.",
          },
          {
            kind: "central",
            templateId: "balanced-control-mass",
            rationale: "Center.",
          },
          {
            kind: "contrast",
            templateId: "balanced-control-elite-heavy",
            rationale: "Contrast.",
          },
        ],
        completed,
      ),
    /adequate posture and composition coverage/,
  );
});

for (const comparison of [
  "material-divergence",
  "inconclusive",
  "not-evaluated",
] as const) {
  test(`standard offers but does not auto-start the remaining six for ${comparison}`, async () => {
    await withStore(async (storeRoot) => {
      const workflowId = `offer-${comparison}`;
      const testHarness = harness();
      await createTesseraValidationWorkflow({
        storeRoot,
        workflowId,
        playerFingerprint: hash("player"),
        portfolio: portfolio(),
      });
      await startAndCompleteLocal(storeRoot, workflowId, testHarness);
      const webStarted = await advanceTesseraValidationWorkflow(
        storeRoot,
        workflowId,
        testHarness.dependencies,
      );
      testHarness.setWeb({
        executionStatus:
          comparison === "inconclusive" ? "inconclusive" : "complete",
        trustedEvidence: comparison !== "not-evaluated",
        completedTemplateIds: [
          ...webStarted.state.web.plannedTemplateIds,
        ],
        comparison,
        requiresSuccessor: false,
        errorCode: null,
      });
      const offered = await advanceTesseraValidationWorkflow(
        storeRoot,
        workflowId,
        testHarness.dependencies,
      );
      assert.equal(offered.state.status, "remaining-six-offered");
      assert.equal(offered.state.remainingSix.templateIds.length, 6);
      assert.equal(offered.state.pendingAction, "confirm-remaining-six");
      assert.equal(testHarness.webLaunches.length, 1);

      const stillOffered = await advanceTesseraValidationWorkflow(
        storeRoot,
        workflowId,
        testHarness.dependencies,
      );
      assert.equal(stillOffered.changed, false);
      assert.equal(testHarness.webLaunches.length, 1);

      await assert.rejects(
        confirmTesseraValidationRemainingSix(
          storeRoot,
          workflowId,
          offered.state.sequence - 1,
        ),
        /offer changed/,
      );
      const confirmed = await confirmTesseraValidationRemainingSix(
        storeRoot,
        workflowId,
        offered.state.sequence,
      );
      assert.equal(confirmed.status, "remaining-six-ready");
      assert.equal(confirmed.web.plannedCaptureCount, 96);

      await advanceTesseraValidationWorkflow(
        storeRoot,
        workflowId,
        testHarness.dependencies,
      );
      assert.equal(testHarness.webLaunches.length, 2);
      assert.equal(testHarness.webLaunches[1].batchKind, "remaining-six");
      assert.equal(testHarness.webLaunches[1].templateIds.length, 6);
      assert.equal(testHarness.webLaunches[1].expectedCaptureCount, 96);
    });
  });
}

test("an incomplete representative Web run offers the frozen six", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "incomplete-web";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
    });
    await startAndCompleteLocal(storeRoot, workflowId, testHarness);
    const started = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    testHarness.setWeb({
      executionStatus: "degraded",
      trustedEvidence: true,
      completedTemplateIds: started.state.web.plannedTemplateIds.slice(0, 2),
      comparison: "within-local-bands",
      requiresSuccessor: false,
      errorCode: "ONE_REPRESENTATIVE_MISSING",
    });
    const offered = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(offered.state.status, "remaining-six-offered");
    assert.equal(offered.state.web.execution, "degraded");
    assert.equal(offered.state.web.evidence, "incomplete");
  });
});

test("explicit exhaustive depth plans all nine Web opponents and 144 captures", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "exhaustive-nine";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
      validationDepth: "exhaustive",
      exhaustiveConfirmation: true,
    });
    await startAndCompleteLocal(storeRoot, workflowId, testHarness);
    const ready = await readTesseraValidationWorkflow(storeRoot, workflowId);
    assert.equal(ready.web.plannedBatchKind, "exhaustive-nine");
    assert.equal(ready.web.plannedTemplateIds.length, 9);
    assert.equal(
      ready.web.plannedCaptureCount,
      9 * TESSERA_WEB_CAPTURES_PER_OPPONENT,
    );
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(testHarness.webLaunches[0].batchKind, "exhaustive-nine");
    assert.equal(testHarness.webLaunches[0].templateIds.length, 9);
    testHarness.setWeb({
      executionStatus: "complete",
      trustedEvidence: true,
      completedTemplateIds: [...ready.frozenTemplateIds],
      comparison: "material-divergence",
      requiresSuccessor: false,
      errorCode: null,
    });
    const completed = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(completed.state.status, "complete");
    assert.equal(completed.state.web.comparison, "material-divergence");
    assert.equal(completed.state.remainingSix.offeredAt, null);
  });
});

test("a successor Web job cannot start without fresh confirmation", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "successor-confirmation";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
    });
    await startAndCompleteLocal(storeRoot, workflowId, testHarness);
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    testHarness.setWeb({
      executionStatus: "failed",
      trustedEvidence: false,
      completedTemplateIds: [],
      comparison: "not-evaluated",
      requiresSuccessor: true,
      errorCode: "UNCERTAIN_REMOTE_OUTCOME",
    });
    const offered = await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(offered.state.status, "needs-successor-confirmation");
    assert.equal(offered.state.pendingAction, "confirm-successor");
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(testHarness.webLaunches.length, 1);

    await assert.rejects(
      confirmTesseraValidationSuccessor(
        storeRoot,
        workflowId,
        "wrong-job",
        offered.state.sequence,
      ),
      /offer changed/,
    );
    await confirmTesseraValidationSuccessor(
      storeRoot,
      workflowId,
      "web-1",
      offered.state.sequence,
    );
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    assert.equal(testHarness.webLaunches.length, 2);
    assert.equal(testHarness.webLaunches[1].successorOf?.jobId, "web-1");
  });
});

test("tampered immutable revisions are rejected and older revisions remain", async () => {
  await withStore(async (storeRoot) => {
    const workflowId = "tamper-evidence";
    const testHarness = harness();
    await createTesseraValidationWorkflow({
      storeRoot,
      workflowId,
      playerFingerprint: hash("player"),
      portfolio: portfolio(),
    });
    await advanceTesseraValidationWorkflow(
      storeRoot,
      workflowId,
      testHarness.dependencies,
    );
    const verified = await verifyTesseraValidationWorkflow(
      storeRoot,
      workflowId,
    );
    assert.equal(verified.revisionCount, 2);
    const firstRevision = path.join(
      storeRoot,
      workflowId,
      "revisions",
      (await readFile(path.join(storeRoot, workflowId, "head.json"), "utf8")
        .then((value) => JSON.parse(value) as { revisionFilename: string }))
        .revisionFilename,
    );
    const original = await readFile(firstRevision, "utf8");
    await writeFile(
      firstRevision,
      original.replace(hash("player"), hash("tampered-player")),
    );
    await assert.rejects(
      verifyTesseraValidationWorkflow(storeRoot, workflowId),
      /seal is invalid/,
    );
  });
});

test("portfolio validation rejects fewer than nine and duplicate coverage cells", async () => {
  await withStore(async (storeRoot) => {
    const shortPortfolio = portfolio();
    shortPortfolio.items.pop();
    await assert.rejects(
      createTesseraValidationWorkflow({
        storeRoot,
        workflowId: "short-portfolio",
        playerFingerprint: hash("player"),
        portfolio: shortPortfolio,
      }),
      /exactly nine unique ready opponents/,
    );

    const duplicateCell = portfolio();
    duplicateCell.items[8] = {
      ...duplicateCell.items[8],
      posture: duplicateCell.items[0].posture,
      composition: duplicateCell.items[0].composition,
    };
    await assert.rejects(
      createTesseraValidationWorkflow({
        storeRoot,
        workflowId: "duplicate-cell",
        playerFingerprint: hash("player"),
        portfolio: duplicateCell,
      }),
      /all posture\/composition cells/,
    );
  });
});
