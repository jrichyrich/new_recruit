import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DATA_UPDATE_USAGE,
  DATA_UPDATE_LOCK_DIRECTORY,
  DATA_UPDATE_TRANSACTION_DIRECTORY,
  DataUpdateCliUsageError,
  mappingRegressionReasons,
  nextSourceManifest,
  parseDataUpdateArgs,
  prepareDataUpdate,
  publishFilesAtomically,
  recoverInterruptedDataUpdate,
  runPrepareDataUpdateCli,
  type SourceManifest,
} from "../scripts/prepare-data-update";
import type { LiveDataFreshness } from "../lib/rosterpilot";

const source: SourceManifest = {
  schemaVersion: 1,
  releaseId: "2026-07-28.1",
  rules: {
    package: "@alpaca-software/40kdc-data",
    version: "1.2.0",
    edition: "11th",
    dataslate: "launch",
  },
  newRecruit: {
    repository: "BSData/wh40k-11e",
    url: "https://github.com/BSData/wh40k-11e.git",
    branch: "main",
    commit: "a".repeat(40),
  },
  official: {
    downloadsUrl: "https://example.test/downloads",
    mfmUrl: "https://example.test/mfm",
    mfmVersion: "1.1",
    updatedAt: "2026-07-22",
    contentSha256: "b".repeat(64),
    checkedAt: "2026-07-28T00:00:00.000Z",
  },
};

const freshness: LiveDataFreshness = {
  checkedAt: "2026-07-29T12:00:00.000Z",
  state: "update-available",
  rules: {
    pinnedVersion: "1.2.0",
    latestVersion: "1.3.0",
    updateAvailable: true,
  },
  newRecruit: {
    pinnedCommit: "a".repeat(40),
    latestCommit: "c".repeat(40),
    updateAvailable: true,
  },
  official: {
    pinnedVersion: "1.1",
    latestVersion: "1.2",
    pinnedContentSha256: "b".repeat(64),
    latestContentSha256: "d".repeat(64),
    updateAvailable: true,
  },
};

function put(root: string, relativePath: string, value: string): void {
  const filename = path.join(root, relativePath);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, value);
}

test("data-update help exits before reads, commands, or filesystem mutation", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-data-help-"),
  );
  const sentinel = path.join(root, "sentinel.txt");
  writeFileSync(sentinel, "unchanged");
  const before = readFileSync(sentinel, "utf8");
  let runnerCalls = 0;
  let output = "";
  try {
    await runPrepareDataUpdateCli(["--help"], {
      root,
      run: () => {
        runnerCalls += 1;
        writeFileSync(sentinel, "mutated");
      },
      writeOutput: (value) => {
        output += value;
      },
    });
    assert.deepEqual(parseDataUpdateArgs(["-h"]), { help: true });
    assert.equal(output, DATA_UPDATE_USAGE);
    assert.equal(runnerCalls, 0);
    assert.equal(readFileSync(sentinel, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown data-update options fail before reads, commands, or filesystem mutation", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-data-unknown-"),
  );
  const sentinel = path.join(root, "sentinel.txt");
  writeFileSync(sentinel, "unchanged");
  let runnerCalls = 0;
  let output = "";
  try {
    await assert.rejects(
      runPrepareDataUpdateCli(["--write"], {
        root,
        run: () => {
          runnerCalls += 1;
          writeFileSync(sentinel, "mutated");
        },
        writeOutput: (value) => {
          output += value;
        },
      }),
      (error: unknown) =>
        error instanceof DataUpdateCliUsageError &&
        /Unknown data-update option: --write/.test(error.message),
    );
    assert.equal(runnerCalls, 0);
    assert.equal(output, "");
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds a complete next source manifest without mutating the pin", () => {
  const next = nextSourceManifest(source, freshness);
  assert.equal(source.rules.version, "1.2.0");
  assert.equal(source.newRecruit.commit, "a".repeat(40));
  assert.equal(next.releaseId, "2026-07-29.1");
  assert.equal(next.rules.version, "1.3.0");
  assert.equal(next.newRecruit.commit, "c".repeat(40));
  assert.equal(next.official.mfmVersion, "1.2");
  assert.equal(next.official.contentSha256, "d".repeat(64));
  assert.equal(next.official.checkedAt, freshness.checkedAt);
});

