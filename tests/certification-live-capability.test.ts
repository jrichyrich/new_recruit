import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CERTIFICATION_CAPABILITY_BOUNDARY_CODES,
  CERTIFICATION_CAPABILITY_DEPENDENCY_CODES,
  CertificationReportSchema,
} from "../lib/rosterpilot/certification";

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test(
  "a declared delivery boundary stops live certification before connector activity",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-live-boundary-"),
    );
    try {
      const manifest = JSON.parse(
        await readFile(
          path.join(projectRoot, "data", "certification-manifest.json"),
          "utf8",
        ),
      ) as {
        factions: Array<{
          id: string;
          newRecruitDelivery: "required" | "unsupported";
          expectedLimitations: string[];
        }>;
      };
      const faction = manifest.factions.find(
        (candidate) => candidate.id === "adeptus-custodes",
      );
      assert.ok(faction);
      faction.newRecruitDelivery = "unsupported";
      faction.expectedLimitations = [
        ...faction.expectedLimitations,
        "Test-only credential-backed delivery boundary.",
      ];
      const manifestPath = path.join(
        temporary,
        "certification-manifest.json",
      );
      const outputDirectory = path.join(temporary, "bundle");
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/certify.ts",
          "--tier",
          "live",
          "--faction",
          "adeptus-custodes",
          "--manifest",
          manifestPath,
          "--out-dir",
          outputDirectory,
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ROSTERPILOT_CERTIFICATION_LIVE: "1",
            ROSTERPILOT_LOCAL_AGENT_SOCKET: path.join(
              temporary,
              "unreachable-agent.sock",
            ),
            ROSTERPILOT_SUPPORT_DIRECTORY: path.join(
              temporary,
              "support",
            ),
          },
          maxBuffer: 32 * 1024 * 1024,
          timeout: 110_000,
        },
      );
      assert.equal(
        result.status,
        0,
        `${result.stderr}\n${result.stdout}`,
      );

      const reportName = (await readdir(outputDirectory)).find(
        (filename) =>
          filename.startsWith("certification-report-") &&
          filename.endsWith(".json"),
      );
      assert.ok(reportName);
      const report = CertificationReportSchema.parse(
        JSON.parse(
          await readFile(
            path.join(outputDirectory, reportName),
            "utf8",
          ),
        ),
      );
      const delivery = report.cases.find(
        (candidate) =>
          candidate.caseId ===
          "adeptus-custodes:live-new-recruit",
      );
      const simulation = report.cases.find(
        (candidate) =>
          candidate.caseId ===
          "adeptus-custodes:live-tessera",
      );
      assert.equal(delivery?.status, "unsupported");
      assert.equal(
        delivery?.code,
        CERTIFICATION_CAPABILITY_BOUNDARY_CODES.newRecruitDelivery,
      );
      assert.equal(
        delivery?.evidence.newRecruitMutationStarted,
        false,
      );
      assert.equal(simulation?.status, "unsupported");
      assert.equal(
        simulation?.code,
        CERTIFICATION_CAPABILITY_DEPENDENCY_CODES.trustedSimulationBlockedByDelivery,
      );
      assert.equal(
        simulation?.evidence.tesseraMutationStarted,
        false,
      );
      assert.deepEqual(report.connectorEvents, []);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
