import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BsDataHistoryResolverError,
  MAX_BSDATA_COMPATIBILITY_COMMITS,
  resolveBsDataHistoryIdentity,
} from "../local/data-bundles/bsdata-history";
import type {
  NewRecruitServiceIdentityV1,
} from "../local/data-bundles/service-compatibility";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function gameSystem(revision: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gameSystem id="system-id" name="Warhammer 40,000 11th Edition" revision="${revision}" battleScribeVersion="2.03"></gameSystem>
`;
}

function factionCatalogue(
  revision: number,
  id = "custodes-id",
): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<catalogue id='${id}' name='Imperium - Adeptus Custodes' revision='${revision}' gameSystemId='system-id'></catalogue>
`;
}

function identity(
  gameSystemRevision: number,
  catalogueRevision: number,
): NewRecruitServiceIdentityV1 {
  return {
    factionId: "adeptus-custodes",
    gameSystem: {
      id: "system-id",
      name: "Warhammer 40,000 11th Edition",
      revision: gameSystemRevision,
    },
    factionCatalogue: {
      id: "custodes-id",
      name: "Imperium - Adeptus Custodes",
      revision: catalogueRevision,
    },
  };
}

async function historyFixture(options: {
  replaceCatalogueId?: boolean;
} = {}): Promise<{
  root: string;
  checkout: string;
  cache: string;
  firstCommit: string;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-bsdata-history-"),
  );
  const checkout = path.join(root, "source");
  const cache = path.join(root, "cache.git");
  await mkdir(checkout);
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "RosterPilot Test");
  git(checkout, "config", "user.email", "rosterpilot@example.test");
  await writeFile(
    path.join(checkout, "Warhammer 40,000 11th Edition.gst"),
    gameSystem(7),
  );
  await writeFile(
    path.join(checkout, "Imperium - Adeptus Custodes.cat"),
    factionCatalogue(6),
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "Initial catalogue identity");
  const firstCommit = git(checkout, "rev-parse", "HEAD");

  await writeFile(path.join(checkout, "README.md"), "unrelated\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-m", "Unrelated documentation");

  await writeFile(
    path.join(checkout, "Warhammer 40,000 11th Edition.gst"),
    gameSystem(8),
  );
  await writeFile(
    path.join(checkout, "Imperium - Adeptus Custodes.cat"),
    factionCatalogue(
      7,
      options.replaceCatalogueId
        ? "replacement-custodes-id"
        : "custodes-id",
    ),
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "Update catalogue identity");
  execFileSync("git", ["clone", "--bare", checkout, cache], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return { root, checkout, cache, firstCommit };
}

test("the bare-cache resolver finds an exact historical identity without touching a checkout", async () => {
  const fixture = await historyFixture();
  try {
    const statusBefore = git(
      fixture.checkout,
      "status",
      "--porcelain=v1",
    );
    const result = await resolveBsDataHistoryIdentity({
      cacheDirectory: fixture.cache,
      identity: identity(7, 6),
      allowedRemoteUrls: [fixture.checkout],
    });
    assert.equal(result.status, "matched");
    if (result.status !== "matched") return;
    assert.equal(result.commit, fixture.firstCommit);
    assert.equal(result.commitsExamined, 2);
    assert.equal(result.relevantCommits, 2);
    assert.equal(
      result.gameSystemPath,
      "Warhammer 40,000 11th Edition.gst",
    );
    assert.equal(
      result.factionCataloguePath,
      "Imperium - Adeptus Custodes.cat",
    );
    assert.equal(
      git(fixture.checkout, "status", "--porcelain=v1"),
      statusBefore,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("historical path discovery can recover an id no longer present at HEAD", async () => {
  const fixture = await historyFixture({
    replaceCatalogueId: true,
  });
  try {
    const result = await resolveBsDataHistoryIdentity({
      cacheDirectory: fixture.cache,
      identity: identity(7, 6),
      allowedRemoteUrls: [fixture.checkout],
    });
    assert.equal(result.status, "matched");
    if (result.status !== "matched") return;
    assert.equal(result.commit, fixture.firstCommit);
    assert.equal(result.commitsExamined, 2);
    assert.equal(result.relevantCommits, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the resolver returns a clear bounded no-match result", async () => {
  const fixture = await historyFixture();
  try {
    const bounded = await resolveBsDataHistoryIdentity({
      cacheDirectory: fixture.cache,
      identity: identity(7, 6),
      maxCommits: 1,
      allowedRemoteUrls: [fixture.checkout],
    });
    assert.deepEqual(
      {
        status: bounded.status,
        reason:
          bounded.status === "no-match" ? bounded.reason : null,
        examined: bounded.commitsExamined,
        relevant: bounded.relevantCommits,
      },
      {
        status: "no-match",
        reason: "EXACT_IDENTITY_NOT_FOUND",
        examined: 1,
        relevant: 1,
      },
    );
    assert.match(
      bounded.status === "no-match" ? bounded.message : "",
      /No exact BSData identity match.*bounded at 1/i,
    );
    await assert.rejects(
      resolveBsDataHistoryIdentity({
        cacheDirectory: fixture.cache,
        identity: identity(7, 6),
        maxCommits: MAX_BSDATA_COMPATIBILITY_COMMITS + 1,
        allowedRemoteUrls: [fixture.checkout],
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the resolver rejects non-allowlisted or non-bare repositories", async () => {
  const fixture = await historyFixture();
  try {
    await assert.rejects(
      resolveBsDataHistoryIdentity({
        cacheDirectory: fixture.cache,
        identity: identity(8, 7),
        allowedRemoteUrls: ["https://example.test/not-bsdata.git"],
      }),
      (error: unknown) =>
        error instanceof BsDataHistoryResolverError &&
        error.code === "BSDATA_REMOTE_NOT_ALLOWLISTED",
    );
    await assert.rejects(
      resolveBsDataHistoryIdentity({
        cacheDirectory: fixture.checkout,
        identity: identity(8, 7),
        allowedRemoteUrls: [fixture.checkout],
      }),
      (error: unknown) =>
        error instanceof BsDataHistoryResolverError &&
        error.code === "BSDATA_CACHE_NOT_BARE",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source discovery fails closed when an observed id is absent", async () => {
  const fixture = await historyFixture();
  try {
    const missing = await resolveBsDataHistoryIdentity({
      cacheDirectory: fixture.cache,
      identity: {
        ...identity(8, 7),
        factionCatalogue: {
          id: "different-catalogue-id",
          name: null,
          revision: 7,
        },
      },
      allowedRemoteUrls: [fixture.checkout],
    });
    assert.equal(missing.status, "no-match");
    if (missing.status !== "no-match") return;
    assert.equal(missing.reason, "IDENTITY_SOURCE_PATH_NOT_FOUND");
    assert.equal(missing.commitsExamined, 2);
    assert.equal(missing.relevantCommits, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
