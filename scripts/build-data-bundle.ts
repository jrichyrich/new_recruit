import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSignedDataBundleChannelPointer,
  dataBundleChannelPointerSha256,
  DataBundleChannelPointerSchema,
  DataBundleManifestV1Schema,
  verifyDataBundleChannelPointer,
  type DataBundleChannelPointer,
  type DataBundleChannelPointerV2,
  type DataBundleManifestV1,
  type DataBundleSnapshot,
  type DataBundleSigner,
  type Ed25519KeyRegistry,
} from "../lib/rosterpilot/data-bundle";
import {
  FACTION_DATA_DEPENDENCIES,
  buildRuntimeDataBundle,
  buildRuntimeDataBundleWithRetainedOfficialEvidence,
  composeRuntimeDataBundleRetainingVerifiedShards,
  runtimeOfficialCarryForward,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
  type RuntimeDataBundleBuild,
  type RuntimeDataBundleShardDataV1,
  type RuntimeDataBundleQuarantinedFaction,
  type SignedRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  classifyDataBundleDelta,
  semanticHash,
  type DataBundleDeltaResult,
} from "../lib/rosterpilot/semantic-hash";
import {
  applyOfficialRulesOverlay,
  verifyOfficialPublicationEvidence,
  type OfficialPublicationEvidenceInput,
} from "../lib/rosterpilot/official-data";
import {
  mergeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  CertificationManifestSchema,
} from "../lib/rosterpilot/certification";

type CertificationDocument = NonNullable<
  Parameters<typeof buildRuntimeDataBundle>[0]
>["certification"];

export const DATA_BUNDLE_BUILD_USAGE = `Usage: npm run data:bundle:build -- [options]

Build and sign the runtime data bundle represented by this checkout.

Options:
  --out-dir <path>             Output root (default: dist/data-channel).
  --channel <name>             Signed channel name (default: stable).
  --manifest-base-url <url>    Public root containing bundles/ and channels/.
  --previous-manifest <path>   Compare with the currently published manifest.
  --previous-channel-pointer <path>
                               Extend this verified signed channel pointer.
  --previous-bundle-dir <path> Directory containing that manifest's shards.
  --retain-factions <ids>      Comma-separated failed faction ids to retain
                               from the verified previous bundle.
  --quarantine-reason <text>   Certification failure recorded for retained
                               faction shards.
  --trusted-keys <path>        Public-key registry used to verify retained
                               shards (default: data/data-bundle-trusted-keys.json).
  --official-reconciliation-evidence <path>
                               Official rules overlay JSON.
  --official-source-artifact <path>
                               Exact source bytes covered by that overlay.
  --official-legend-source-artifact <source-id=path>
                               Exact faction-pack bytes for a schema-v2
                               Legends source. Repeat once per source id.
  --official-extraction-receipt <path>
                               Reviewed extractor's signed inventory receipt.
  --official-extractor-trusted-keys <path>
                               Reviewed extractor public-key registry (default:
                               data/official-extractor-trusted-keys.json).
  --official-authority-unavailable <reason>
                               Explicit degraded genesis-channel authority.
  --created-at <ISO instant>   Override the manifest creation time.
  -h, --help                   Show help without reading data or signing.

Signing is accepted only through ROSTERPILOT_DATA_SIGNING_KEY_ID and
ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK. Never pass private key material as a
command-line argument or commit it to the repository.
`;

export class DataBundleBuildCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataBundleBuildCliUsageError";
  }
}

export type DataBundleBuildCliArgs = {
  help: boolean;
  outDir: string;
  channel: string;
  manifestBaseUrl: string | null;
  previousManifest: string | null;
  previousChannelPointer: string | null;
  previousBundleDirectory: string | null;
  retainFactions: string[];
  quarantineReason: string | null;
  trustedKeys: string | null;
  officialReconciliationEvidence: string | null;
  officialSourceArtifact: string | null;
  officialLegendSourceArtifacts: Record<string, string>;
  officialExtractionReceipt: string | null;
  officialExtractorTrustedKeys: string;
  officialAuthorityUnavailableReason: string | null;
  createdAt: string | null;
};

export type DataBundleUpdateReportV1 = {
  schemaVersion: 1;
  channel: string;
  previousBundleId: string | null;
  candidateBundleId: string;
  createdAt: string;
  delta: DataBundleDeltaResult | null;
  composition: DataBundleManifestV1["composition"] | null;
  officialReconciliation:
    RuntimeDataBundleBuild["officialReconciliation"];
};

