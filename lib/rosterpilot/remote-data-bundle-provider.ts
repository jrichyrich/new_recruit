import {
  createDataBundleSnapshot,
  dataBundleChannelPointerSha256,
  verifyDataBundleChannelPointer,
  verifyDataBundleManifest,
  verifyDataBundleShard,
  type AcquireDataBundleSnapshotOptions,
  type DataBundleProvider,
  type DataBundleProviderStatus,
  type DataBundleRefreshMode,
  type DataBundleChannelCursorV1,
  type DataBundleSnapshot,
  type DataBundleSnapshotLease,
  type Ed25519KeyRegistry,
  type RefreshDataBundleOptions,
  type RefreshDataBundleResult,
  type VerifiedDataBundleChannelPointer,
  type VerifiedDataBundleChannelPointerV2,
  type VerifiedDataBundleShardV1,
} from "./data-bundle";
import {
  activateRuntimeDataBundle,
  assertRuntimeDataBundleSemanticIdentity,
  assertRuntimeDataBundleShardData,
  FACTION_DATA_DEPENDENCIES,
  isSupportedRuntimeDataBundleSchemaVersion,
  type RuntimeDataBundleShardDataV1,
} from "./runtime-data-bundle";
import {
  classifyDataBundleDelta,
  type DataBundleDeltaResult,
} from "./semantic-hash";

type FetchLike = typeof fetch;
const CHANNEL_POINTER_BYTE_LIMIT = 256 * 1_024;
// The manifest carries entity-level semantic hashes for every supported
// faction. Keep it bounded, but leave room for the complete catalogue.
const MANIFEST_BYTE_LIMIT = 8 * 1_024 * 1_024;
const SHARD_BYTE_LIMIT = 64 * 1_024 * 1_024;
const CHANNEL_POINTER_HISTORY_LIMIT = 512;

function loopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function secureDataBundleUrl(
  value: string,
  label: string,
): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopbackHostname(url.hostname))
  ) {
    throw new Error(
      `${label} must use HTTPS; HTTP is allowed only for a loopback development host.`,
    );
  }
  return url.toString();
}

export type RuntimeDataBundleCandidateAssessment = {
  status: "verified" | "ambiguous" | "regressive";
  scopes?: readonly string[];
  reason?: string;
};

export type RuntimeDataBundleCandidateValidator = (input: {
  current: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  candidate: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  classification: DataBundleDeltaResult;
}) =>
  | RuntimeDataBundleCandidateAssessment
  | Promise<RuntimeDataBundleCandidateAssessment>;

export type RemoteRuntimeDataBundleProviderOptions = {
  bootstrap: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  channelUrl?: string | null;
  channelName?: string | null;
  trustedKeys: Ed25519KeyRegistry;
  fetch?: FetchLike;
  now?: () => Date;
  refreshIntervalMs?: number;
  retainBundles?: number;
  validateCandidate?: RuntimeDataBundleCandidateValidator;
  persistVerified?: (input: {
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
    classification: DataBundleDeltaResult;
  }) => void | Promise<void>;
  loadArchived?: (
    bundleId: string,
  ) => Promise<
    DataBundleSnapshot<RuntimeDataBundleShardDataV1> | null
  >;
  loadActiveBundleId?: () => Promise<string | null>;
  initialChannelCursor?: DataBundleChannelCursorV1 | null;
  loadChannelCursor?: () =>
    | DataBundleChannelCursorV1
    | null
    | Promise<DataBundleChannelCursorV1 | null>;
  compareAndSetChannelCursor?: (input: {
    expectedPointerSha256: string | null;
    cursor: DataBundleChannelCursorV1;
  }) =>
    | {
        committed: boolean;
        cursor: DataBundleChannelCursorV1;
      }
    | Promise<{
        committed: boolean;
        cursor: DataBundleChannelCursorV1;
      }>;
  initialRollbackHold?: DataBundleProviderStatus["rollbackHold"];
  loadRollbackHold?: () =>
    | DataBundleProviderStatus["rollbackHold"]
    | Promise<DataBundleProviderStatus["rollbackHold"]>;
  persistRollbackHold?: (
    hold: NonNullable<DataBundleProviderStatus["rollbackHold"]>,
  ) => void | Promise<void>;
  clearRollbackHold?: () => void | Promise<void>;
  recordQuarantine?: (input: {
    bundleId: string;
    scopes: readonly string[];
    reason: string;
  }) => void | Promise<void>;
  activate?: (
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
  ) => void | Promise<void>;
  scheduleBackground?: (task: Promise<void>) => void;
  durability?: () =>
    | DataBundleProviderStatus["durability"]
    | undefined;
  retainReference?: (
    referenceId: string,
    bundleId: string,
  ) => void | Promise<void>;
  releaseReference?: (
    referenceId: string,
    bundleId?: string,
  ) => void | Promise<void>;
  initialQuarantinedScopes?: DataBundleProviderStatus["quarantinedScopes"];
};

