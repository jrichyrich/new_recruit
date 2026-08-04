import crypto from "node:crypto";

import { canonicalJson } from "../../lib/rosterpilot";
import {
  compareTesseraProviderParity,
  type TesseraProviderParityResult,
  type TesseraProviderParityRun,
} from "./provider-parity";

const SHA256 = /^[0-9a-f]{64}$/;

export type TesseraProviderParityContractBindingV2 = {
  scenarioPolicyContractV3Sha256: string;
  combatBridgeV3Sha256: string;
  corpusConformanceReportSha256: string;
  coveringSuiteSha256: string;
  coveringCaseId: string;
  coveringCaseEvidenceSha256: string;
  combatStateSha256: string;
  playerRosterFingerprint: string;
  opponentRosterFingerprint: string;
};

export type TesseraProviderParityRunV2 = TesseraProviderParityRun & {
  schemaVersion: 2;
  contractBinding: TesseraProviderParityContractBindingV2;
  exactReceiptSha256: string;
  providerStateEvidenceSha256: string;
};

export type TesseraProviderParityBindingIssueV2 = {
  code:
    | "PARITY_V2_BINDING_INVALID"
    | "PARITY_V2_BINDING_MISMATCH"
    | "PARITY_V2_PROVIDER_PAIR_INVALID";
  provider: "local-engine" | "website" | null;
  field: string | null;
  message: string;
};

export type TesseraProviderParityResultV2 = {
  schemaVersion: 2;
  kind: "tessera-provider-parity";
  outcome: TesseraProviderParityResult["outcome"];
  eligible: boolean;
  complete: boolean;
  contractBinding:
    TesseraProviderParityContractBindingV2 | null;
  bindingIssues: TesseraProviderParityBindingIssueV2[];
  comparison: TesseraProviderParityResult;
  resultSha256: string;
};

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function validateRun(
  run: TesseraProviderParityRunV2,
): TesseraProviderParityBindingIssueV2[] {
  const issues: TesseraProviderParityBindingIssueV2[] = [];
  const provider = run.identity.provider;
  if (run.schemaVersion !== 2) {
    issues.push({
      code: "PARITY_V2_BINDING_INVALID",
      provider,
      field: "schemaVersion",
      message: `${provider} parity evidence is not schema v2.`,
    });
  }
  for (const [field, value] of Object.entries({
    scenarioPolicyContractV3Sha256:
      run.contractBinding?.scenarioPolicyContractV3Sha256,
    combatBridgeV3Sha256:
      run.contractBinding?.combatBridgeV3Sha256,
    corpusConformanceReportSha256:
      run.contractBinding?.corpusConformanceReportSha256,
    coveringSuiteSha256:
      run.contractBinding?.coveringSuiteSha256,
    coveringCaseEvidenceSha256:
      run.contractBinding?.coveringCaseEvidenceSha256,
    combatStateSha256: run.contractBinding?.combatStateSha256,
    exactReceiptSha256: run.exactReceiptSha256,
    providerStateEvidenceSha256: run.providerStateEvidenceSha256,
  })) {
    if (typeof value !== "string" || !SHA256.test(value)) {
      issues.push({
        code: "PARITY_V2_BINDING_INVALID",
        provider,
        field,
        message: `${provider} parity evidence has no exact ${field}.`,
      });
    }
  }
  for (const [field, value] of Object.entries({
    coveringCaseId: run.contractBinding?.coveringCaseId,
    playerRosterFingerprint:
      run.contractBinding?.playerRosterFingerprint,
    opponentRosterFingerprint:
      run.contractBinding?.opponentRosterFingerprint,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      issues.push({
        code: "PARITY_V2_BINDING_INVALID",
        provider,
        field,
        message: `${provider} parity evidence has no ${field}.`,
      });
    }
  }
  return issues;
}

export function compareTesseraProviderParityV2(
  first: TesseraProviderParityRunV2,
  second: TesseraProviderParityRunV2,
): TesseraProviderParityResultV2 {
  const comparison = compareTesseraProviderParity(first, second);
  const issues = [...validateRun(first), ...validateRun(second)];
  const byProvider = new Map([
    [first.identity.provider, first],
    [second.identity.provider, second],
  ]);
  const local = byProvider.get("local-engine");
  const website = byProvider.get("website");
  if (
    byProvider.size !== 2 ||
    !local ||
    !website
  ) {
    issues.push({
      code: "PARITY_V2_PROVIDER_PAIR_INVALID",
      provider: null,
      field: null,
      message:
        "Provider parity v2 requires exactly one local-engine run and one website run.",
    });
  }
  const binding = local?.contractBinding ?? null;
  if (
    local &&
    website &&
    canonicalJson(local.contractBinding) !==
      canonicalJson(website.contractBinding)
  ) {
    for (const field of Object.keys(local.contractBinding).sort()) {
      if (
        canonicalJson(
          local.contractBinding[
            field as keyof TesseraProviderParityContractBindingV2
          ],
        ) !==
        canonicalJson(
          website.contractBinding[
            field as keyof TesseraProviderParityContractBindingV2
          ],
        )
      ) {
        issues.push({
          code: "PARITY_V2_BINDING_MISMATCH",
          provider: null,
          field,
          message: `Local and Web parity evidence disagree on ${field}.`,
        });
      }
    }
  }
  issues.sort((left, right) =>
    [left.code, left.field ?? "", left.provider ?? ""]
      .join("|")
      .localeCompare(
        [right.code, right.field ?? "", right.provider ?? ""].join("|"),
      ),
  );
  const eligible = comparison.eligible && issues.length === 0;
  const complete = comparison.complete && eligible;
  const outcome: TesseraProviderParityResultV2["outcome"] = !eligible
    ? "ineligible"
    : comparison.outcome;
  const core = {
    schemaVersion: 2 as const,
    kind: "tessera-provider-parity" as const,
    outcome,
    eligible,
    complete,
    contractBinding: issues.length === 0 ? binding : null,
    bindingIssues: issues,
    comparison,
  };
  return { ...core, resultSha256: digest(core) };
}

export function verifyTesseraProviderParityResultV2(
  result: TesseraProviderParityResultV2,
): boolean {
  const { resultSha256, ...core } = result;
  return SHA256.test(resultSha256) && digest(core) === resultSha256;
}
