import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  buildProviderCompatibilityRolloutArtifact,
  providerCompatibilityRolloutExitCode,
  runProviderCompatibilityRollout,
  writeProviderCompatibilityRolloutArtifact,
  type ProviderCompatibilityRolloutArtifact,
} from "../local/certification/provider-compatibility-rollout-artifact";
import {
  LIVE_CANARY_IDS,
  type LiveCanaryId,
} from "../local/certification/live-canaries";
import {
  parseProviderCompatibilityRolloutArguments,
  providerCompatibilityRolloutHelp,
} from "../scripts/provider-compatibility-rollout";

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeVerifiedJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filename, content);
  await writeFile(
    `${filename}.sha256`,
    `${digest(content)}  ${path.basename(filename)}\n`,
  );
}

function liveCanaryReport(input: {
  rotation: number;
  canaryId: LiveCanaryId;
  status?: "pass" | "fail" | "unavailable";
  providerCompatibilityStatus?: "pass" | "fail" | "unavailable";
  providerCompatibilityMode?: "observe" | "enforce";
}): Record<string, unknown> {
  const status = input.status ?? "pass";
  const timestamp = new Date(
    Date.UTC(2026, 7, input.rotation, 12),
  ).toISOString();
  const compatibilityStatus =
    input.providerCompatibilityStatus ?? status;
  const complete = compatibilityStatus === "pass";
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-rotating-live-canary",
    reportId: `${input.canaryId}-${input.rotation}`,
    canary: { id: input.canaryId },
    startedAt: timestamp,
    completedAt: timestamp,
    status,
    livePass: status === "pass",
    evidenceKind: status === "unavailable" ? "none" : "live",
    readiness: {},
    runtime: {},
    dataBundle: {
      bundleId: "a".repeat(64),
      signingKeyId: "test-key",
      manifestSha256: "b".repeat(64),
      semanticIdentitySha256: "c".repeat(64),
      bundleTrustIdentitySha256: "f".repeat(64),
    },
    providerCompatibility: {
      policy: "observe-then-enforce-v1",
      requiredConsecutivePasses: 3,
      mode: input.providerCompatibilityMode ?? "observe",
      rotationId: `rotation-${input.rotation}`,
      status: compatibilityStatus,
      complete,
      envelopes:
        compatibilityStatus === "unavailable"
          ? []
          : [
              {
                provider: "local-engine",
                envelopeSha256: "d".repeat(64),
                bundleId: "a".repeat(64),
                signingKeyId: "test-key",
                manifestSha256: "b".repeat(64),
                semanticIdentitySha256: "c".repeat(64),
                bundleTrustIdentitySha256: "f".repeat(64),
                complete,
                issueCodes: complete
                  ? []
                  : ["provider-mismatch"],
              },
              {
                provider: "website",
                envelopeSha256: "e".repeat(64),
                bundleId: "a".repeat(64),
                signingKeyId: "test-key",
                manifestSha256: "b".repeat(64),
                semanticIdentitySha256: "c".repeat(64),
                bundleTrustIdentitySha256: "f".repeat(64),
                complete,
                issueCodes: complete
                  ? []
                  : ["provider-mismatch"],
              },
            ],
    },
    localAgent: {},
    profilePolicy: {},
    fixtureInputs: [],
    assertions: [],
    run: null,
    providerParity:
      input.canaryId === "death-guard-vs-orks-exact-1000"
        ? {
            policy:
              "live-numerical-parity-observe-then-enforce-v1",
            mode: "observe",
            status: "pass",
            complete: true,
            eligible: true,
          }
        : null,
    revision: null,
    failure: null,
    limitations: [],
  };
}

async function writeRotation(
  directory: string,
  rotation: number,
  canaryIds: readonly LiveCanaryId[] = LIVE_CANARY_IDS,
  providerCompatibilityMode: "observe" | "enforce" = "observe",
): Promise<void> {
  for (const canaryId of canaryIds) {
    await writeVerifiedJson(
      path.join(
        directory,
        `live-canary-${canaryId}-rotation-${rotation}.json`,
      ),
      liveCanaryReport({
        rotation,
        canaryId,
        providerCompatibilityMode,
      }),
    );
  }
}

