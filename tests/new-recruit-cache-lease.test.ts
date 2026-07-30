import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDirectoryLease } from "../local/new-recruit/cache";

test("New Recruit leases recover an abandoned owner and release by token", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "new-recruit-lease-"),
  );
  const leaseDirectory = path.join(directory, "cache-key.lock");
  try {
    await mkdir(leaseDirectory);
    await writeFile(
      path.join(leaseDirectory, "owner.json"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "abandoned-owner",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
    );

    const release = await acquireDirectoryLease(
      leaseDirectory,
      500,
      0,
    );
    const owner = JSON.parse(
      await readFile(
        path.join(leaseDirectory, "owner.json"),
        "utf8",
      ),
    ) as { pid: number; token: string };
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, "abandoned-owner");

    await release();
    await assert.rejects(
      readFile(path.join(leaseDirectory, "owner.json"), "utf8"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("New Recruit leases do not steal a live owner", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "new-recruit-live-lease-"),
  );
  const leaseDirectory = path.join(directory, "cache-key.lock");
  try {
    const release = await acquireDirectoryLease(
      leaseDirectory,
      500,
      0,
    );
    await assert.rejects(
      acquireDirectoryLease(leaseDirectory, 25, 0),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "NEW_RECRUIT_CACHE_LOCKED",
        ),
    );
    await release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