export type PublishedDataBundle = {
  manifest: DataBundleManifestV1;
  channelPointer: DataBundleChannelPointerV2;
  updateReport: DataBundleUpdateReportV1;
  bundleDirectory: string;
  manifestPath: string;
  channelPath: string;
  updateReportPath: string;
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolvedPath(root: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(root, candidate);
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DataBundleBuildCliUsageError(
      `${option} requires a value.`,
    );
  }
  return value;
}

function assignKeyedPath(
  target: Record<string, string>,
  raw: string,
  option: string,
): void {
  const separator = raw.indexOf("=");
  const sourceId = raw.slice(0, separator).trim();
  const filename = raw.slice(separator + 1).trim();
  if (separator <= 0 || !sourceId || !filename) {
    throw new DataBundleBuildCliUsageError(
      `${option} requires <source-id=path>.`,
    );
  }
  if (Object.hasOwn(target, sourceId)) {
    throw new DataBundleBuildCliUsageError(
      `${option} repeats source id ${sourceId}.`,
    );
  }
  Object.defineProperty(target, sourceId, {
    configurable: true,
    enumerable: true,
    value: filename,
    writable: true,
  });
}

export function parseDataBundleBuildArgs(
  argv: readonly string[],
): DataBundleBuildCliArgs {
  const parsed: DataBundleBuildCliArgs = {
    help: false,
    outDir: "dist/data-channel",
    channel: "stable",
    manifestBaseUrl: null,
    previousManifest: null,
    previousChannelPointer: null,
    previousBundleDirectory: null,
    retainFactions: [],
    quarantineReason: null,
    trustedKeys: null,
    officialReconciliationEvidence: null,
    officialSourceArtifact: null,
    officialLegendSourceArtifacts: {},
    officialExtractionReceipt: null,
    officialExtractorTrustedKeys:
      "data/official-extractor-trusted-keys.json",
    officialAuthorityUnavailableReason: null,
    createdAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--out-dir") {
      parsed.outDir = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === "--channel") {
      parsed.channel = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === "--manifest-base-url") {
      parsed.manifestBaseUrl = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--previous-manifest") {
      parsed.previousManifest = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--previous-channel-pointer") {
      parsed.previousChannelPointer = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--previous-bundle-dir") {
      parsed.previousBundleDirectory = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--retain-factions") {
      parsed.retainFactions.push(
        ...requiredValue(argv, index, argument)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      parsed.retainFactions = [
        ...new Set(parsed.retainFactions),
      ].sort();
      index += 1;
    } else if (argument === "--quarantine-reason") {
      parsed.quarantineReason = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--trusted-keys") {
      parsed.trustedKeys = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-reconciliation-evidence"
    ) {
      parsed.officialReconciliationEvidence = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-source-artifact") {
      parsed.officialSourceArtifact = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-legend-source-artifact"
    ) {
      assignKeyedPath(
        parsed.officialLegendSourceArtifacts,
        requiredValue(argv, index, argument),
        argument,
      );
      index += 1;
    } else if (argument === "--official-extraction-receipt") {
      parsed.officialExtractionReceipt = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-extractor-trusted-keys"
    ) {
      parsed.officialExtractorTrustedKeys = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-authority-unavailable") {
      parsed.officialAuthorityUnavailableReason = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--created-at") {
      parsed.createdAt = requiredValue(argv, index, argument);
      index += 1;
    } else {
      throw new DataBundleBuildCliUsageError(
        `Unknown data-bundle build option: ${argument}`,
      );
    }
  }
  return parsed;
}

export function dataBundleSignerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DataBundleSigner {
  const keyId = environment.ROSTERPILOT_DATA_SIGNING_KEY_ID?.trim();
  const encodedKey =
    environment.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK?.trim();
  if (!keyId || !encodedKey) {
    throw new Error(
      "Signed data-bundle publication requires ROSTERPILOT_DATA_SIGNING_KEY_ID and ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK.",
    );
  }
  let privateKey: unknown;
  try {
    privateKey = JSON.parse(encodedKey);
  } catch {
    throw new Error(
      "ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK must contain one JSON-encoded Ed25519 private JWK.",
    );
  }
  if (
    !privateKey ||
    typeof privateKey !== "object" ||
    Array.isArray(privateKey) ||
    (privateKey as JsonWebKey).kty !== "OKP" ||
    (privateKey as JsonWebKey).crv !== "Ed25519" ||
    typeof (privateKey as JsonWebKey).d !== "string"
  ) {
    throw new Error(
      "ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK is not an Ed25519 private JWK.",
    );
  }
  return {
    keyId,
    privateKey: privateKey as JsonWebKey,
  };
}