async function withTemporaryDirectory(
  prefix: string,
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCli(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(
          "scripts/provider-compatibility-rollout.ts",
        ),
        ...args,
      ],
      { cwd: path.resolve(".") },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("rollout artifacts retain verified history and activate after three complete rotations", async () => {
  await withTemporaryDirectory(
    "rosterpilot-provider-rollout-",
    async (directory) => {
      const priorSources = path.join(directory, "prior-sources");
      await writeRotation(priorSources, 1);
      await writeRotation(priorSources, 2);
      const prior =
        await buildProviderCompatibilityRolloutArtifact({
          reportsRoot: priorSources,
          generatedAt: "2026-08-03T00:00:00.000Z",
        });
      assert.equal(prior.evaluation.releaseGate, "observe");
      assert.equal(prior.evaluation.consecutivePasses, 2);

      const reportsRoot = path.join(directory, "retained");
      const priorPath = path.join(
        reportsRoot,
        "history",
        "provider-compatibility-rollout-prior.json",
      );
      await writeProviderCompatibilityRolloutArtifact({
        artifact: prior,
        outputPath: priorPath,
      });
      await writeRotation(path.join(reportsRoot, "current"), 3);

      const outputPath = path.join(
        reportsRoot,
        "provider-compatibility-rollout.json",
      );
      const written = await runProviderCompatibilityRollout({
        reportsRoot,
        outputPath,
        generatedAt: "2026-08-04T00:00:00.000Z",
      });
      assert.equal(written.artifact.observations.length, 3);
      assert.equal(
        written.artifact.evaluation.enforcementActive,
        true,
      );
      assert.equal(written.artifact.evaluation.releaseGate, "pass");
      assert.equal(
        providerCompatibilityRolloutExitCode(
          written.artifact.evaluation,
        ),
        0,
      );
      const content = await readFile(outputPath);
      assert.equal(digest(content), written.sha256);
      assert.equal(
        await readFile(`${outputPath}.sha256`, "utf8"),
        `${written.sha256}  ${path.basename(outputPath)}\n`,
      );
    },
  );
});

test("an incomplete latest rotation blocks only after enforcement is sticky", async () => {
  await withTemporaryDirectory(
    "rosterpilot-provider-block-",
    async (directory) => {
      await writeRotation(directory, 1);
      await writeRotation(directory, 2);
      await writeRotation(directory, 3);
      await writeRotation(directory, 4, [LIVE_CANARY_IDS[0]]);
      const outputPath = path.join(
        directory,
        "provider-compatibility-rollout.json",
      );
      const built = await runProviderCompatibilityRollout({
        reportsRoot: directory,
        outputPath,
        generatedAt: "2026-08-05T00:00:00.000Z",
      });
      assert.equal(built.artifact.evaluation.enforcementActive, true);
      assert.equal(
        built.artifact.evaluation.latestStatus,
        "unavailable",
      );
      assert.equal(built.artifact.evaluation.releaseGate, "block");
      assert.equal(
        providerCompatibilityRolloutExitCode(
          built.artifact.evaluation,
        ),
        2,
      );

      const cli = await runCli([
        "--reports-root",
        directory,
        "--out",
        outputPath,
      ]);
      assert.equal(cli.code, 2, cli.stderr);
      assert.doesNotMatch(cli.stderr, /rollout rejected|failure/i);
      assert.match(cli.stdout, /"releaseGate": "block"/);
    },
  );
});

test("observation mode retains a legacy canary pass as failed compatibility evidence", async () => {
  await withTemporaryDirectory(
    "rosterpilot-provider-observe-fail-",
    async (directory) => {
      for (const canaryId of LIVE_CANARY_IDS) {
        await writeVerifiedJson(
          path.join(directory, `live-canary-${canaryId}.json`),
          liveCanaryReport({
            rotation: 1,
            canaryId,
            status: "pass",
            providerCompatibilityStatus: "fail",
            providerCompatibilityMode: "observe",
          }),
        );
      }
      const artifact =
        await buildProviderCompatibilityRolloutArtifact({
          reportsRoot: directory,
          generatedAt: "2026-08-03T00:00:00.000Z",
        });
      assert.equal(artifact.evaluation.latestStatus, "fail");
      assert.equal(artifact.evaluation.releaseGate, "observe");
      assert.equal(artifact.evaluation.enforcementActive, false);
    },
  );
});

test("a durable latch survives expired history and requires an enforced current rotation", async () => {
  await withTemporaryDirectory(
    "rosterpilot-provider-latched-",
    async (directory) => {
      const empty = await runProviderCompatibilityRollout({
        reportsRoot: directory,
        outputPath: path.join(
          directory,
          "provider-compatibility-rollout-empty.json",
        ),
        enforcementLatchActive: true,
      });
      assert.equal(empty.artifact.evaluation.enforcementActive, true);
      assert.equal(empty.artifact.evaluation.releaseGate, "block");

      await writeRotation(directory, 5, LIVE_CANARY_IDS, "enforce");
      const enforced = await runProviderCompatibilityRollout({
        reportsRoot: directory,
        outputPath: path.join(
          directory,
          "provider-compatibility-rollout-enforced.json",
        ),
        enforcementLatchActive: true,
      });
      assert.equal(enforced.artifact.evaluation.releaseGate, "pass");
      assert.equal(
        enforced.artifact.evaluation.latestProviderCompatibilityMode,
        "enforce",
      );
    },
  );
});

test("rollout discovery rejects unverified, drifted, and schema-invalid evidence", async (context) => {
  await context.test("missing checksum", async () => {
    await withTemporaryDirectory(
      "rosterpilot-provider-missing-",
      async (directory) => {
        const filename = path.join(
          directory,
          "live-canary-missing.json",
        );
        await writeFile(
          filename,
          `${JSON.stringify(
            liveCanaryReport({
              rotation: 1,
              canaryId: LIVE_CANARY_IDS[0],
            }),
          )}\n`,
        );
        await assert.rejects(
          buildProviderCompatibilityRolloutArtifact({
            reportsRoot: directory,
          }),
          /detached checksum is missing or unreadable/,
        );
      },
    );
  });

  await context.test("checksum drift", async () => {
    await withTemporaryDirectory(
      "rosterpilot-provider-drift-",
      async (directory) => {
        const filename = path.join(
          directory,
          "live-canary-drift.json",
        );
        await writeVerifiedJson(
          filename,
          liveCanaryReport({
            rotation: 1,
            canaryId: LIVE_CANARY_IDS[0],
          }),
        );
        await writeFile(filename, "{}\n");
        await assert.rejects(
          buildProviderCompatibilityRolloutArtifact({
            reportsRoot: directory,
          }),
          /bytes do not match the detached checksum/,
        );
      },
    );
  });

  await context.test("unknown live report fields", async () => {
    await withTemporaryDirectory(
      "rosterpilot-provider-schema-",
      async (directory) => {
        const report = liveCanaryReport({
          rotation: 1,
          canaryId: LIVE_CANARY_IDS[0],
        });
        report.unexpected = true;
        await writeVerifiedJson(
          path.join(directory, "live-canary-schema.json"),
          report,
        );
        await assert.rejects(
          buildProviderCompatibilityRolloutArtifact({
            reportsRoot: directory,
          }),
          /schema validation failed.*Unrecognized key/,
        );
      },
    );
  });

  await context.test("signed-bundle trust binding mismatch", async () => {
    await withTemporaryDirectory(
      "rosterpilot-provider-trust-mismatch-",
      async (directory) => {
        const report = liveCanaryReport({
          rotation: 1,
          canaryId: LIVE_CANARY_IDS[0],
        }) as {
          providerCompatibility: {
            envelopes: Array<{
              bundleTrustIdentitySha256: string;
            }>;
          };
        };
        report.providerCompatibility.envelopes[0]
          .bundleTrustIdentitySha256 = "0".repeat(64);
        await writeVerifiedJson(
          path.join(directory, "live-canary-trust-mismatch.json"),
          report,
        );
        await assert.rejects(
          buildProviderCompatibilityRolloutArtifact({
            reportsRoot: directory,
          }),
          /trust and update identity|inconsistent with its envelopes/,
        );
      },
    );
  });
});

test("checksum-valid retained artifacts are re-evaluated before reuse", async () => {
  await withTemporaryDirectory(
    "rosterpilot-provider-retained-",
    async (directory) => {
      const sources = path.join(directory, "sources");
      await writeRotation(sources, 1);
      const artifact =
        await buildProviderCompatibilityRolloutArtifact({
          reportsRoot: sources,
          generatedAt: "2026-08-03T00:00:00.000Z",
        });
      const tampered = structuredClone(
        artifact,
      ) as ProviderCompatibilityRolloutArtifact;
      tampered.evaluation.releaseGate = "pass";
      await writeVerifiedJson(
        path.join(
          directory,
          "provider-compatibility-rollout-tampered.json",
        ),
        tampered,
      );
      await assert.rejects(
        buildProviderCompatibilityRolloutArtifact({
          reportsRoot: directory,
        }),
        /retained evaluation does not match its observations/,
      );
    },
  );
});

test("rollout CLI parsing is explicit and documented", () => {
  const parsed = parseProviderCompatibilityRolloutArguments([
    "--reports-root",
    "fixtures",
    "--out",
    "provider-compatibility-rollout-test.json",
    "--enforcement-latch",
    "enforce",
  ]);
  assert.equal(parsed.reportsRoot, path.resolve("fixtures"));
  assert.equal(
    parsed.outputPath,
    path.resolve("provider-compatibility-rollout-test.json"),
  );
  assert.equal(parsed.enforcementLatchActive, true);
  assert.match(providerCompatibilityRolloutHelp(), /three consecutive/i);
  assert.throws(
    () =>
      parseProviderCompatibilityRolloutArguments(["--unknown"]),
    /Unknown provider compatibility rollout option/,
  );
});
