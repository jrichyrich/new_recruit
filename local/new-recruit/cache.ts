import crypto from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  type ConnectorEvent,
  rosterExecutionFingerprint,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  validateEnrichedRoszGameplayIdentity,
} from "../../lib/rosterpilot";
import { rosterPilotSupportDirectory } from "../agent/paths";
import { safeNewRecruitUiIdentity } from "./ui-identity";

type CacheReceiptV2 = {
  schemaVersion: 1 | 2;
  cacheKind: "new-recruit-enriched-roster";
  cacheKey: string;
  createdAt: string;
  executionFingerprint: string;
  sourceData: RosterDraftV1["sourceData"];
  rosterId: string;
  rosterName: string;
  uiIdentity?: string | null;
  listUrl: string | null;
  sourceRoszSha256: string;
  enrichedRoszSha256: string;
  enrichedSummary: EnrichedRoszSummary;
  connectorEvents?: ConnectorEvent[];
};

type RunInventoryV1 = {
  schemaVersion: 1;
  inventoryKind: "new-recruit-remote-lists";
  entries: Array<{
    cacheKey: string;
    rosterName: string;
    listUrl: string;
    recordedAt: string;
  }>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(filename: string): Promise<string> {
  return crypto
    .createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

export function newRecruitCacheKey(roster: RosterDraftV1): string {
  return crypto
    .createHash("sha256")
    .update(
      canonical({
        executionFingerprint: rosterExecutionFingerprint(roster),
        sourceData: roster.sourceData,
      }),
    )
    .digest("hex");
}

function cacheRoot(): string {
  return path.join(
    rosterPilotSupportDirectory(),
    "cache",
    "new-recruit",
    "v1",
  );
}

function cachedDelivery(
  roster: RosterDraftV1,
  directory: string,
  receipt: CacheReceiptV2,
): ResultEnvelope<NewRecruitDelivery> {
  const sourceRoszPath = path.join(directory, "source.rosz");
  const enrichedRoszPath = path.join(directory, "enriched.rosz");
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: receipt.rosterName,
      uiIdentity: safeNewRecruitUiIdentity(
        receipt.uiIdentity,
      ),
      listUrl: receipt.listUrl,
      imported: true,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [
        ...(receipt.connectorEvents ?? []),
        {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "persistent-cache",
          outcome: "reused",
          remoteId: receipt.listUrl,
          contentSha256: receipt.enrichedRoszSha256,
        },
      ],
      verification: null,
      enrichedSummary: receipt.enrichedSummary,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_CACHE_REUSED",
        message:
          "Reused the verified content-addressed New Recruit artifact; no remote list was created.",
        severity: "warn",
      },
    ],
  };
}

export async function loadNewRecruitCache(
  roster: RosterDraftV1,
): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  const key = newRecruitCacheKey(roster);
  const directory = path.join(cacheRoot(), key);
  try {
    const receipt = JSON.parse(
      await readFile(path.join(directory, "receipt.json"), "utf8"),
    ) as CacheReceiptV2;
    const sourceRoszPath = path.join(directory, "source.rosz");
    const enrichedRoszPath = path.join(directory, "enriched.rosz");
    if (
      ![1, 2].includes(receipt.schemaVersion) ||
      receipt.cacheKind !== "new-recruit-enriched-roster" ||
      receipt.cacheKey !== key ||
      receipt.executionFingerprint !== rosterExecutionFingerprint(roster) ||
      canonical(receipt.sourceData) !== canonical(roster.sourceData) ||
      receipt.sourceRoszSha256 !== (await sha256(sourceRoszPath)) ||
      receipt.enrichedRoszSha256 !== (await sha256(enrichedRoszPath))
    ) return null;
    const enrichedContent = await readFile(enrichedRoszPath);
    const actualSummary = validateEnrichedRoszGameplayIdentity(
      enrichedContent,
      roster,
    ).summary;
    if (canonical(actualSummary) !== canonical(receipt.enrichedSummary)) {
      return null;
    }
    return cachedDelivery(roster, directory, receipt);
  } catch {
    return null;
  }
}

async function recordInventory(
  cacheKey: string,
  rosterName: string,
  listUrl: string | null,
): Promise<void> {
  if (!listUrl) return;
  const filename = path.join(
    rosterPilotSupportDirectory(),
    "new-recruit-run-inventory.json",
  );
  let inventory: RunInventoryV1 = {
    schemaVersion: 1,
    inventoryKind: "new-recruit-remote-lists",
    entries: [],
  };
  try {
    inventory = JSON.parse(await readFile(filename, "utf8")) as RunInventoryV1;
  } catch {
    // First inventory write.
  }
  if (
    !inventory.entries.some(
      (entry) => entry.cacheKey === cacheKey && entry.listUrl === listUrl,
    )
  ) {
    inventory.entries.push({
      cacheKey,
      rosterName,
      listUrl,
      recordedAt: new Date().toISOString(),
    });
  }
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}

export async function storeNewRecruitCache(
  roster: RosterDraftV1,
  delivery: ResultEnvelope<NewRecruitDelivery>,
): Promise<void> {
  if (!delivery.ok || !delivery.data?.enrichedSummary) return;
  const sourceRoszPath = delivery.data.artifacts.find(
    (artifact) =>
      artifact.format === "rosterpilot-source-rosz" ||
      artifact.format === "rosz",
  )?.written;
  const enrichedRoszPath = delivery.data.artifacts.find(
    (artifact) => artifact.format === "new-recruit-enriched-rosz",
  )?.written;
  if (!sourceRoszPath || !enrichedRoszPath) return;
  const enrichedContent = await readFile(enrichedRoszPath);
  const actualSummary = validateEnrichedRoszGameplayIdentity(
    enrichedContent,
    roster,
  ).summary;
  if (canonical(actualSummary) !== canonical(delivery.data.enrichedSummary)) {
    throw new Error(
      "The New Recruit cache refused an enriched artifact whose exact summary changed.",
    );
  }
  const key = newRecruitCacheKey(roster);
  const directory = path.join(cacheRoot(), key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cachedSource = path.join(directory, "source.rosz");
  const cachedEnriched = path.join(directory, "enriched.rosz");
  await Promise.all([
    copyFile(sourceRoszPath, cachedSource),
    copyFile(enrichedRoszPath, cachedEnriched),
  ]);
  const receipt: CacheReceiptV2 = {
    schemaVersion: 2,
    cacheKind: "new-recruit-enriched-roster",
    cacheKey: key,
    createdAt: new Date().toISOString(),
    executionFingerprint: rosterExecutionFingerprint(roster),
    sourceData: roster.sourceData,
    rosterId: roster.id,
    rosterName: delivery.data.rosterName,
    uiIdentity: safeNewRecruitUiIdentity(
      delivery.data.uiIdentity,
    ),
    listUrl: delivery.data.listUrl,
    sourceRoszSha256: await sha256(cachedSource),
    enrichedRoszSha256: await sha256(cachedEnriched),
    enrichedSummary: actualSummary,
    connectorEvents: delivery.data.connectorEvents ?? [],
  };
  const receiptPath = path.join(directory, "receipt.json");
  const temporary = `${receiptPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, receiptPath);
  await recordInventory(key, receipt.rosterName, receipt.listUrl);
}