function readManifest(filename: string): DataBundleManifestV1 {
  return DataBundleManifestV1Schema.parse(
    JSON.parse(readFileSync(filename, "utf8")),
  );
}

function readChannelPointer(filename: string): DataBundleChannelPointer {
  return DataBundleChannelPointerSchema.parse(
    JSON.parse(readFileSync(filename, "utf8")),
  );
}

type TrustedKeyFile = {
  schemaVersion: 1;
  keys: Array<{
    keyId: string;
    publicKey: JsonWebKey;
  }>;
};

export function trustedPublisherKeys(
  root: string,
  filename: string | null,
  signer: DataBundleSigner,
): Ed25519KeyRegistry {
  const keys: Record<string, JsonWebKey> = {};
  const configured = filename
    ? resolvedPath(root, filename)
    : path.join(
        root,
        "data",
        "data-bundle-trusted-keys.json",
      );
  if (existsSync(configured)) {
    const registry = JSON.parse(
      readFileSync(configured, "utf8"),
    ) as TrustedKeyFile;
    if (
      registry.schemaVersion !== 1 ||
      !Array.isArray(registry.keys)
    ) {
      throw new Error(
        `Trusted data-bundle key registry is invalid: ${configured}.`,
      );
    }
    for (const entry of registry.keys) {
      if (
        !entry ||
        typeof entry.keyId !== "string" ||
        !entry.keyId ||
        entry.publicKey?.kty !== "OKP" ||
        entry.publicKey.crv !== "Ed25519" ||
        typeof entry.publicKey.x !== "string"
      ) {
        throw new Error(
          `Trusted data-bundle key registry is invalid: ${configured}.`,
        );
      }
      keys[entry.keyId] = entry.publicKey;
    }
  } else if (filename) {
    throw new Error(
      `Trusted data-bundle key registry does not exist: ${configured}.`,
    );
  }
  if (
    !(signer.privateKey instanceof CryptoKey) &&
    signer.privateKey.kty === "OKP" &&
    signer.privateKey.crv === "Ed25519" &&
    typeof signer.privateKey.x === "string"
  ) {
    keys[signer.keyId] = {
      kty: "OKP",
      crv: "Ed25519",
      x: signer.privateKey.x,
      key_ops: ["verify"],
      ext: true,
    };
  }
  return keys;
}

async function readVerifiedPreviousRuntimeBundle(
  input: {
    manifest: DataBundleManifestV1;
    directory: string;
    trustedKeys: Ed25519KeyRegistry;
  },
) {
  const shards = input.manifest.shards.map((descriptor) =>
    JSON.parse(
      readFileSync(
        path.resolve(
          input.directory,
          ...descriptor.path.split("/"),
        ),
        "utf8",
      ),
    ),
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: input.manifest,
    shards,
    trustedKeys: input.trustedKeys,
  });
  if (!verified.ok) {
    throw new Error(
      `Cannot retain shards from an unverified previous bundle: ${verified.message}`,
    );
  }
  return verified.data;
}

function assertSameJson(
  filename: string,
  value: unknown,
): void {
  const existing = JSON.parse(readFileSync(filename, "utf8"));
  if (canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(
      `Immutable data-bundle path already contains different content: ${filename}.`,
    );
  }
}

function writeImmutableJson(
  filename: string,
  value: unknown,
): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  if (existsSync(filename)) {
    assertSameJson(filename, value);
    return;
  }
  writeFileSync(filename, stableJson(value), { flag: "wx" });
}

