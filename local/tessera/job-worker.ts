import { readFile } from "node:fs/promises";

import {
  getDataUpdateStatusSnapshot,
  getConfiguredDataBundleProvider,
} from "../../lib/rosterpilot/data-operations";
import type {
  DataBundleSnapshot,
} from "../../lib/rosterpilot/data-bundle";
import {
  activateRuntimeDataBundle,
  assertRuntimeDataBundleShardData,
  type RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  initializeLocalDataBundleProvider,
} from "../data-bundles/configure";
import { executeTesseraRunJob } from "./jobs";

const jobPath = process.argv[2];
const workerToken = process.argv[3];
if (!jobPath || !workerToken) {
  throw new Error(
    "A Tessera run job path and worker launch token are required.",
  );
}

await initializeLocalDataBundleProvider();
const provider = getConfiguredDataBundleProvider();
const document = JSON.parse(await readFile(jobPath, "utf8")) as {
  dataPins?: Array<{
    sourceData?: { bundleId?: string };
  }>;
};
const bundleIds = [
  ...new Set(
    (document.dataPins ?? [])
      .map((entry) => entry.sourceData?.bundleId)
      .filter(
        (bundleId): bundleId is string =>
          typeof bundleId === "string",
      ),
  ),
];
if (bundleIds.length > 1) {
  throw new Error(
    "The Tessera job combines rosters from different immutable data bundles.",
  );
}
let lease:
  | Awaited<ReturnType<NonNullable<typeof provider>["acquireSnapshot"]>>
  | null = null;
try {
  if (provider) {
    lease = await provider.acquireSnapshot({
      ...(bundleIds[0] ? { bundleId: bundleIds[0] } : {}),
    });
    for (const descriptor of lease.snapshot.manifest.shards) {
      const shard = lease.snapshot.getShard(descriptor.shardId);
      assertRuntimeDataBundleShardData(shard?.data, descriptor);
    }
    activateRuntimeDataBundle(
      lease.snapshot as DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
    );
  } else if (
    bundleIds[0] &&
    bundleIds[0] !==
      getDataUpdateStatusSnapshot().activeBundleId
  ) {
    throw new Error(
      `The Tessera job requires archived data bundle ${bundleIds[0]}, but no verified runtime bundle provider is available.`,
    );
  }
  await executeTesseraRunJob(jobPath, workerToken);
} finally {
  await lease?.release();
}
