import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CertificationReportSchema,
  type CertificationCaseResult,
  type CertificationReport,
  type CertificationResultStatus,
} from "../lib/rosterpilot/certification";
import type { ConnectorEvent } from "../lib/rosterpilot";

type Args = Record<string, string>;

type FactionResult = {
  generatedAt: string;
  status: string;
  tier: string;
  failures: number;
  unsupported: number;
  capabilities: TrendCapabilityStates;
};

type FactionLiveResult = {
  checkedAt: string;
  status: string;
  capabilities: TrendCapabilityStates;
};

const trendCapabilities = [
  "roster-correctness",
  "new-recruit-export",
  "new-recruit-delivery",
  "tessera-preparation",
  "tessera-simulation",
] as const;

type TrendCapability = (typeof trendCapabilities)[number];
type TrendCapabilityStatus =
  | CertificationResultStatus
  | "not-observed";
type TrendCapabilityStates = Record<
  TrendCapability,
  TrendCapabilityStatus
>;

type BrowserFailure = {
  code: string;
  count: number;
  lastSeenAt: string;
};

type RunConnectorSummary = {
  runId: string;
  generatedAt: string;
  tier: CertificationReport["tier"];
  mutationEvents: number;
  duplicateEventRecords: number;
  duplicateRemoteMutations: number;
  uncertainOutcomes: number;
  cacheReuses: number;
};

export type CertificationTrendSummary = {
  reportCount: number;
  passingCases: number;
  failedCases: number;
  degradedCases: number;
  unsupportedCases: number;
  skippedCases: number;
  applicableCases: number;
  latestBlockingConflicts: number;
  mappingConflictDeltaFromFirst: number;
  mappingConflictDeltaFromPrevious: number | null;
  uniqueConnectorEvents: number;
  remoteMutations: number;
  newRecruitMutations: number;
  tesseraMutations: number;
  persistentCacheReuses: number;
  manifestReuses: number;
  uncertainOutcomes: number;
  duplicateRemoteMutations: number;
  duplicateEventRecords: number;
  staleRuntimeReports: number;
  staleLocalAgentReports: number;
  staleRuntimeFailureCases: number;
  newRecruitUiIdentityChanges: number;
  newRecruitUiIdentitiesObserved: number;
  latestNewRecruitUiIdentity: string | null;
  tesseraUiIdentityChanges: number;
  tesseraUiIdentitiesObserved: number;
  latestTesseraUiIdentity: string | null;
  observableAttemptCount: number;
  retryOrPriorAttemptCount: number;
  scenarioRetryAttemptCount: number;
  priorAttemptCount: number;
  browserFailures: BrowserFailure[];
  runConnectorSummaries: RunConnectorSummary[];
  latestByFaction: Map<string, FactionResult>;
  latestLiveByFaction: Map<string, FactionLiveResult>;
  lastSuccessfulLiveByFaction: Map<string, string>;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (!key.startsWith("--") || !next || next.startsWith("--")) {
      throw new Error(
        `Expected paired options such as --input <directory> and --out <trend.md>; received "${key}".`,
      );
    }
    args[key.slice(2)] = next;
    index += 1;
  }
  return args;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function certificationReports(
  directory: string,
): Promise<CertificationReport[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const reports: CertificationReport[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^certification-report-.*\.json$/.test(entry.name)
    ) {
      continue;
    }
    const filename = path.join(entry.parentPath, entry.name);
    const checksumFilename = `${filename}.sha256`;
    let reportContent: Buffer;
    let checksumContent: string;
    try {
      [reportContent, checksumContent] = await Promise.all([
        readFile(filename),
        readFile(checksumFilename, "utf8"),
      ]);
    } catch (error) {
      throw new Error(
        `Certification trend rejected "${filename}": its detached checksum is missing or unreadable.`,
        { cause: error },
      );
    }
    const checksum = checksumContent.match(
      /^([0-9a-f]{64})  ([^/\\\r\n]+)\n$/,
    );
    if (!checksum || checksum[2] !== path.basename(filename)) {
      throw new Error(
        `Certification trend rejected "${filename}": its detached checksum is malformed or names a different report.`,
      );
    }
    const actualSha256 = crypto
      .createHash("sha256")
      .update(reportContent)
      .digest("hex");
    if (actualSha256 !== checksum[1]) {
      throw new Error(
        `Certification trend rejected "${filename}": its bytes do not match the detached checksum.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(reportContent.toString("utf8"));
    } catch (error) {
      throw new Error(
        `Certification trend rejected "${filename}": the hash-verified report is not valid JSON.`,
        { cause: error },
      );
    }
    const parsed = CertificationReportSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Certification trend rejected "${filename}": schema validation failed at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid report"}.`,
      );
    }
    reports.push(parsed.data);
  }
  return reports.sort(
    (left, right) =>
      timestamp(left.generatedAt) -
        timestamp(right.generatedAt) ||
      left.runId.localeCompare(right.runId),
  );
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0
    ? "n/a"
    : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function signed(value: number | null): string {
  if (value === null) return "n/a";
  return value > 0 ? `+${value}` : String(value);
}

function markdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function caseTimestamp(
  result: CertificationCaseResult,
  fallback: string,
): string {
  return timestamp(result.completedAt) > 0
    ? result.completedAt
    : fallback;
}

function latestTimestamp(values: string[]): string | null {
  return (
    values
      .filter((value) => timestamp(value) > 0)
      .sort((left, right) => timestamp(right) - timestamp(left))[0] ??
    null
  );
}

const liveWorkflows = new Set<
  CertificationCaseResult["workflow"]
>([
  "new-recruit-delivery",
  "tessera-preparation",
  "tessera-simulation",
]);

function isLiveCheckCase(
  result: CertificationCaseResult,
): boolean {
  return (
    liveWorkflows.has(result.workflow) &&
    /:live-(?:new-recruit|tessera|build|capability-boundary)$/.test(
      result.caseId,
    )
  );
}

function latestFactionStatus(
  cases: CertificationCaseResult[],
): string {
  if (cases.some((result) => result.status === "fail")) {
    return "fail";
  }
  if (cases.some((result) => result.status === "degraded")) {
    return "degraded";
  }
  if (cases.some((result) => result.status === "unsupported")) {
    return "capability-boundary";
  }
  if (cases.some((result) => result.status === "pass")) {
    return "pass";
  }
  return "skipped";
}

function capabilityStatus(
  cases: CertificationCaseResult[],
): TrendCapabilityStatus {
  if (cases.length === 0) return "not-observed";
  if (cases.some((result) => result.status === "fail")) {
    return "fail";
  }
  if (cases.some((result) => result.status === "degraded")) {
    return "degraded";
  }
  if (cases.some((result) => result.status === "unsupported")) {
    return "unsupported";
  }
  if (cases.some((result) => result.status === "pass")) {
    return "pass";
  }
  return "skipped";
}

function capabilityStates(
  cases: CertificationCaseResult[],
): TrendCapabilityStates {
  return Object.fromEntries(
    trendCapabilities.map((capability) => [
      capability,
      capabilityStatus(
        cases.filter(
          (result) => result.workflow === capability,
        ),
      ),
    ]),
  ) as TrendCapabilityStates;
}

function allCapabilitiesPassed(
  capabilities: TrendCapabilityStates,
): boolean {
  return trendCapabilities.every(
    (capability) => capabilities[capability] === "pass",
  );
}

function remoteMutationEvents(
  events: ConnectorEvent[],
): ConnectorEvent[] {
  return events.filter(
    (event) =>
      event.action === "prepare" &&
      event.origin === "new-remote",
  );
}

function cacheReuseEvents(
  events: ConnectorEvent[],
): ConnectorEvent[] {
  return events.filter(
    (event) =>
      event.action === "prepare" &&
      (event.origin === "persistent-cache" ||
        event.origin === "manifest-reuse") &&
      event.outcome === "reused",
  );
}