function writeAtomicJson(filename: string, value: unknown): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.next-${process.pid}`;
  writeFileSync(temporary, stableJson(value), { flag: "wx" });
  renameSync(temporary, filename);
}

function manifestBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Data-bundle manifest base URL is invalid: ${value}.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      "Published data-bundle URLs must use HTTPS.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function deltaAgainst(
  previous: DataBundleManifestV1 | null,
  candidate: Pick<
    DataBundleManifestV1,
    "engineDataSchemaVersion" | "semanticHashes"
  >,
): DataBundleDeltaResult | null {
  if (!previous) return null;
  return classifyDataBundleDelta({
    current: previous,
    candidate,
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
}

export function officialReconciliationAssessment(
  previous: DataBundleManifestV1 | null,
  candidate: RuntimeDataBundleBuild,
  officialEvidence?: OfficialPublicationEvidenceInput,
): DataBundleDeltaResult | null {
  if (!previous) return null;
  const changed =
    previous.provenance.official.version !==
      candidate.draft.provenance.official.version ||
    previous.provenance.official.contentSha256 !==
      candidate.draft.provenance.official.contentSha256;
  if (
    !changed ||
    (candidate.officialReconciliation &&
      officialEvidence !== undefined)
  ) {
    return null;
  }
  return classifyDataBundleDelta({
    current: previous,
    candidate: candidate.draft,
    candidateAssessment: "ambiguous",
    ambiguousScopes: ["official"],
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
}

async function retainedOverlayIsAppliedToCandidate(
  build: RuntimeDataBundleBuild,
  overlay: unknown,
): Promise<boolean> {
  const rulesData = mergeRuntimeRulesData(
    build.shards.map((shard) => shard.data.rulesData),
  );
  const applied = await applyOfficialRulesOverlay(rulesData, overlay);
  return (
    canonicalJson(applied.rulesData) === canonicalJson(rulesData) &&
    build.officialReconciliation?.overlayHash ===
      applied.overlayHash &&
    canonicalJson(
      build.officialReconciliation?.affectedFactions ?? [],
    ) === canonicalJson(applied.affectedFactions)
  );
}

export async function publishSignedDataBundle(
  build: RuntimeDataBundleBuild,
  options: {
    outputRoot: string;
    channel: string;
    publicBaseUrl: string;
    signer: DataBundleSigner;
    previousManifest?: DataBundleManifestV1 | null;
    previousChannelPointer?: DataBundleChannelPointer | null;
    previousSnapshot?: DataBundleSnapshot<RuntimeDataBundleShardDataV1> | null;
    officialEvidence?: OfficialPublicationEvidenceInput;
    officialAuthorityUnavailableReason?: string | null;
    publishedAt?: string;
  },
): Promise<PublishedDataBundle> {
  const officialAssessment = officialReconciliationAssessment(
    options.previousManifest ?? null,
    build,
    options.officialEvidence,
  );
  if (officialAssessment?.quarantine) {
    throw new Error(
      `Candidate data bundle is ${officialAssessment.classification} in scope official and must be quarantined: no reviewed, source-bound official extraction evidence was supplied for the changed Games Workshop publication.`,
    );
  }
  const candidateGlobal = build.shards.find(
    (shard) => shard.data.payloadKind === "rosterpilot-runtime-global",
  )?.data;
  const candidateAuthority =
    candidateGlobal?.payloadKind === "rosterpilot-runtime-global"
      ? candidateGlobal.officialAuthority
      : undefined;
  const previousGlobal = options.previousSnapshot
    ?.getShard("global")
    ?.data;
  const previousAuthority =
    previousGlobal?.payloadKind === "rosterpilot-runtime-global"
      ? previousGlobal.officialAuthority
      : undefined;
  if (
    !options.previousManifest &&
    candidateAuthority &&
    candidateAuthority.status !== "verified" &&
    !options.officialAuthorityUnavailableReason?.trim()
  ) {
    throw new Error(
      "The first stable-channel publication requires reviewed official extraction evidence, or --official-authority-unavailable with a reviewable reason.",
    );
  }
  if (
    !options.previousManifest &&
    candidateAuthority?.status === "unavailable" &&
    options.officialAuthorityUnavailableReason?.trim() &&
    candidateAuthority.reason !==
      options.officialAuthorityUnavailableReason
  ) {
    throw new Error(
      "The signed genesis bundle does not contain the supplied unavailable-authority reason.",
    );
  }
  if (
    previousAuthority?.status === "verified" &&
    candidateAuthority?.status !== "verified"
  ) {
    throw new Error(
      "Candidate data bundle is ambiguous/regressive in scope official-authority and must be quarantined: an unchanged refresh cannot downgrade a verified authority binding. Supply the reviewed evidence again.",
    );
  }
  if (build.officialReconciliation) {
    if (!options.officialEvidence) {
      const inherited = options.previousSnapshot
        ? await runtimeOfficialCarryForward(options.previousSnapshot)
        : null;
      const officialProvenanceUnchanged = Boolean(
        options.previousManifest &&
          options.previousManifest.provenance.official.version ===
            build.draft.provenance.official.version &&
          options.previousManifest.provenance.official.contentSha256 ===
            build.draft.provenance.official.contentSha256,
      );
      const rulesProvenanceUnchanged = Boolean(
        options.previousManifest &&
          canonicalJson(options.previousManifest.provenance.rules) ===
            canonicalJson(build.draft.provenance.rules),
      );
      const unchangedRulesSemanticsPreserved = Boolean(
        rulesProvenanceUnchanged &&
        options.previousManifest &&
          Object.entries(
            options.previousManifest.semanticHashes.factions,
          ).every(([factionId, previous]) => {
            const candidate =
              build.draft.semanticHashes.factions[factionId];
            return (
              candidate?.factionRulesHash ===
                previous.factionRulesHash &&
              candidate?.conflictHash === previous.conflictHash
            );
          }),
      );
      const authorityPreserved = Boolean(
        inherited &&
          canonicalJson(candidateAuthority) ===
            canonicalJson(inherited.authority),
      );
      const reconciliationPreserved = Boolean(
        inherited &&
          canonicalJson(build.officialReconciliation) ===
            canonicalJson(inherited.reconciliation),
      );
      const candidateOverlay =
        candidateGlobal?.payloadKind ===
        "rosterpilot-runtime-global"
          ? candidateGlobal.officialEvidenceOverlay ?? null
          : null;
      const retainedOverlayReapplied = Boolean(
        !rulesProvenanceUnchanged &&
          inherited?.overlay &&
          candidateOverlay &&
          canonicalJson(candidateOverlay) ===
            canonicalJson(inherited.overlay) &&
          (await retainedOverlayIsAppliedToCandidate(
            build,
            inherited.overlay,
          )),
      );
      const failedChecks = [
        !inherited ? "verified-prior-snapshot" : null,
        !officialProvenanceUnchanged
          ? "official-source-provenance"
          : null,
        rulesProvenanceUnchanged &&
        !unchangedRulesSemanticsPreserved
          ? "effective-rules"
          : null,
        !rulesProvenanceUnchanged && !retainedOverlayReapplied
          ? "retained-overlay-reapplication"
          : null,
        !authorityPreserved ? "authority-binding" : null,
        rulesProvenanceUnchanged && !reconciliationPreserved
          ? "reconciliation"
          : null,
      ].filter((value): value is string => value !== null);
      if (failedChecks.length > 0) {
        throw new Error(
          `Candidate data bundle is ambiguous/regressive in scope official and must be quarantined: official changes require new reviewed evidence; an unchanged official publication may preserve an unchanged effective snapshot or reapply the exact receipt-bound overlay retained by the previous verified bundle. Failed checks: ${failedChecks.join(", ")}.`,
        );
      }
    } else {
      const verified = await verifyOfficialPublicationEvidence(
        options.officialEvidence,
      );
      const overlay = verified.overlay;
      if (
        overlay.source.version !==
          build.draft.provenance.official.version ||
        overlay.source.contentSha256 !==
          build.draft.provenance.official.contentSha256 ||
        (await semanticHash(overlay)) !==
          build.officialReconciliation.overlayHash
      ) {
        throw new Error(
          "Candidate data bundle is ambiguous/regressive in scope official and must be quarantined: the official overlay does not bind the candidate reconciliation.",
        );
      }
      const global = build.shards.find(
        (shard) =>
          shard.data.payloadKind === "rosterpilot-runtime-global",
      )?.data;
      if (
        !global ||
        global.payloadKind !== "rosterpilot-runtime-global" ||
        global.officialAuthority.status !== "verified" ||
        global.officialAuthority.sourceArtifactSha256 !==
          verified.sourceArtifactSha256 ||
        global.officialAuthority.overlaySha256 !==
          verified.overlaySha256 ||
        global.officialAuthority.receiptSha256 !==
          verified.receiptSha256 ||
        global.officialAuthority.extractorId !==
          verified.extractorId ||
        global.officialAuthority.extractorKeyId !==
          verified.extractorKeyId
      ) {
        throw new Error(
          "Candidate data bundle is ambiguous/regressive in scope official and must be quarantined: its signed global shard lacks the reviewed official-authority binding.",
        );
      }
    }
  }
  const signed: SignedRuntimeDataBundle =
    await signRuntimeDataBundle(build, options.signer);
  const delta = deltaAgainst(
    options.previousManifest ?? null,
    signed.manifest,
  );
  if (delta?.quarantine) {
    throw new Error(
      `Candidate data bundle must be quarantined: ${delta.reasons.join(" ")}`,
    );
  }
  const publicBaseUrl = manifestBaseUrl(options.publicBaseUrl);
  const publishedAt =
    options.publishedAt ?? new Date().toISOString();
  const previousPointer =
    options.previousChannelPointer ?? null;
  if (
    options.previousManifest &&
    !previousPointer
  ) {
    throw new Error(
      "Publishing over an existing data bundle requires its signed channel pointer so the new pointer can extend the anti-replay chain.",
    );
  }
  if (
    previousPointer &&
    previousPointer.channel !== options.channel
  ) {
    throw new Error(
      `The previous pointer belongs to channel ${previousPointer.channel}, not ${options.channel}.`,
    );
  }
  if (
    previousPointer &&
    options.previousManifest &&
    previousPointer.bundleId !== options.previousManifest.bundleId
  ) {
    throw new Error(
      "The previous signed channel pointer does not identify the previous manifest.",
    );
  }
  const previousPointerSha256 = previousPointer
    ? await dataBundleChannelPointerSha256(previousPointer)
    : null;
  const channelPointer =
    await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 2,
        channel: options.channel,
        bundleId: signed.manifest.bundleId,
        manifestUrl:
          `${publicBaseUrl}/bundles/` +
          `${signed.manifest.bundleId}/manifest.json`,
        publishedAt,
        revision:
          previousPointer?.schemaVersion === 2
            ? previousPointer.revision + 1
            : previousPointer
              ? 1
              : 0,
        previous: previousPointerSha256
          ? {
              pointerSha256: previousPointerSha256,
              pointerUrl:
                `${publicBaseUrl}/channels/${options.channel}/` +
                `${previousPointerSha256}.json`,
            }
          : null,
        transition: {
          kind: "publish",
          fromBundleId: previousPointer?.bundleId ?? null,
        },
      },
      options.signer,
    );
  const updateReport: DataBundleUpdateReportV1 = {
    schemaVersion: 1,
    channel: options.channel,
    previousBundleId:
      options.previousManifest?.bundleId ?? null,
    candidateBundleId: signed.manifest.bundleId,
    createdAt: publishedAt,
    delta,
    composition: signed.manifest.composition ?? null,
    officialReconciliation: build.officialReconciliation,
  };

  const bundleDirectory = path.join(
    options.outputRoot,
    "bundles",
    signed.manifest.bundleId,
  );
  const manifestPath = path.join(bundleDirectory, "manifest.json");
  for (const shard of signed.shards) {
    const descriptor = signed.manifest.shards.find(
      (candidate) => candidate.shardId === shard.shardId,
    );
    if (!descriptor) {
      throw new Error(
        `Signed data bundle omitted descriptor for shard "${shard.shardId}".`,
      );
    }
    writeImmutableJson(
      path.join(bundleDirectory, ...descriptor.path.split("/")),
      shard,
    );
  }
  writeImmutableJson(manifestPath, signed.manifest);

  const channelDirectory = path.join(
    options.outputRoot,
    "channels",
  );
  const channelPath = path.join(
    channelDirectory,
    `${options.channel}.json`,
  );
  const updateReportPath = path.join(
    channelDirectory,
    `${options.channel}.update.json`,
  );
  const historyDirectory = path.join(
    channelDirectory,
    options.channel,
  );
  if (previousPointer && previousPointerSha256) {
    writeImmutableJson(
      path.join(historyDirectory, `${previousPointerSha256}.json`),
      DataBundleChannelPointerSchema.parse(previousPointer),
    );
  }
  writeImmutableJson(
    path.join(
      historyDirectory,
      `${await dataBundleChannelPointerSha256(channelPointer)}.json`,
    ),
    channelPointer,
  );
  writeAtomicJson(updateReportPath, updateReport);
  // The signed pointer moves last. Readers can never observe it before every
  // content-addressed object and its informational delta report are durable.
  writeAtomicJson(channelPath, channelPointer);

  return {
    manifest: signed.manifest,
    channelPointer,
    updateReport,
    bundleDirectory,
    manifestPath,
    channelPath,
    updateReportPath,
  };
}

async function readCertification(
  root: string,
): Promise<CertificationDocument> {
  const filename = path.join(
    root,
    "data",
    "certification-manifest.json",
  );
  return CertificationManifestSchema.parse(
    JSON.parse(readFileSync(filename, "utf8")),
  );
}

export async function runBuildDataBundleCli(
  argv: readonly string[],
  options: {
    root?: string;
    environment?: NodeJS.ProcessEnv;
    writeOutput?: (value: string) => void;
  } = {},
): Promise<void> {
  const args = parseDataBundleBuildArgs(argv);
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.help) {
    writeOutput(DATA_BUNDLE_BUILD_USAGE);
    return;
  }
  const root = options.root ?? process.cwd();
  const publicBaseUrl =
    args.manifestBaseUrl ??
    options.environment?.ROSTERPILOT_DATA_BUNDLE_BASE_URL ??
    process.env.ROSTERPILOT_DATA_BUNDLE_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error(
      "Set --manifest-base-url or ROSTERPILOT_DATA_BUNDLE_BASE_URL before publishing a signed bundle.",
    );
  }
  const createdAt = args.createdAt ?? new Date().toISOString();
  const officialOverlay = args.officialReconciliationEvidence
    ? JSON.parse(
        readFileSync(
          resolvedPath(
            root,
            args.officialReconciliationEvidence,
          ),
          "utf8",
        ),
      )
    : undefined;
  const hasAnyOfficialEvidence = Boolean(
    args.officialReconciliationEvidence ||
      args.officialSourceArtifact ||
      args.officialExtractionReceipt ||
      Object.keys(args.officialLegendSourceArtifacts).length > 0,
  );
  const hasCompleteOfficialEvidence = Boolean(
    args.officialReconciliationEvidence &&
      args.officialSourceArtifact &&
      args.officialExtractionReceipt,
  );
  if (hasAnyOfficialEvidence && !hasCompleteOfficialEvidence) {
    throw new Error(
      "Official publication requires --official-reconciliation-evidence, --official-source-artifact, and --official-extraction-receipt together.",
    );
  }
  if (
    hasAnyOfficialEvidence &&
    args.officialAuthorityUnavailableReason
  ) {
    throw new Error(
      "Official extraction evidence and --official-authority-unavailable are mutually exclusive.",
    );
  }
  const officialEvidence: OfficialPublicationEvidenceInput | undefined =
    hasCompleteOfficialEvidence
      ? {
          overlay: officialOverlay,
          sourceArtifact: readFileSync(
            resolvedPath(root, args.officialSourceArtifact!),
          ),
          legendSourceArtifacts: Object.fromEntries(
            Object.entries(
              args.officialLegendSourceArtifacts,
            ).map(([sourceId, artifactPath]) => [
              sourceId,
              readFileSync(resolvedPath(root, artifactPath)),
            ]),
          ),
          extractionReceipt: JSON.parse(
            readFileSync(
              resolvedPath(root, args.officialExtractionReceipt!),
              "utf8",
            ),
          ),
          trustedExtractors: JSON.parse(
            readFileSync(
              resolvedPath(
                root,
                args.officialExtractorTrustedKeys,
              ),
              "utf8",
            ),
          ),
        }
      : undefined;
  const verifiedOfficialEvidence = officialEvidence
    ? await verifyOfficialPublicationEvidence(officialEvidence)
    : null;
  const certification = await readCertification(root);
  let candidateBuild = await buildRuntimeDataBundle({
    certification,
    officialOverlay,
    officialAuthority: verifiedOfficialEvidence
      ? {
          status: "verified",
          sourceArtifactSha256:
            verifiedOfficialEvidence.sourceArtifactSha256,
          overlaySha256: verifiedOfficialEvidence.overlaySha256,
          receiptSha256: verifiedOfficialEvidence.receiptSha256,
          extractorId: verifiedOfficialEvidence.extractorId,
          extractorKeyId: verifiedOfficialEvidence.extractorKeyId,
        }
      : args.officialAuthorityUnavailableReason
        ? {
            status: "unavailable",
            reason: args.officialAuthorityUnavailableReason,
          }
        : undefined,
    createdAt,
  });
  const previousManifestPath = args.previousManifest
    ? resolvedPath(root, args.previousManifest)
    : null;
  const previousManifest = previousManifestPath
    ? readManifest(previousManifestPath)
    : null;
  const signer = dataBundleSignerFromEnvironment(
    options.environment ?? process.env,
  );
  const previousSnapshot =
    previousManifest && previousManifestPath
      ? await readVerifiedPreviousRuntimeBundle({
          manifest: previousManifest,
          directory: args.previousBundleDirectory
            ? resolvedPath(root, args.previousBundleDirectory)
            : path.dirname(previousManifestPath),
          trustedKeys: trustedPublisherKeys(
            root,
            args.trustedKeys,
            signer,
          ),
        })
      : null;
  if (!officialEvidence && previousSnapshot) {
    candidateBuild =
      await buildRuntimeDataBundleWithRetainedOfficialEvidence(
        {
          certification,
          officialAuthority: args.officialAuthorityUnavailableReason
            ? {
                status: "unavailable",
                reason: args.officialAuthorityUnavailableReason,
              }
            : undefined,
          createdAt,
        },
        previousSnapshot,
      );
  }
  const inferredPreviousPointerPath = previousManifestPath
    ? path.resolve(
        path.dirname(previousManifestPath),
        "..",
        "..",
        "channels",
        `${args.channel}.json`,
      )
    : null;
  const previousPointerPath = args.previousChannelPointer
    ? resolvedPath(root, args.previousChannelPointer)
    : inferredPreviousPointerPath &&
        existsSync(inferredPreviousPointerPath)
      ? inferredPreviousPointerPath
      : null;
  const previousChannelPointer = previousPointerPath
    ? readChannelPointer(previousPointerPath)
    : null;
  if (previousChannelPointer) {
    const verifiedPointer = await verifyDataBundleChannelPointer(
      previousChannelPointer,
      trustedPublisherKeys(root, args.trustedKeys, signer),
    );
    if (!verifiedPointer.ok) {
      throw new Error(
        `Cannot extend an unverified channel pointer: ${verifiedPointer.message}`,
      );
    }
  }
  if (
    args.retainFactions.length > 0 &&
    (!previousManifest ||
      !previousManifestPath ||
      !args.quarantineReason)
  ) {
    throw new Error(
      "--retain-factions requires --previous-manifest and --quarantine-reason.",
    );
  }
  let build = candidateBuild;
  if (
    args.retainFactions.length > 0 &&
    previousManifest &&
    previousManifestPath &&
    args.quarantineReason
  ) {
    const previous = previousSnapshot!;
    const quarantinedFactions:
      RuntimeDataBundleQuarantinedFaction[] =
      args.retainFactions.map((factionId) => ({
        factionId,
        scopes: [`faction:${factionId}:certification`],
        reason: args.quarantineReason!,
      }));
    build =
      await composeRuntimeDataBundleRetainingVerifiedShards({
        candidate: candidateBuild,
        previous,
        quarantinedFactions,
      });
  }
  const result = await publishSignedDataBundle(build, {
    outputRoot: resolvedPath(root, args.outDir),
    channel: args.channel,
    publicBaseUrl,
    signer,
    previousManifest,
    previousChannelPointer,
    previousSnapshot,
    officialEvidence,
    officialAuthorityUnavailableReason:
      args.officialAuthorityUnavailableReason,
    publishedAt: createdAt,
  });
  writeOutput(
    `${JSON.stringify(
      {
        ok: true,
        bundleId: result.manifest.bundleId,
        manifestPath: result.manifestPath,
        channelPath: result.channelPath,
        classification:
          result.updateReport.delta?.classification ?? "bootstrap",
        affectedFactions:
          result.updateReport.delta?.affectedFactions ?? [],
        retainedFactions:
          result.manifest.composition?.retainedShards.flatMap(
            (entry) =>
              result.manifest.shards.find(
                (descriptor) =>
                  descriptor.shardId === entry.shardId,
              )?.factionIds ?? [],
          ) ?? [],
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  try {
    await runBuildDataBundleCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof DataBundleBuildCliUsageError) {
      process.stderr.write(
        `${error.message}\nRun with --help for usage.\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
