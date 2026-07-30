import { newRecruitCatalogue } from "./catalogue-summary";
import type {
  LiveDataFreshness,
  ResultEnvelope,
  RosterIssue,
} from "./types";

type FetchLike = typeof fetch;

export type FreshnessCheckOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
};

let sharedFreshnessCache:
  | {
      expiresAt: number;
      result: ResultEnvelope<LiveDataFreshness>;
    }
  | undefined;

function warning(code: string, message: string): RosterIssue {
  return { code, message, severity: "warn" };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function latestMfmVersion(html: string): string | null {
  const match =
    html.match(/<h[1-3][^>]*>\s*v(\d+(?:\.\d+)+)\s*<\/h[1-3]>/i) ??
    html.match(/\bversion\s+v?(\d+(?:\.\d+)+)\b/i);
  return match?.[1] ?? null;
}

async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  headers?: HeadersInit,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}.`);
  }
  return response.text();
}

export async function checkDataFreshness(
  options: FreshnessCheckOptions = {},
): Promise<ResultEnvelope<LiveDataFreshness>> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const checkedAt = new Date().toISOString();
  const pinned = newRecruitCatalogue.sources;
  const warnings: RosterIssue[] = [];

  const [rulesResult, newRecruitResult, officialResult] =
    await Promise.allSettled([
      fetchText(
        fetchImpl,
        "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
        timeoutMs,
      ).then((content) => {
        const payload = JSON.parse(content) as { version?: string };
        return payload.version ?? null;
      }),
      fetchText(
        fetchImpl,
        `https://api.github.com/repos/${pinned.newRecruit.repository}/commits/${pinned.newRecruit.branch}`,
        timeoutMs,
        {
          Accept: "application/vnd.github+json",
          "User-Agent": "RosterPilot-data-freshness",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      ).then((content) => {
        const payload = JSON.parse(content) as { sha?: string };
        return payload.sha ?? null;
      }),
      fetchText(fetchImpl, pinned.official.mfmUrl, timeoutMs).then(
        async (content) => ({
          version: latestMfmVersion(content),
          contentSha256: await sha256(content),
        }),
      ),
    ]);

  const rulesVersion =
    rulesResult.status === "fulfilled" ? rulesResult.value : null;
  const newRecruitCommit =
    newRecruitResult.status === "fulfilled" ? newRecruitResult.value : null;
  const official =
    officialResult.status === "fulfilled" ? officialResult.value : null;

  if (rulesResult.status === "rejected") {
    warnings.push(
      warning(
        "RULES_FRESHNESS_UNKNOWN",
        `The latest 40kdc-data version could not be checked: ${String(rulesResult.reason)}`,
      ),
    );
  }
  if (newRecruitResult.status === "rejected") {
    warnings.push(
      warning(
        "NEW_RECRUIT_FRESHNESS_UNKNOWN",
        `The latest BSData commit could not be checked: ${String(newRecruitResult.reason)}`,
      ),
    );
  }
  if (officialResult.status === "rejected") {
    warnings.push(
      warning(
        "OFFICIAL_DATA_FRESHNESS_UNKNOWN",
        `The current official points source could not be checked: ${String(officialResult.reason)}`,
      ),
    );
  }

  const rulesUpdate =
    rulesVersion === null ? null : rulesVersion !== pinned.rules.version;
  const newRecruitUpdate =
    newRecruitCommit === null
      ? null
      : newRecruitCommit !== pinned.newRecruit.commit;
  const officialUpdate =
    official === null
      ? null
      : official.version !== pinned.official.mfmVersion ||
        official.contentSha256 !== pinned.official.contentSha256;
  const unknown = [rulesUpdate, newRecruitUpdate, officialUpdate].some(
    (value) => value === null,
  );
  const state: LiveDataFreshness["state"] =
    rulesUpdate === true || newRecruitUpdate === true
      ? "update-available"
      : officialUpdate === true
        ? "official-update-pending"
        : unknown
          ? "unknown"
          : "current";

  const data: LiveDataFreshness = {
    checkedAt,
    state,
    rules: {
      pinnedVersion: pinned.rules.version,
      latestVersion: rulesVersion,
      updateAvailable: rulesUpdate,
    },
    newRecruit: {
      pinnedCommit: pinned.newRecruit.commit,
      latestCommit: newRecruitCommit,
      updateAvailable: newRecruitUpdate,
    },
    official: {
      pinnedVersion: pinned.official.mfmVersion,
      latestVersion: official?.version ?? null,
      pinnedContentSha256: pinned.official.contentSha256,
      latestContentSha256: official?.contentSha256 ?? null,
      updateAvailable: officialUpdate,
    },
  };

  if (state === "update-available") {
    warnings.unshift(
      warning(
        "DATA_UPDATE_AVAILABLE",
        "Newer rules or New Recruit catalogue data is available. The roster remains pinned to its recorded release until the update is reviewed and generated.",
      ),
    );
  } else if (state === "official-update-pending") {
    warnings.unshift(
      warning(
        "OFFICIAL_UPDATE_PENDING",
        "The official points source changed after the pinned release. Treat points as pending review until the community datasets reconcile.",
      ),
    );
  } else if (state === "unknown") {
    warnings.unshift(
      warning(
        "DATA_FRESHNESS_UNKNOWN",
        "At least one live source could not be checked. The roster was built from the exact pinned release.",
      ),
    );
  }

  const result: ResultEnvelope<LiveDataFreshness> = {
    ok: true,
    data,
    violations: [],
    warnings,
  };
  sharedFreshnessCache = {
    expiresAt: Date.now() + 15 * 60_000,
    result,
  };
  return result;
}

export async function checkDataFreshnessCached(
  options: FreshnessCheckOptions & {
    force?: boolean;
    cacheMs?: number;
  } = {},
): Promise<ResultEnvelope<LiveDataFreshness>> {
  if (
    !options.force &&
    sharedFreshnessCache &&
    sharedFreshnessCache.expiresAt > Date.now()
  ) {
    return sharedFreshnessCache.result;
  }
  const result = await checkDataFreshness(options);
  sharedFreshnessCache = {
    expiresAt: Date.now() + (options.cacheMs ?? 15 * 60_000),
    result,
  };
  return result;
}

export function getCachedDataFreshness(): LiveDataFreshness | null {
  return sharedFreshnessCache?.result.data ?? null;
}

export function getCachedDataFreshnessResult():
  | ResultEnvelope<LiveDataFreshness>
  | null {
  if (
    !sharedFreshnessCache ||
    sharedFreshnessCache.expiresAt <= Date.now()
  ) {
    return null;
  }
  return sharedFreshnessCache.result;
}

export function setCachedDataFreshness(
  result: ResultEnvelope<LiveDataFreshness>,
  cacheMs = 15 * 60_000,
): void {
  sharedFreshnessCache = {
    expiresAt: Date.now() + cacheMs,
    result,
  };
}

export function addFreshnessWarnings<T>(
  result: ResultEnvelope<T>,
  freshness: ResultEnvelope<LiveDataFreshness>,
): ResultEnvelope<T> {
  return {
    ...result,
    warnings: [
      ...freshness.warnings,
      ...result.warnings.filter(
        (item) =>
          !freshness.warnings.some(
            (freshnessWarning) => freshnessWarning.code === item.code,
          ),
      ),
    ],
  };
}