type PendingActivation = {
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  classification: DataBundleDeltaResult | null;
  quarantinedScopes: DataBundleProviderStatus["quarantinedScopes"];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signedCompositionQuarantines(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): DataBundleProviderStatus["quarantinedScopes"] {
  const composition = snapshot.manifest.composition;
  if (!composition) return [];
  const entries = composition.retainedShards.flatMap((retained) =>
    retained.scopes.map((scope) => ({
      scope,
      bundleId: composition.candidateDraftSha256,
      reason:
        `${retained.reason} Effective shard ${retained.shardId} remains ` +
        `from verified bundle ${retained.sourceBundleId}.`,
    })),
  );
  return entries.filter(
    (entry, index) =>
      entries.findIndex(
        (candidate) =>
          candidate.scope === entry.scope &&
          candidate.bundleId === entry.bundleId,
      ) === index,
  );
}

function mergeQuarantines(
  ...groups: Array<
    DataBundleProviderStatus["quarantinedScopes"]
  >
): DataBundleProviderStatus["quarantinedScopes"] {
  const entries = groups.flat();
  return entries.filter(
    (entry, index) =>
      entries.findIndex(
        (candidate) =>
          candidate.scope === entry.scope &&
          candidate.bundleId === entry.bundleId,
      ) === index,
  );
}

async function responseJson(
  fetchImpl: FetchLike,
  url: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${new URL(url).hostname} returned HTTP ${response.status}.`,
    );
  }
  const declaredLength = Number(
    response.headers.get("content-length"),
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new Error(
      `${new URL(url).hostname} declared a data-bundle object larger than the ${maximumBytes}-byte limit.`,
    );
  }
  if (!response.body) {
    throw new Error(
      `${new URL(url).hostname} returned an empty data-bundle response.`,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(
        `${new URL(url).hostname} returned a data-bundle object larger than the ${maximumBytes}-byte limit.`,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(
      `${new URL(url).hostname} returned invalid data-bundle JSON.`,
    );
  }
}

/**
 * Portable signed-channel provider used by hosted surfaces and as the network
 * layer for the local persistent provider. A refresh never changes a leased
 * request: activation is deferred until the last lease on the current bundle
 * is released.
 */
export class RemoteRuntimeDataBundleProvider
  implements DataBundleProvider<RuntimeDataBundleShardDataV1>
{
  readonly #channelUrl: string | null;
  readonly #channelName: string | null;
  readonly #trustedKeys: Ed25519KeyRegistry;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #refreshIntervalMs: number;
  readonly #retainBundles: number;
  readonly #validateCandidate?: RuntimeDataBundleCandidateValidator;
  readonly #persistVerified?: RemoteRuntimeDataBundleProviderOptions["persistVerified"];
  readonly #loadArchived?: RemoteRuntimeDataBundleProviderOptions["loadArchived"];
  readonly #loadActiveBundleId?: RemoteRuntimeDataBundleProviderOptions["loadActiveBundleId"];
  readonly #loadChannelCursor?: RemoteRuntimeDataBundleProviderOptions["loadChannelCursor"];
  readonly #compareAndSetChannelCursor?: RemoteRuntimeDataBundleProviderOptions["compareAndSetChannelCursor"];
  readonly #loadRollbackHold?: RemoteRuntimeDataBundleProviderOptions["loadRollbackHold"];
  readonly #persistRollbackHold?: RemoteRuntimeDataBundleProviderOptions["persistRollbackHold"];
  readonly #clearRollbackHold?: RemoteRuntimeDataBundleProviderOptions["clearRollbackHold"];
  readonly #recordQuarantine?: RemoteRuntimeDataBundleProviderOptions["recordQuarantine"];
  readonly #activate: (
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
  ) => void | Promise<void>;
  readonly #durability?: RemoteRuntimeDataBundleProviderOptions["durability"];
  readonly #retainReference?: RemoteRuntimeDataBundleProviderOptions["retainReference"];
  readonly #releaseReference?: RemoteRuntimeDataBundleProviderOptions["releaseReference"];
  #scheduleBackground?: (task: Promise<void>) => void;
  #periodicRefreshTimer: ReturnType<typeof setInterval> | null = null;
  readonly #archives = new Map<
    string,
    DataBundleSnapshot<RuntimeDataBundleShardDataV1>
  >();
  readonly #leaseCounts = new Map<string, number>();
  #active: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  #latestVerifiedBundleId: string;
  #latestUpstreamBundleId: string | null = null;
  #lastCheckedAt: string | null = null;
  #state: DataBundleProviderStatus["state"];
  #candidate: DataBundleProviderStatus["candidate"] = null;
  #quarantinedScopes: DataBundleProviderStatus["quarantinedScopes"] =
    [];
  #pending: PendingActivation | null = null;
  #refreshPromise: Promise<RefreshDataBundleResult> | null = null;
  #activationPromise: Promise<boolean> | null = null;
  #rollbackHold: NonNullable<
    DataBundleProviderStatus["rollbackHold"]
  > | null = null;
  #channelCursor: DataBundleChannelCursorV1 | null = null;

  constructor(options: RemoteRuntimeDataBundleProviderOptions) {
    this.#active = options.bootstrap;
    this.#archives.set(options.bootstrap.bundleId, options.bootstrap);
    this.#latestVerifiedBundleId = options.bootstrap.bundleId;
    this.#channelUrl = options.channelUrl
      ? secureDataBundleUrl(
          options.channelUrl,
          "The signed data-bundle channel URL",
        )
      : null;
    this.#channelName =
      options.channelName ??
      (this.#channelUrl
        ? new URL(this.#channelUrl).pathname
            .split("/")
            .filter(Boolean)
            .at(-1)
            ?.replace(/\.json$/i, "") ?? null
        : null);
    this.#trustedKeys = options.trustedKeys;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#refreshIntervalMs =
      options.refreshIntervalMs ?? 15 * 60_000;
    this.#retainBundles = Math.max(3, options.retainBundles ?? 3);
    this.#validateCandidate = options.validateCandidate;
    this.#persistVerified = options.persistVerified;
    this.#loadArchived = options.loadArchived;
    this.#loadActiveBundleId = options.loadActiveBundleId;
    this.#loadChannelCursor = options.loadChannelCursor;
    this.#compareAndSetChannelCursor =
      options.compareAndSetChannelCursor;
    this.#loadRollbackHold = options.loadRollbackHold;
    this.#persistRollbackHold = options.persistRollbackHold;
    this.#clearRollbackHold = options.clearRollbackHold;
    this.#recordQuarantine = options.recordQuarantine;
    this.#activate =
      options.activate ?? activateRuntimeDataBundle;
    this.#scheduleBackground = options.scheduleBackground;
    this.#durability = options.durability;
    this.#retainReference = options.retainReference;
    this.#releaseReference = options.releaseReference;
    this.#state = this.#channelUrl ? "ready" : "offline";
    this.#rollbackHold = options.initialRollbackHold
      ? { ...options.initialRollbackHold }
      : null;
    this.#channelCursor = options.initialChannelCursor
      ? { ...options.initialChannelCursor }
      : null;
    this.#quarantinedScopes = mergeQuarantines(
      signedCompositionQuarantines(options.bootstrap),
      options.initialQuarantinedScopes ?? [],
    );
  }

  async initialize(options: { refresh?: boolean } = {}): Promise<void> {
    await this.#synchronizeRollbackHold();
    await this.#synchronizeChannelCursor();
    await this.#activate(this.#active);
    if (options.refresh !== false) {
      void this.refresh().catch(() => {
        // Status exposes the degraded check; startup never waits on network.
      });
    }
  }

  setBackgroundScheduler(
    scheduleBackground: ((task: Promise<void>) => void) | undefined,
  ): void {
    if (scheduleBackground) this.#scheduleBackground = scheduleBackground;
  }

  getRefreshMode(): DataBundleRefreshMode {
    if (!this.#channelUrl) return "disabled";
    if (this.#periodicRefreshTimer) return "periodic-unref";
    return this.#scheduleBackground
      ? "request-driven-wait-until"
      : "request-driven";
  }

  startPeriodicRefresh(): boolean {
    if (!this.#channelUrl || this.#periodicRefreshTimer) return false;
    const timer = setInterval(() => {
      void this.refresh().catch(() => {
        // Provider status exposes failures without terminating the runtime.
      });
    }, this.#refreshIntervalMs);
    const unref = (timer as { unref?: () => void }).unref;
    unref?.call(timer);
    this.#periodicRefreshTimer = timer;
    return true;
  }

  stopPeriodicRefresh(): void {
    if (!this.#periodicRefreshTimer) return;
    clearInterval(this.#periodicRefreshTimer);
    this.#periodicRefreshTimer = null;
  }

  async acquireSnapshot(
    options: AcquireDataBundleSnapshotOptions = {},
  ): Promise<
    DataBundleSnapshotLease<RuntimeDataBundleShardDataV1>
  > {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    await this.#synchronizeRollbackHold();
    await this.#synchronizeActiveArchive();
    if (this.#activationPromise) {
      await this.#activationPromise;
    }
    let snapshot = options.bundleId
      ? this.#archives.get(options.bundleId)
      : this.#active;
    if (!snapshot && options.bundleId && this.#loadArchived) {
      snapshot = await this.#loadArchived(options.bundleId) ?? undefined;
      if (snapshot) this.#archives.set(snapshot.bundleId, snapshot);
    }
    if (!snapshot) {
      throw new Error(
        `Data bundle ${options.bundleId} is not retained by this provider.`,
      );
    }
    if (options.factionIds?.length) {
      for (const factionId of options.factionIds) {
        if (!snapshot.getFactionShard(factionId)) {
          throw new Error(
            `Data bundle ${snapshot.bundleId} has no faction shard for ${factionId}.`,
          );
        }
      }
    }
    this.#leaseCounts.set(
      snapshot.bundleId,
      (this.#leaseCounts.get(snapshot.bundleId) ?? 0) + 1,
    );
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      const remaining = Math.max(
        0,
        (this.#leaseCounts.get(snapshot.bundleId) ?? 1) - 1,
      );
      if (remaining === 0) {
        this.#leaseCounts.delete(snapshot.bundleId);
      } else {
        this.#leaseCounts.set(snapshot.bundleId, remaining);
      }
      await this.#activatePendingIfSafe();
      this.#pruneArchives();
    };
    const lease: DataBundleSnapshotLease<RuntimeDataBundleShardDataV1> =
      {
        leaseId: crypto.randomUUID(),
        snapshot,
        get released() {
          return released;
        },
        release,
      };
    this.#refreshIfDue();
    return lease;
  }

  async getStatus(): Promise<DataBundleProviderStatus> {
    await this.#synchronizeRollbackHold();
    await this.#synchronizeActiveArchive();
    return this.#status();
  }

  async refresh(
    options: RefreshDataBundleOptions = {},
  ): Promise<RefreshDataBundleResult> {
    await this.#synchronizeRollbackHold();
    if (this.#rollbackHold && !options.force) {
      return {
        status: this.#status(),
        activatedBundleId: null,
        classification: null,
      };
    }
    if (options.force && this.#rollbackHold) {
      await this.#clearRollbackHold?.();
      this.#rollbackHold = null;
    }
    if (!this.#channelUrl) {
      this.#state = "offline";
      return {
        status: this.#status(),
        activatedBundleId: null,
        classification: null,
      };
    }
    if (
      !options.force &&
      this.#lastCheckedAt &&
      this.#now().getTime() -
        new Date(this.#lastCheckedAt).getTime() <
        this.#refreshIntervalMs
    ) {
      return {
        status: this.#status(),
        activatedBundleId: null,
        classification: this.#candidate?.classification ?? null,
      };
    }
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#performRefresh(options).finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  async rollback(bundleId: string): Promise<DataBundleProviderStatus> {
    if (this.#refreshPromise) {
      await this.#refreshPromise;
    }
    if (this.#activationPromise) {
      await this.#activationPromise;
    }
    const snapshot =
      this.#archives.get(bundleId) ??
      (await this.#loadArchived?.(bundleId)) ??
      null;
    if (!snapshot) {
      throw new Error(
        `Archived data bundle ${bundleId} is not available for rollback.`,
      );
    }
    this.#archives.set(snapshot.bundleId, snapshot);
    const rollbackHold = {
      bundleId: snapshot.bundleId,
      engagedAt: this.#now().toISOString(),
      release: "force-refresh" as const,
    };
    await this.#persistRollbackHold?.(rollbackHold);
    this.#rollbackHold = rollbackHold;
    this.#pending = {
      snapshot,
      classification: null,
      quarantinedScopes: mergeQuarantines(
        this.#quarantinedScopes,
        signedCompositionQuarantines(snapshot),
      ),
    };
    this.#candidate = null;
    await this.#activatePendingIfSafe();
    if (this.#pending) this.#state = "candidate-ready";
    return this.#status();
  }

  async retainReference(
    referenceId: string,
    bundleId: string,
  ): Promise<void> {
    await this.#retainReference?.(referenceId, bundleId);
  }

  async releaseReference(
    referenceId: string,
    bundleId?: string,
  ): Promise<void> {
    await this.#releaseReference?.(referenceId, bundleId);
  }

  async #performRefresh(
    options: RefreshDataBundleOptions,
  ): Promise<RefreshDataBundleResult> {
    if (this.#activationPromise) {
      await this.#activationPromise;
    }
    this.#state = "checking";
    const checkedAt = this.#now().toISOString();
    try {
      const pointerInput = await responseJson(
        this.#fetch,
        this.#channelUrl!,
        CHANNEL_POINTER_BYTE_LIMIT,
        options.signal,
      );
      const pointer = await verifyDataBundleChannelPointer(
        pointerInput,
        this.#trustedKeys,
      );
      if (!pointer.ok) throw new Error(pointer.message);
      this.#latestUpstreamBundleId = pointer.data.bundleId;
      await this.#acceptChannelPointer(pointer.data, options.signal);
      if (pointer.data.bundleId === this.#active.bundleId) {
        this.#lastCheckedAt = checkedAt;
        this.#state = "ready";
        this.#candidate = null;
        return {
          status: this.#status(),
          activatedBundleId: null,
          classification: null,
        };
      }

      const manifestInput = await responseJson(
        this.#fetch,
        secureDataBundleUrl(
          pointer.data.manifestUrl,
          "The signed data-bundle manifest URL",
        ),
        MANIFEST_BYTE_LIMIT,
        options.signal,
      );
      const manifest = await verifyDataBundleManifest(
        manifestInput,
        this.#trustedKeys,
      );
      if (!manifest.ok) throw new Error(manifest.message);
      if (manifest.data.bundleId !== pointer.data.bundleId) {
        throw new Error(
          "The signed channel pointer and bundle manifest identify different bundles.",
        );
      }
      if (
        !isSupportedRuntimeDataBundleSchemaVersion(
          manifest.data.engineDataSchemaVersion,
        )
      ) {
        throw new Error(
          `Bundle ${manifest.data.bundleId} requires unsupported engine data schema ${manifest.data.engineDataSchemaVersion}.`,
        );
      }

      const verifiedShards: Array<
        VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
      > = [];
      for (const descriptor of manifest.data.shards) {
        const shardUrl = new URL(
          descriptor.path,
          secureDataBundleUrl(
            pointer.data.manifestUrl,
            "The signed data-bundle manifest URL",
          ),
        ).toString();
        const shardInput = await responseJson(
          this.#fetch,
          shardUrl,
          SHARD_BYTE_LIMIT,
          options.signal,
        );
        const shard = await verifyDataBundleShard<
          RuntimeDataBundleShardDataV1
        >(manifest.data, shardInput);
        if (!shard.ok) throw new Error(shard.message);
        assertRuntimeDataBundleShardData(
          shard.data.data,
          descriptor,
        );
        if (
          shard.data.data.schemaVersion !==
          manifest.data.engineDataSchemaVersion
        ) {
          throw new Error(
            `Runtime shard ${shard.data.shardId} schema ${shard.data.data.schemaVersion} does not match manifest engine schema ${manifest.data.engineDataSchemaVersion}.`,
          );
        }
        verifiedShards.push(shard.data);
      }
      const snapshot = createDataBundleSnapshot<
        RuntimeDataBundleShardDataV1
      >(manifest.data, verifiedShards, { acquiredAt: checkedAt });
      await assertRuntimeDataBundleSemanticIdentity(snapshot);
      let classification = classifyDataBundleDelta({
        current: this.#active.manifest,
        candidate: snapshot.manifest,
        factionDependencies: FACTION_DATA_DEPENDENCIES,
      });
      const currentGlobal = this.#active.getShard("global")?.data;
      const candidateGlobal = snapshot.getShard("global")?.data;
      const currentAuthority =
        currentGlobal?.payloadKind === "rosterpilot-runtime-global"
          ? currentGlobal.officialAuthority
          : undefined;
      const candidateAuthority =
        candidateGlobal?.payloadKind === "rosterpilot-runtime-global"
          ? candidateGlobal.officialAuthority
          : undefined;
      const authorityDowngrade =
        currentAuthority?.status === "verified" &&
        candidateAuthority?.status !== "verified";
      // The stable pointer is signed by the release authority only after CI
      // certification. A configured validator may impose an additional local
      // policy, but its absence must not make every semantic release unusable.
      const assessment = authorityDowngrade
        ? {
            status: "regressive" as const,
            scopes: ["official-authority"],
            reason:
              "The signed candidate attempts to downgrade a verified official-authority binding.",
          }
        : this.#validateCandidate
        ? await this.#validateCandidate({
            current: this.#active,
            candidate: snapshot,
            classification,
          })
        : { status: "verified" as const };
      if (assessment.status !== "verified") {
        classification = classifyDataBundleDelta({
          current: this.#active.manifest,
          candidate: snapshot.manifest,
          candidateAssessment: assessment.status,
          ambiguousScopes:
            assessment.scopes ?? classification.changedScopes,
          factionDependencies: FACTION_DATA_DEPENDENCIES,
        });
        this.#candidate = {
          bundleId: snapshot.bundleId,
          classification,
        };
        const candidateQuarantines = (
          assessment.scopes?.length
            ? assessment.scopes
            : ["bundle"]
        ).map((scope) => ({
          scope,
          bundleId: snapshot.bundleId,
          reason:
            assessment.reason ??
            "Candidate scope failed semantic validation.",
        }));
        this.#quarantinedScopes = mergeQuarantines(
          this.#quarantinedScopes,
          signedCompositionQuarantines(this.#active),
          candidateQuarantines,
        );
        await this.#recordQuarantine?.({
          bundleId: snapshot.bundleId,
          scopes:
            assessment.scopes?.length
              ? assessment.scopes
              : ["bundle"],
          reason:
            assessment.reason ??
            "Candidate scope failed semantic validation.",
        });
        this.#lastCheckedAt = checkedAt;
        this.#state = "degraded";
        return {
          status: this.#status(),
          activatedBundleId: null,
          classification,
        };
      }

      await this.#persistVerified?.({
        snapshot,
        classification,
      });
      this.#archives.set(snapshot.bundleId, snapshot);
      this.#latestVerifiedBundleId = snapshot.bundleId;
      this.#candidate = {
        bundleId: snapshot.bundleId,
        classification,
      };
      this.#pending = {
        snapshot,
        classification,
        quarantinedScopes: mergeQuarantines(
          this.#quarantinedScopes.filter(
            (entry) => entry.bundleId !== snapshot.bundleId,
          ),
          signedCompositionQuarantines(snapshot),
        ),
      };
      this.#lastCheckedAt = checkedAt;
      const activatedBundleId =
        (await this.#activatePendingIfSafe())
          ? snapshot.bundleId
          : null;
      if (!activatedBundleId) this.#state = "candidate-ready";
      this.#pruneArchives();
      return {
        status: this.#status(),
        activatedBundleId,
        classification,
      };
    } catch (error) {
      this.#lastCheckedAt = checkedAt;
      this.#state = "degraded";
      this.#quarantinedScopes = mergeQuarantines(
        this.#quarantinedScopes,
        signedCompositionQuarantines(this.#active),
        [
          {
            scope: "channel",
            bundleId:
              this.#latestUpstreamBundleId ?? "unknown",
            reason: errorMessage(error),
          },
        ],
      );
      throw error;
    }
  }

  async #acceptChannelPointer(
    pointer: VerifiedDataBundleChannelPointer,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#synchronizeChannelCursor();
    const pointerSha256 =
      await dataBundleChannelPointerSha256(pointer);
    if (
      this.#channelName &&
      pointer.channel !== this.#channelName
    ) {
      throw new Error(
        `The signed pointer names channel ${pointer.channel}, but this provider is configured for ${this.#channelName}.`,
      );
    }
    const current = this.#channelCursor;
    if (current?.pointerSha256 === pointerSha256) return;
    if (current && current.channel !== pointer.channel) {
      throw new Error(
        `The signed channel pointer names channel ${pointer.channel}, but the durable anti-replay cursor is bound to ${current.channel}.`,
      );
    }
    if (pointer.schemaVersion === 1) {
      if (current) {
        throw new Error(
          "A different legacy channel pointer cannot replace the durable anti-replay cursor. Publish a version-two pointer chained to the accepted legacy pointer.",
        );
      }
    } else {
      if (
        current &&
        current.revision !== null &&
        pointer.revision <= current.revision
      ) {
        throw new Error(
          `Rejected signed channel-pointer replay at revision ${pointer.revision}; revision ${current.revision} was already accepted.`,
        );
      }
      await this.#verifyChannelPointerAncestry(
        pointer,
        pointerSha256,
        current,
        signal,
      );
    }
    const cursor: DataBundleChannelCursorV1 = {
      schemaVersion: 1,
      channel: pointer.channel,
      pointerSchemaVersion: pointer.schemaVersion,
      revision:
        pointer.schemaVersion === 2 ? pointer.revision : null,
      pointerSha256,
      bundleId: pointer.bundleId,
      acceptedAt: this.#now().toISOString(),
    };
    if (this.#compareAndSetChannelCursor) {
      const result = await this.#compareAndSetChannelCursor({
        expectedPointerSha256: current?.pointerSha256 ?? null,
        cursor,
      });
      if (!result.committed) {
        this.#channelCursor = { ...result.cursor };
        if (result.cursor.pointerSha256 === pointerSha256) return;
        throw new Error(
          `The durable channel cursor advanced concurrently to revision ${result.cursor.revision ?? "legacy"}; retry against the current signed channel pointer.`,
        );
      }
      if (result.cursor.pointerSha256 !== pointerSha256) {
        throw new Error(
          "The durable channel-cursor store returned an unexpected value after compare-and-set.",
        );
      }
      this.#channelCursor = { ...result.cursor };
      return;
    }
    this.#channelCursor = cursor;
  }

  async #verifyChannelPointerAncestry(
    newest: VerifiedDataBundleChannelPointerV2,
    newestSha256: string,
    current: DataBundleChannelCursorV1 | null,
    signal?: AbortSignal,
  ): Promise<void> {
    let child: VerifiedDataBundleChannelPointer = newest;
    let childSha256 = newestSha256;
    for (
      let depth = 0;
      depth <= CHANNEL_POINTER_HISTORY_LIMIT;
      depth += 1
    ) {
      if (current?.pointerSha256 === childSha256) return;
      if (child.schemaVersion === 1 || child.previous === null) {
        if (current) {
          throw new Error(
            "The signed channel pointer is not descended from the durable anti-replay cursor.",
          );
        }
        return;
      }
      if (depth === CHANNEL_POINTER_HISTORY_LIMIT) {
        throw new Error(
          `The signed channel history exceeds the ${CHANNEL_POINTER_HISTORY_LIMIT}-pointer verification limit.`,
        );
      }
      const parentInput = await responseJson(
        this.#fetch,
        secureDataBundleUrl(
          child.previous.pointerUrl,
          "The signed predecessor channel-pointer URL",
        ),
        CHANNEL_POINTER_BYTE_LIMIT,
        signal,
      );
      const parent = await verifyDataBundleChannelPointer(
        parentInput,
        this.#trustedKeys,
      );
      if (!parent.ok) {
        throw new Error(
          `The predecessor channel pointer failed verification: ${parent.message}`,
        );
      }
      const parentSha256 =
        await dataBundleChannelPointerSha256(parent.data);
      if (parentSha256 !== child.previous.pointerSha256) {
        throw new Error(
          "The signed channel-pointer predecessor does not match its content-addressed hash.",
        );
      }
      if (parent.data.channel !== child.channel) {
        throw new Error(
          "A signed channel-pointer chain cannot cross channel names.",
        );
      }
      const expectedRevision =
        parent.data.schemaVersion === 2
          ? parent.data.revision + 1
          : 1;
      if (child.revision !== expectedRevision) {
        throw new Error(
          `Signed channel revision ${child.revision} does not immediately follow predecessor revision ${expectedRevision - 1}.`,
        );
      }
      if (child.transition.fromBundleId !== parent.data.bundleId) {
        throw new Error(
          "The signed channel transition is not bound to its predecessor bundle.",
        );
      }
      if (
        new Date(child.publishedAt).getTime() <
        new Date(parent.data.publishedAt).getTime()
      ) {
        throw new Error(
          "Signed channel publication time moved backwards within the pointer chain.",
        );
      }
      child = parent.data;
      childSha256 = parentSha256;
    }
  }

  async #activatePendingIfSafe(): Promise<boolean> {
    if (this.#activationPromise) {
      return this.#activationPromise;
    }
    if (!this.#pending) return false;
    await this.#synchronizeRollbackHold();
    if (
      this.#rollbackHold &&
      this.#pending.snapshot.bundleId !== this.#rollbackHold.bundleId
    ) {
      this.#state = "candidate-ready";
      return false;
    }
    if (
      [...this.#leaseCounts.values()].some((count) => count > 0)
    ) {
      return false;
    }
    const pending = this.#pending;
    this.#activationPromise = (async () => {
      await this.#activate(pending.snapshot);
      this.#active = pending.snapshot;
      this.#quarantinedScopes = pending.quarantinedScopes;
      if (this.#pending === pending) {
        this.#pending = null;
        this.#candidate = null;
      }
      this.#state = this.#channelUrl ? "ready" : "offline";
      return true;
    })();
    try {
      return await this.#activationPromise;
    } catch (error) {
      if (this.#pending === pending) {
        this.#pending = null;
        this.#candidate = null;
      }
      this.#state = "degraded";
      throw error;
    } finally {
      this.#activationPromise = null;
    }
  }

  async #synchronizeActiveArchive(): Promise<void> {
    if (!this.#loadActiveBundleId) return;
    const activeBundleId = await this.#loadActiveBundleId();
    const persistedBundleId =
      this.#rollbackHold?.bundleId ?? activeBundleId;
    if (!persistedBundleId) {
      throw new Error(
        "The durable data-bundle archive has no active bundle.",
      );
    }
    if (
      persistedBundleId === this.#active.bundleId ||
      persistedBundleId === this.#pending?.snapshot.bundleId
    ) {
      return;
    }
    const persisted =
      this.#archives.get(persistedBundleId) ??
      (await this.#loadArchived?.(persistedBundleId)) ??
      null;
    if (!persisted) {
      throw new Error(
        `The durable archive active pointer targets unavailable bundle ${persistedBundleId}.`,
      );
    }
    this.#archives.set(persisted.bundleId, persisted);
    this.#latestVerifiedBundleId = persisted.bundleId;
    this.#pending = {
      snapshot: persisted,
      classification: null,
      quarantinedScopes: mergeQuarantines(
        this.#quarantinedScopes,
        signedCompositionQuarantines(persisted),
      ),
    };
    this.#state = "candidate-ready";
    await this.#activatePendingIfSafe();
  }

  async #synchronizeRollbackHold(): Promise<void> {
    if (!this.#loadRollbackHold) return;
    const persisted = await this.#loadRollbackHold();
    this.#rollbackHold = persisted ? { ...persisted } : null;
  }

  async #synchronizeChannelCursor(): Promise<void> {
    if (!this.#loadChannelCursor) return;
    const persisted = await this.#loadChannelCursor();
    this.#channelCursor = persisted ? { ...persisted } : null;
  }

  #refreshIfDue(): void {
    if (
      !this.#channelUrl ||
      this.#refreshPromise ||
      this.#rollbackHold
    ) {
      return;
    }
    if (
      this.#lastCheckedAt &&
      this.#now().getTime() -
        new Date(this.#lastCheckedAt).getTime() <
        this.#refreshIntervalMs
    ) {
      return;
    }
    const task = this.refresh().then(() => undefined).catch(() => {
      // The provider status carries the failure without blocking the build.
    });
    if (this.#scheduleBackground) {
      try {
        this.#scheduleBackground(task);
      } catch {
        void task;
      }
    } else {
      void task;
    }
  }

  #pruneArchives(): void {
    const protectedIds = new Set([
      this.#active.bundleId,
      this.#latestVerifiedBundleId,
      ...(this.#pending ? [this.#pending.snapshot.bundleId] : []),
      ...this.#leaseCounts.keys(),
    ]);
    const removable = [...this.#archives.keys()].filter(
      (bundleId) => !protectedIds.has(bundleId),
    );
    while (
      this.#archives.size > this.#retainBundles &&
      removable.length > 0
    ) {
      this.#archives.delete(removable.shift()!);
    }
  }

  #status(): DataBundleProviderStatus {
    const global = this.#active.getShard("global")?.data;
    const officialAuthority =
      global?.payloadKind === "rosterpilot-runtime-global" &&
      global.officialAuthority
        ? structuredClone(global.officialAuthority)
        : {
            status: "unverified-overlay" as const,
            reason:
              "The active signed bundle predates explicit official-authority evidence status.",
          };
    return {
      state: this.#state,
      activeBundleId: this.#active.bundleId,
      latestVerifiedBundleId: this.#latestVerifiedBundleId,
      latestUpstreamBundleId: this.#latestUpstreamBundleId,
      candidate: this.#candidate,
      quarantinedScopes: [...this.#quarantinedScopes],
      lastCheckedAt: this.#lastCheckedAt,
      officialAuthority,
      refreshMode: this.getRefreshMode(),
      rollbackHold: this.#rollbackHold
        ? { ...this.#rollbackHold }
        : null,
      ...(this.#durability
        ? { durability: this.#durability() }
        : {}),
    };
  }
}