test("publishes a validated data set and rolls every file back on failure", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-atomic-data-"),
  );
  const live = path.join(directory, "live");
  const staged = path.join(directory, "staged");
  const files = [
    "package.json",
    "data/sources.json",
    "data/generated/summary.json",
  ];
  try {
    for (const filename of files) {
      put(live, filename, `old:${filename}`);
      put(staged, filename, `new:${filename}`);
    }
    assert.throws(
      () =>
        publishFilesAtomically(staged, live, files, {
          beforePublish: (_filename, index) => {
            if (index === 2) throw new Error("injected publish failure");
          },
        }),
      /injected publish failure/,
    );
    for (const filename of files) {
      assert.equal(
        readFileSync(path.join(live, filename), "utf8"),
        `old:${filename}`,
      );
    }

    publishFilesAtomically(staged, live, files);
    for (const filename of files) {
      assert.equal(
        readFileSync(path.join(live, filename), "utf8"),
        `new:${filename}`,
      );
    }
    assert.equal(
      readFileSync(path.join(staged, files[0]), "utf8"),
      `new:${files[0]}`,
      "publishing must not consume the validated staging set",
    );
    assert.throws(
      () => publishFilesAtomically(staged, live, ["../outside.json"]),
      /must stay inside the project/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a process-interrupted publish from its durable journal", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-interrupted-data-"),
  );
  const live = path.join(directory, "live");
  const transaction = path.join(
    live,
    DATA_UPDATE_TRANSACTION_DIRECTORY,
  );
  const files = ["data/sources.json", "data/generated/summary.json"];
  try {
    for (const filename of files) {
      put(live, filename, `mixed:${filename}`);
      put(transaction, `backup/${filename}`, `old:${filename}`);
    }
    put(
      transaction,
      "journal.json",
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "publishing",
        relativePaths: files,
        existedPaths: files,
      })}\n`,
    );
    assert.deepEqual(recoverInterruptedDataUpdate(live), files);
    for (const filename of files) {
      assert.equal(
        readFileSync(path.join(live, filename), "utf8"),
        `old:${filename}`,
      );
    }
    assert.equal(existsSync(transaction), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a concurrent publisher while preserving the active transaction", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-concurrent-data-"),
  );
  const live = path.join(directory, "live");
  const staged = path.join(directory, "staged");
  const files = ["data/sources.json"];
  try {
    put(live, files[0], "old");
    put(staged, files[0], "new");
    publishFilesAtomically(staged, live, files, {
      beforePublish: () => {
        assert.throws(
          () => publishFilesAtomically(staged, live, files),
          /already in progress/,
        );
      },
    });
    assert.equal(
      readFileSync(path.join(live, files[0]), "utf8"),
      "new",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a stale ownerless lock before publishing", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-stale-lock-"),
  );
  const live = path.join(directory, "live");
  const staged = path.join(directory, "staged");
  const files = ["data/sources.json"];
  try {
    put(live, files[0], "old");
    put(staged, files[0], "new");
    const lock = path.join(live, DATA_UPDATE_LOCK_DIRECTORY);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    publishFilesAtomically(staged, live, files);
    assert.equal(
      readFileSync(path.join(live, files[0]), "utf8"),
      "new",
    );
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects mapping and selected-faction capability regressions", () => {
  const previous = {
    releaseId: "old",
    summary: {
      factionCount: 2,
      exportCapableFactions: 2,
      completeFactions: 0,
      conflicts: 10,
      blockingConflicts: 10,
      uniqueConflicts: 8,
      uniqueBlockingConflicts: 8,
    },
    factions: {
      aeldari: {
        configurationAvailable: true,
        coverage: { mappedUnits: 20, mappedDetachments: 4 },
      },
      orks: {
        configurationAvailable: true,
        coverage: { mappedUnits: 20, mappedDetachments: 4 },
      },
    },
  };
  const next = structuredClone(previous);
  next.releaseId = "next";
  next.summary.exportCapableFactions = 1;
  next.summary.conflicts = 12;
  next.summary.blockingConflicts = 12;
  next.summary.uniqueConflicts = 9;
  next.summary.uniqueBlockingConflicts = 9;
  next.factions.orks.coverage.mappedDetachments = 0;
  assert.deepEqual(mappingRegressionReasons(previous, next), [
    "blocking mapping conflicts rose from 10 to 12",
    "export-capable factions fell from 2 to 1",
    "mapping conflicts rose from 10 to 12",
    "orks lost selected-roster export capability",
    "unique blocking mapping conflicts rose from 8 to 9",
    "unique mapping conflicts rose from 8 to 9",
  ]);
});

test("rejects a unique-root regression even when raw conflicts fall", () => {
  const previous = {
    releaseId: "old",
    summary: {
      factionCount: 1,
      exportCapableFactions: 1,
      completeFactions: 0,
      conflicts: 10,
      blockingConflicts: 10,
      uniqueConflicts: 5,
      uniqueBlockingConflicts: 5,
    },
    factions: {
      aeldari: {
        configurationAvailable: true,
        coverage: { mappedUnits: 20, mappedDetachments: 4 },
      },
    },
  };
  const next = structuredClone(previous);
  next.releaseId = "next";
  next.summary.conflicts = 9;
  next.summary.blockingConflicts = 9;
  next.summary.uniqueConflicts = 6;
  next.summary.uniqueBlockingConflicts = 6;
  assert.deepEqual(mappingRegressionReasons(previous, next), [
    "unique blocking mapping conflicts rose from 5 to 6",
    "unique mapping conflicts rose from 5 to 6",
  ]);
});

test("a failed staged generation leaves every live update file unchanged", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-staged-data-failure-"),
  );
  const tracked = [
    "package.json",
    "package-lock.json",
    "data/sources.json",
    "data/generated/new-recruit-catalogues.json",
    "data/generated/new-recruit-summary.json",
    "data/certification-manifest.json",
  ];
  try {
    put(root, "package.json", "{}\n");
    put(root, "package-lock.json", "{}\n");
    put(root, "tsconfig.json", "{}\n");
    put(root, "data/sources.json", `${JSON.stringify(source)}\n`);
    put(root, "data/bsdata-overrides.json", "{}\n");
    put(root, "data/certification-manifest.json", "{}\n");
    put(root, "data/generated/new-recruit-catalogues.json", '{"old":true}\n');
    put(
      root,
      "data/generated/new-recruit-summary.json",
      `${JSON.stringify({
        releaseId: source.releaseId,
        summary: {
          factionCount: 1,
          exportCapableFactions: 1,
          completeFactions: 0,
          conflicts: 1,
          blockingConflicts: 1,
        },
        factions: {
          aeldari: {
            configurationAvailable: true,
            coverage: { mappedUnits: 1, mappedDetachments: 1 },
          },
        },
      })}\n`,
    );
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "local"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    const before = new Map(
      tracked.map((filename) => [
        filename,
        readFileSync(path.join(root, filename), "utf8"),
      ]),
    );
    await assert.rejects(
      prepareDataUpdate({
        root,
        freshness,
        run: (_command, args) => {
          if (args.includes("scripts/sync-bsdata.ts")) {
            throw new Error("synthetic generation failure");
          }
        },
      }),
      /synthetic generation failure/,
    );
    for (const filename of tracked) {
      assert.equal(
        readFileSync(path.join(root, filename), "utf8"),
        before.get(filename),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful staged update certifies portfolios and publishes its manifest", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-staged-data-success-"),
  );
  const summary = {
    releaseId: source.releaseId,
    summary: {
      factionCount: 1,
      exportCapableFactions: 1,
      completeFactions: 0,
      conflicts: 1,
      blockingConflicts: 1,
      uniqueConflicts: 1,
      uniqueBlockingConflicts: 1,
    },
    factions: {
      aeldari: {
        configurationAvailable: true,
        coverage: { mappedUnits: 1, mappedDetachments: 1 },
      },
    },
  };
  try {
    put(root, "package.json", "{}\n");
    put(root, "package-lock.json", "{}\n");
    put(root, "tsconfig.json", "{}\n");
    put(root, "data/sources.json", `${JSON.stringify(source)}\n`);
    put(root, "data/bsdata-overrides.json", "{}\n");
    put(
      root,
      "data/generated/new-recruit-catalogues.json",
      '{"generated":true}\n',
    );
    put(
      root,
      "data/generated/new-recruit-summary.json",
      `${JSON.stringify(summary)}\n`,
    );
    put(
      root,
      "data/certification-manifest.json",
      '{"pin":"old"}\n',
    );
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "local"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    const calls: string[] = [];
    const result = await prepareDataUpdate({
      root,
      freshness,
      run: (_command, args, options) => {
        calls.push(args.join(" "));
        if (args.includes("certify:manifest:sync")) {
          put(
            options.cwd,
            "data/certification-manifest.json",
            '{"pin":"new"}\n',
          );
        }
      },
    });
    assert.equal(result.changed, true);
    assert.ok(
      result.published.includes("data/certification-manifest.json"),
    );
    assert.equal(
      readFileSync(
        path.join(root, "data/certification-manifest.json"),
        "utf8",
      ),
      '{"pin":"new"}\n',
    );
    assert.ok(
      calls.some(
        (call) =>
          call.includes("certify") &&
          call.includes("--tier deterministic") &&
          call.includes("--portfolio"),
      ),
    );
    assert.ok(
      calls.indexOf("run certify:manifest:sync") <
        calls.findIndex(
          (call) =>
            call.includes("certify") &&
            call.includes("--tier deterministic"),
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
