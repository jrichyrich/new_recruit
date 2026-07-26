import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkDataFreshness } from "../lib/rosterpilot";

type SourceManifest = {
  schemaVersion: 1;
  releaseId: string;
  rules: {
    package: "@alpaca-software/40kdc-data";
    version: string;
    edition: "11th";
    dataslate: string;
  };
  newRecruit: {
    repository: "BSData/wh40k-11e";
    url: string;
    branch: string;
    commit: string;
  };
  official: {
    downloadsUrl: string;
    mfmUrl: string;
    mfmVersion: string;
    updatedAt: string;
    contentSha256: string;
    checkedAt: string;
  };
};

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcesPath = path.join(projectRoot, "data", "sources.json");

function nextReleaseId(current: string, checkedAt: string): string {
  const date = checkedAt.slice(0, 10);
  const match = current.match(new RegExp(`^${date}\\.(\\d+)$`));
  return `${date}.${match ? Number(match[1]) + 1 : 1}`;
}

const source = JSON.parse(
  readFileSync(sourcesPath, "utf8"),
) as SourceManifest;
const freshness = await checkDataFreshness({ timeoutMs: 15_000 });
if (!freshness.data || freshness.data.state === "unknown") {
  throw new Error(
    `Cannot prepare a partial data update: ${freshness.warnings
      .map((item) => item.message)
      .join(" ")}`,
  );
}
if (freshness.data.state === "current") {
  process.stdout.write(
    `${JSON.stringify({ ok: true, changed: false, freshness: freshness.data }, null, 2)}\n`,
  );
  process.exit(0);
}

const next = structuredClone(source);
const latestRulesVersion = freshness.data.rules.latestVersion;
if (
  freshness.data.rules.updateAvailable &&
  latestRulesVersion &&
  latestRulesVersion !== source.rules.version
) {
  execFileSync(
    "npm",
    [
      "install",
      `@alpaca-software/40kdc-data@${latestRulesVersion}`,
      "--save-exact",
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  next.rules.version = latestRulesVersion;
}

const latestCommit = freshness.data.newRecruit.latestCommit;
if (
  freshness.data.newRecruit.updateAvailable &&
  latestCommit &&
  latestCommit !== source.newRecruit.commit
) {
  next.newRecruit.commit = latestCommit;
}

if (freshness.data.official.updateAvailable) {
  next.official.mfmVersion =
    freshness.data.official.latestVersion ?? source.official.mfmVersion;
  next.official.contentSha256 =
    freshness.data.official.latestContentSha256 ??
    source.official.contentSha256;
}
next.official.checkedAt = freshness.data.checkedAt;
next.releaseId = nextReleaseId(source.releaseId, freshness.data.checkedAt);
writeFileSync(sourcesPath, `${JSON.stringify(next, null, 2)}\n`);

execFileSync(
  process.execPath,
  ["--import", "tsx", "scripts/sync-bsdata.ts", "--write"],
  { cwd: projectRoot, stdio: "inherit" },
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      changed: true,
      previousReleaseId: source.releaseId,
      releaseId: next.releaseId,
      freshness: freshness.data,
    },
    null,
    2,
  )}\n`,
);