function mutationIdentity(event: ConnectorEvent): string {
  if (event.remoteId) {
    return `${event.provider}|${event.action}|remote:${event.remoteId}`;
  }
  if (event.contentSha256) {
    return `${event.provider}|${event.action}|content:${event.contentSha256}`;
  }
  return `${event.provider}|${event.action}|event:${event.eventId}`;
}

function runConnectorSummary(
  report: CertificationReport,
): RunConnectorSummary {
  const mutationEvents = remoteMutationEvents(
    report.connectorEvents,
  );
  const uniqueEventIds = new Set(
    report.connectorEvents.map((event) => event.eventId),
  );
  const uniqueMutationEvents = [
    ...new Map(
      mutationEvents.map((event) => [event.eventId, event]),
    ).values(),
  ];
  const mutationIdentities = new Map<string, number>();
  for (const event of uniqueMutationEvents) {
    const identity = mutationIdentity(event);
    mutationIdentities.set(
      identity,
      (mutationIdentities.get(identity) ?? 0) + 1,
    );
  }
  return {
    runId: report.runId,
    generatedAt: report.generatedAt,
    tier: report.tier,
    mutationEvents: uniqueMutationEvents.length,
    duplicateEventRecords:
      report.connectorEvents.length - uniqueEventIds.size,
    duplicateRemoteMutations: [...mutationIdentities.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    uncertainOutcomes: [
      ...new Map(
        report.connectorEvents.map((event) => [
          event.eventId,
          event,
        ]),
      ).values(),
    ].filter((event) => event.outcome === "uncertain").length,
    cacheReuses: [
      ...new Map(
        cacheReuseEvents(report.connectorEvents).map((event) => [
          event.eventId,
          event,
        ]),
      ).values(),
    ].length,
  };
}

function objectArray(
  value: unknown,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
}

function browserRelatedCode(
  result: CertificationCaseResult,
  code: string,
): boolean {
  return (
    result.workflow === "browser-fixture" ||
    result.workflow === "tessera-simulation" ||
    result.workflow === "tessera-preparation" ||
    /(?:BROWSER|TESSERA|SELECTOR|HYDRAT|STALE_MATRIX|UI_CHANGED|LIST_SELECTION|MATRIX)/i.test(
      code,
    )
  );
}

export function summarizeCertificationTrend(
  reports: CertificationReport[],
): CertificationTrendSummary {
  if (reports.length === 0) {
    throw new Error("At least one certification report is required.");
  }
  const sortedReports = [...reports].sort(
    (left, right) =>
      timestamp(left.generatedAt) -
        timestamp(right.generatedAt) ||
      left.runId.localeCompare(right.runId),
  );
  const latestByFaction = new Map<string, FactionResult>();
  const latestLiveByFaction = new Map<
    string,
    FactionLiveResult
  >();
  const lastSuccessfulLiveByFaction = new Map<
    string,
    string
  >();
  const browserFailureCounts = new Map<
    string,
    { count: number; lastSeenAt: string }
  >();
  let scenarioAttemptCount = 0;
  let scenarioRetryAttemptCount = 0;
  let priorAttemptCount = 0;

  const recordBrowserFailure = (
    code: string,
    observedAt: string,
  ) => {
    const current = browserFailureCounts.get(code);
    browserFailureCounts.set(code, {
      count: (current?.count ?? 0) + 1,
      lastSeenAt:
        !current ||
        timestamp(observedAt) >= timestamp(current.lastSeenAt)
          ? observedAt
          : current.lastSeenAt,
    });
  };

  for (const report of sortedReports) {
    const factionIds = new Set([
      ...report.selection.selectedFactionIds,
      ...report.cases
        .map((result) => result.factionId)
        .filter((value): value is string => value !== null),
    ]);
    for (const factionId of factionIds) {
      const cases = report.cases.filter(
        (result) => result.factionId === factionId,
      );
      const capabilities = capabilityStates(cases);
      latestByFaction.set(factionId, {
        generatedAt: report.generatedAt,
        status: latestFactionStatus(cases),
        tier: report.tier,
        failures: cases.filter(
          (result) => result.status === "fail",
        ).length,
        unsupported: cases.filter(
          (result) => result.status === "unsupported",
        ).length,
        capabilities,
      });

      if (report.tier !== "live") continue;
      const liveCases = cases.filter(isLiveCheckCase);
      if (liveCases.length === 0) continue;
      const checkedAt =
        latestTimestamp(
          liveCases.map((result) =>
            caseTimestamp(result, report.generatedAt),
          ),
        ) ?? report.generatedAt;
      const previousLive = latestLiveByFaction.get(factionId);
      if (
        !previousLive ||
        timestamp(checkedAt) >= timestamp(previousLive.checkedAt)
      ) {
        latestLiveByFaction.set(factionId, {
          checkedAt,
          status: latestFactionStatus(liveCases),
          capabilities,
        });
      }
      const successful =
        allCapabilitiesPassed(capabilities) &&
        !cases.some((result) =>
          ["fail", "degraded", "unsupported"].includes(
            result.status,
          ),
        );
      if (successful) {
        const successfulAt =
          latestTimestamp(
            liveCases
              .filter((result) => result.status === "pass")
              .map((result) =>
                caseTimestamp(result, report.generatedAt),
              ),
          ) ?? checkedAt;
        const previousSuccess =
          lastSuccessfulLiveByFaction.get(factionId);
        if (
          !previousSuccess ||
          timestamp(successfulAt) >= timestamp(previousSuccess)
        ) {
          lastSuccessfulLiveByFaction.set(
            factionId,
            successfulAt,
          );
        }
      }
    }

    for (const result of report.cases) {
      if (
        result.code &&
        result.status !== "pass" &&
        browserRelatedCode(result, result.code)
      ) {
        recordBrowserFailure(
          result.code,
          caseTimestamp(result, report.generatedAt),
        );
      }
      const scenarioAttempts = objectArray(
        result.evidence.scenarioAttempts,
      );
      if (scenarioAttempts) {
        scenarioAttemptCount += scenarioAttempts.length;
        for (const attempt of scenarioAttempts) {
          if (
            typeof attempt.attempt === "number" &&
            attempt.attempt > 1
          ) {
            scenarioRetryAttemptCount += 1;
          }
          if (
            attempt.status === "failed" &&
            typeof attempt.code === "string"
          ) {
            recordBrowserFailure(
              attempt.code,
              caseTimestamp(result, report.generatedAt),
            );
          }
        }
      }
      const priorAttempts = objectArray(
        result.evidence.priorAttempts,
      );
      if (priorAttempts) {
        priorAttemptCount += priorAttempts.length;
        for (const attempt of priorAttempts) {
          if (
            typeof attempt.code === "string" &&
            browserRelatedCode(result, attempt.code)
          ) {
            recordBrowserFailure(
              attempt.code,
              caseTimestamp(result, report.generatedAt),
            );
          }
        }
      }
    }
  }

  const allCases = sortedReports.flatMap(
    (report) => report.cases,
  );
  const uniqueEvents = [
    ...new Map(
      sortedReports
        .flatMap((report) => report.connectorEvents)
        .map((event) => [event.eventId, event]),
    ).values(),
  ];
  const remoteMutations = remoteMutationEvents(uniqueEvents);
  const runConnectorSummaries = sortedReports.map(
    runConnectorSummary,
  );
  const mappingValues = sortedReports.map(
    (report) => report.baselines.actualBlockingConflicts,
  );
  const latestBlockingConflicts =
    mappingValues.at(-1) ?? 0;
  const liveUiIdentities = sortedReports
    .filter((report) => report.tier === "live")
    .map((report) => report.provenance.tesseraUi.identity)
    .filter((identity): identity is string =>
      Boolean(identity?.trim()),
    );
  const identitySequence = liveUiIdentities.filter(
    (identity, index) =>
      index === 0 || identity !== liveUiIdentities[index - 1],
  );
  const liveNewRecruitUiIdentities = sortedReports
    .filter((report) => report.tier === "live")
    .map(
      (report) =>
        report.provenance.newRecruitUi?.identity ?? null,
    )
    .filter((identity): identity is string =>
      Boolean(identity?.trim()),
    );
  const newRecruitIdentitySequence =
    liveNewRecruitUiIdentities.filter(
      (identity, index) =>
        index === 0 ||
        identity !== liveNewRecruitUiIdentities[index - 1],
    );

  return {
    reportCount: sortedReports.length,
    passingCases: allCases.filter(
      (result) => result.status === "pass",
    ).length,
    failedCases: allCases.filter(
      (result) => result.status === "fail",
    ).length,
    degradedCases: allCases.filter(
      (result) => result.status === "degraded",
    ).length,
    unsupportedCases: allCases.filter(
      (result) => result.status === "unsupported",
    ).length,
    skippedCases: allCases.filter(
      (result) => result.status === "skipped",
    ).length,
    applicableCases: allCases.filter(
      (result) => result.status !== "skipped",
    ).length,
    latestBlockingConflicts,
    mappingConflictDeltaFromFirst:
      latestBlockingConflicts - (mappingValues[0] ?? 0),
    mappingConflictDeltaFromPrevious:
      mappingValues.length > 1
        ? latestBlockingConflicts -
          mappingValues[mappingValues.length - 2]
        : null,
    uniqueConnectorEvents: uniqueEvents.length,
    remoteMutations: remoteMutations.length,
    newRecruitMutations: remoteMutations.filter(
      (event) => event.provider === "new-recruit",
    ).length,
    tesseraMutations: remoteMutations.filter(
      (event) => event.provider === "tessera",
    ).length,
    persistentCacheReuses: uniqueEvents.filter(
      (event) =>
        event.action === "prepare" &&
        event.origin === "persistent-cache" &&
        event.outcome === "reused",
    ).length,
    manifestReuses: uniqueEvents.filter(
      (event) =>
        event.action === "prepare" &&
        event.origin === "manifest-reuse" &&
        event.outcome === "reused",
    ).length,
    uncertainOutcomes: uniqueEvents.filter(
      (event) => event.outcome === "uncertain",
    ).length,
    duplicateRemoteMutations: runConnectorSummaries.reduce(
      (total, run) => total + run.duplicateRemoteMutations,
      0,
    ),
    duplicateEventRecords: runConnectorSummaries.reduce(
      (total, run) => total + run.duplicateEventRecords,
      0,
    ),
    staleRuntimeReports: sortedReports.filter(
      (report) => report.provenance.runtime?.stale === true,
    ).length,
    staleLocalAgentReports: sortedReports.filter(
      (report) =>
        (report.provenance.localAgent.runtime?.stale ??
          report.provenance.localAgent.stale) === true,
    ).length,
    staleRuntimeFailureCases: allCases.filter(
      (result) => result.code === "RUNTIME_RESTART_REQUIRED",
    ).length,
    newRecruitUiIdentityChanges: Math.max(
      0,
      newRecruitIdentitySequence.length - 1,
    ),
    newRecruitUiIdentitiesObserved: new Set(
      liveNewRecruitUiIdentities,
    ).size,
    latestNewRecruitUiIdentity:
      liveNewRecruitUiIdentities.at(-1) ?? null,
    tesseraUiIdentityChanges: Math.max(
      0,
      identitySequence.length - 1,
    ),
    tesseraUiIdentitiesObserved: new Set(liveUiIdentities).size,
    latestTesseraUiIdentity:
      liveUiIdentities.at(-1) ?? null,
    observableAttemptCount:
      scenarioAttemptCount + priorAttemptCount,
    retryOrPriorAttemptCount:
      scenarioRetryAttemptCount + priorAttemptCount,
    scenarioRetryAttemptCount,
    priorAttemptCount,
    browserFailures: [...browserFailureCounts]
      .map(([code, value]) => ({ code, ...value }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.code.localeCompare(right.code),
      ),
    runConnectorSummaries,
    latestByFaction,
    latestLiveByFaction,
    lastSuccessfulLiveByFaction,
  };
}

function ageSince(
  date: string | null,
  now: Date,
): string {
  if (!date) return "never";
  const elapsed = Math.max(0, now.getTime() - timestamp(date));
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function shortIdentity(identity: string | null): string {
  if (!identity) return "unavailable";
  return markdown(
    identity.length > 24
      ? `${identity.slice(0, 24)}…`
      : identity,
  );
}

export function renderCertificationTrend(
  reports: CertificationReport[],
  now = new Date(),
): {
  markdown: string;
  summary: CertificationTrendSummary;
} {
  const summary = summarizeCertificationTrend(reports);
  const factionIds = [
    ...new Set([
      ...summary.latestByFaction.keys(),
      ...summary.latestLiveByFaction.keys(),
      ...summary.lastSuccessfulLiveByFaction.keys(),
    ]),
  ].sort();
  const lines = [
    "# RosterPilot certification trend",
    "",
    `Generated: ${now.toISOString()}`,
    "",
    "## Summary",
    "",
    `- Reports: ${summary.reportCount}`,
    `- Case pass rate: ${percent(summary.passingCases, summary.applicableCases)} (${summary.passingCases}/${summary.applicableCases} non-skipped outcomes)`,
    `- Failed cases: ${summary.failedCases}`,
    `- Degraded cases: ${summary.degradedCases}`,
    `- Unsupported capability cases: ${summary.unsupportedCases}`,
    `- Skipped cases: ${summary.skippedCases}`,
    `- Latest blocking mapping conflicts: ${summary.latestBlockingConflicts}`,
    `- Mapping-conflict delta from first input: ${signed(summary.mappingConflictDeltaFromFirst)}`,
    `- Mapping-conflict delta from previous input: ${signed(summary.mappingConflictDeltaFromPrevious)}`,
    `- Unique connector events: ${summary.uniqueConnectorEvents}`,
    `- Verified or attempted remote preparation mutations: ${summary.remoteMutations} (New Recruit ${summary.newRecruitMutations}; Tessera ${summary.tesseraMutations})`,
    `- Persistent-cache reuses: ${summary.persistentCacheReuses}`,
    `- Manifest reuses: ${summary.manifestReuses}`,
    `- Uncertain external outcomes: ${summary.uncertainOutcomes}`,
    `- Per-run duplicate remote mutations: ${summary.duplicateRemoteMutations}`,
    `- Duplicate connector event records: ${summary.duplicateEventRecords}`,
    `- Stale runtime reports: ${summary.staleRuntimeReports}`,
    `- Stale local-agent reports: ${summary.staleLocalAgentReports}`,
    `- Runtime restart failure cases: ${summary.staleRuntimeFailureCases}`,
    `- New Recruit UI identity changes: ${summary.newRecruitUiIdentityChanges} across ${summary.newRecruitUiIdentitiesObserved} observed identities`,
    `- Latest New Recruit UI identity: ${shortIdentity(summary.latestNewRecruitUiIdentity)}`,
    `- Tessera UI identity changes: ${summary.tesseraUiIdentityChanges} across ${summary.tesseraUiIdentitiesObserved} observed identities`,
    `- Latest Tessera UI identity: ${shortIdentity(summary.latestTesseraUiIdentity)}`,
    `- Retry/prior-attempt rate: ${percent(summary.retryOrPriorAttemptCount, summary.observableAttemptCount)} (${summary.retryOrPriorAttemptCount}/${summary.observableAttemptCount} observable attempt records)`,
    `- Scenario retry attempts: ${summary.scenarioRetryAttemptCount}`,
    `- Preserved prior attempts: ${summary.priorAttemptCount}`,
    "",
    "Connector totals use unique durable event IDs across reports. Per-run duplicate checks are evaluated before cross-report deduplication.",
    "",
    "## Faction recency",
    "",
    "| Faction | Latest result | Tier | Latest report | Last successful live check | Time since successful live check | Latest live outcome |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...factionIds.map((factionId) => {
      const latest = summary.latestByFaction.get(factionId);
      const latestLive =
        summary.latestLiveByFaction.get(factionId);
      const successfulLive =
        summary.lastSuccessfulLiveByFaction.get(factionId) ?? null;
      return `| ${markdown(factionId)} | ${latest?.status ?? "unavailable"} | ${latest?.tier ?? "n/a"} | ${latest?.generatedAt ?? "n/a"} | ${successfulLive ?? "never"} | ${ageSince(successfulLive, now)} | ${latestLive ? `${latestLive.status} (${latestLive.checkedAt})` : "never"} |`;
    }),
    "",
    "A later deterministic or connector report never advances a faction's live timestamp. Preserved live cases use their original completion time.",
    "",
    "## Five-capability state",
    "",
    "| Faction | Roster correctness | New Recruit export | New Recruit delivery | Tessera preparation | Trusted Tessera simulation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...factionIds.map((factionId) => {
      const capabilities =
        summary.latestByFaction.get(factionId)?.capabilities;
      return `| ${markdown(factionId)} | ${capabilities?.["roster-correctness"] ?? "not-observed"} | ${capabilities?.["new-recruit-export"] ?? "not-observed"} | ${capabilities?.["new-recruit-delivery"] ?? "not-observed"} | ${capabilities?.["tessera-preparation"] ?? "not-observed"} | ${capabilities?.["tessera-simulation"] ?? "not-observed"} |`;
    }),
    "",
    "A mixed pass/unsupported result is a capability boundary, not a successful live check. Live recency advances only when all five capabilities pass.",
    "",
    "## Browser and Tessera failure codes",
    "",
    "| Failure code | Observations | Last seen |",
    "| --- | ---: | --- |",
    ...(summary.browserFailures.length > 0
      ? summary.browserFailures.map(
          (failure) =>
            `| ${markdown(failure.code)} | ${failure.count} | ${failure.lastSeenAt} |`,
        )
      : ["| none | 0 | n/a |"]),
    "",
    "## Connector activity by run",
    "",
    "| Run | Generated | Tier | Remote mutations | Duplicate event records | Duplicate remote mutations | Uncertain outcomes | Cache/manifest reuses |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.runConnectorSummaries.map(
      (run) =>
        `| ${markdown(run.runId)} | ${run.generatedAt} | ${run.tier} | ${run.mutationEvents} | ${run.duplicateEventRecords} | ${run.duplicateRemoteMutations} | ${run.uncertainOutcomes} | ${run.cacheReuses} |`,
    ),
    "",
    "Expected upstream capability boundaries are not counted as product failures. An uncertain external outcome, duplicate remote mutation, stale runtime, or stale local agent is a release blocker.",
    "",
  ];
  return {
    markdown: lines.join("\n"),
    summary,
  };
}

export async function runCertificationTrend(
  argv: string[],
): Promise<{
  outputPath: string;
  summary: CertificationTrendSummary;
}> {
  const args = parseArgs(argv);
  const inputDirectory = path.resolve(
    args.input ?? ".certification",
  );
  const outputPath = path.resolve(
    args.out ??
      path.join(inputDirectory, "certification-trend.md"),
  );
  const reports = await certificationReports(inputDirectory);
  if (reports.length === 0) {
    throw new Error(
      `No certification reports were found under ${inputDirectory}.`,
    );
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Invalid --now timestamp "${args.now}".`);
  }
  const rendered = renderCertificationTrend(reports, now);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered.markdown, {
    flag: "w",
  });
  return {
    outputPath,
    summary: rendered.summary,
  };
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCertificationTrend(
      process.argv.slice(2),
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        outputPath: result.outputPath,
        reports: result.summary.reportCount,
        factions: result.summary.latestByFaction.size,
        failedCases: result.summary.failedCases,
        uncertainOutcomes:
          result.summary.uncertainOutcomes,
        duplicateRemoteMutations:
          result.summary.duplicateRemoteMutations,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
