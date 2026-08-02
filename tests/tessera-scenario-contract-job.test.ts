import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRoster } from "../lib/rosterpilot";
import {
  cancelTesseraRun,
  getTesseraRunStatus,
  restartTesseraRunFrom,
  startTesseraRun,
  type TesseraRunRequest,
} from "../local/tessera/jobs";
import {
  localTesseraScenarioContract,
  tesseraScenarioContractSha256,
} from "../local/tessera/scenario-contract";

function exactRequest(
  scenarioContract = localTesseraScenarioContract(2_000),
): TesseraRunRequest {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
  });
  const opponent = buildRoster({
    faction: "aeldari",
    pointsLimit: 1_000,
  });
  assert.ok(player.ok && player.data);
  assert.ok(opponent.ok && opponent.data);
  return {
    kind: "exact",
    playerRoster: player.data,
    opponent: { kind: "roster", roster: opponent.data },
    options: {
      simulationBackend: "local-engine",
      executionMode: "simulate",
      analysisMode: "full",
      scenarioContract,
    },
  };
}

test("durable jobs persist, hash, and restart with the exact canonical scenario contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-scenario-job-"),
  );
  try {
    const contract = localTesseraScenarioContract(2_000);
    const job = await startTesseraRun(exactRequest(contract), {
      rootDir: directory,
      outputDirectory: path.join(directory, "runs"),
      launch: false,
    });
    const stored = JSON.parse(
      await readFile(job.requestPath, "utf8"),
    ) as {
      request: TesseraRunRequest;
      scenarioContractSha256: string | null;
    };
    assert.equal(stored.request.kind, "exact");
    assert.deepEqual(
      stored.request.options?.scenarioContract,
      contract,
    );
    assert.equal(
      stored.scenarioContractSha256,
      tesseraScenarioContractSha256(contract),
    );

    await cancelTesseraRun(job.requestPath);
    const restarted = await restartTesseraRunFrom(
      job.requestPath,
      {
        rootDir: directory,
        outputDirectory: path.join(directory, "runs"),
        launch: false,
      },
    );
    const restartedStored = JSON.parse(
      await readFile(restarted.requestPath, "utf8"),
    ) as {
      request: TesseraRunRequest;
      scenarioContractSha256: string | null;
    };
    assert.deepEqual(
      restartedStored.request.options?.scenarioContract,
      contract,
    );
    assert.equal(
      restartedStored.scenarioContractSha256,
      tesseraScenarioContractSha256(contract),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable jobs reject invalid scopes and changed scenario-contract receipts", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-scenario-job-reject-"),
  );
  try {
    const contract = localTesseraScenarioContract(100);
    await assert.rejects(
      startTesseraRun(exactRequest(contract.slice(1)), {
        rootDir: directory,
        outputDirectory: path.join(directory, "runs"),
        launch: false,
      }),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        ),
    );
    const job = await startTesseraRun(exactRequest(contract), {
      rootDir: directory,
      outputDirectory: path.join(directory, "runs"),
      launch: false,
    });
    const stored = JSON.parse(
      await readFile(job.requestPath, "utf8"),
    ) as Record<string, unknown>;
    stored.scenarioContractSha256 = "f".repeat(64);
    await writeFile(
      job.requestPath,
      `${JSON.stringify(stored, null, 2)}\n`,
    );
    await assert.rejects(
      getTesseraRunStatus(job.requestPath),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "TESSERA_JOB_PROVENANCE_CHANGED",
        ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
