import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ProfilePolicyV1,
  TesseraFrozenScenarioContract,
  TesseraPreparedRoster,
} from "../../lib/rosterpilot";
import {
  normalizeProfileIdentity,
} from "./profile-policy";
import {
  deterministicTesseraSavedListName,
  scopedTesseraProfilePolicySha256,
  tesseraProfilePolicyForEntryKeys,
  tesseraSavedListReuseValidationError,
  type TesseraSavedListReuse,
  type TesseraSavedListReuseAction,
} from "./saved-list-reuse";

export const TESSERA_URL = "https://playtessera.gg/" as const;

export const TESSERA_PHASES = ["shooting", "fight"] as const;
export type TesseraPhase = (typeof TESSERA_PHASES)[number];

export const TESSERA_METRICS = [
  "wipe-probability",
  "half-wipe-probability",
  "mean-kills",
  "mean-damage",
] as const;
export type TesseraMetric = (typeof TESSERA_METRICS)[number];

export const TESSERA_DIRECTIONS = [
  "player-to-opponent",
  "opponent-to-player",
] as const;
export type TesseraDirection = (typeof TESSERA_DIRECTIONS)[number];

export type TesseraAnalysisMode = "quick" | "full";

export class TesseraAutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function classifyTesseraAutomationFailure(error: unknown): {
  code: string;
  message: string;
} {
  const message =
    error instanceof Error ? error.message : "Tessera companion failed.";
  if (error instanceof TesseraAutomationError) {
    return { code: error.code, message };
  }
  if (!(error instanceof Error)) {
    return { code: "TESSERA_COMPANION_FAILED", message };
  }
  if (
    error.name === "TimeoutError" ||
    /timeout\b.*(?:exceeded|waiting|after \d+)/i.test(message)
  ) {
    return { code: "TESSERA_BROWSER_TIMEOUT", message };
  }
  if (
    /target (?:page|context|browser).*closed|target closed|browser has (?:been )?disconnected|connection closed/i.test(
      message,
    )
  ) {
    return { code: "TESSERA_BROWSER_SESSION_CLOSED", message };
  }
  if (
    /executable doesn't exist|failed to launch|cannot find (?:chrome|chromium)|browserType\.launchPersistentContext/i.test(
      message,
    )
  ) {
    return { code: "TESSERA_BROWSER_UNAVAILABLE", message };
  }
  if (/enoent|no such file|does not exist/i.test(message)) {
    return { code: "TESSERA_ROSTER_FILE_MISSING", message };
  }
  if (
    /page\.goto|net::err_|navigation failed|cannot navigate/i.test(message)
  ) {
    return { code: "TESSERA_BROWSER_NAVIGATION_FAILED", message };
  }
  return { code: "TESSERA_COMPANION_FAILED", message };
}

export function invalidatesCachedTesseraLicenseKey(code: string): boolean {
  return (
    code === "TESSERA_PREMIUM_KEY_REJECTED" ||
    code === "TESSERA_PREMIUM_KEY_ABSENT" ||
    code === "AUTHENTICATION_CANCELLED" ||
    code.startsWith("KEYCHAIN_") ||
    code.startsWith("CREDENTIAL_")
  );
}

export type TesseraMatrixCell = {
  attacker: string;
  target: string;
  direction?: TesseraDirection;
  killProbability: number | null;
  expectedDamage: number | null;
  damagePer100Points: number | null;
};

export type TesseraScenarioCell = TesseraMatrixCell & {
  attackerIndex: number;
  targetIndex: number;
  attackerOccurrence: number;
  targetOccurrence: number;
  metricValue: number;
  seed?: number;
  executionSha256?: string;
};

export type TesseraScenario = {
  id: string;
  phase: TesseraPhase;
  direction: TesseraDirection;
  metric: TesseraMetric;
  settings: Record<string, string>;
  iterations: number | null;
  seed?: number;
  executionSha256?: string;
  projectionSha256?: string;
  cells: TesseraScenarioCell[];
  matrixSha256?: string;
  integrity?: {
    status: "trusted" | "aliased";
    issueCodes: TesseraMatrixIntegrityCode[];
    aliasedScenarioIds: string[];
  };
};

export type TesseraMatrixIntegrityCode =
  | "TESSERA_PHASE_MATRIX_ALIAS"
  | "TESSERA_METRIC_MATRIX_ALIAS";

export type TesseraMatrixIntegrityIssue = {
  code: TesseraMatrixIntegrityCode;
  scenarioIds: string[];
  matrixSha256: string;
  message: string;
};

export type TesseraScenarioCaptureAttempt = {
  scenarioId: string;
  attempt: number;
  status: "success" | "failed";
  code: string | null;
  message: string | null;
  retryable: boolean;
  willRetry: boolean;
};

export type TesseraImportWarnings = {
  player: string[];
  opponent: string[];
};

export type TesseraImportIssue = {
  code: "alternate-profile" | "unverified-import" | "import-warning";
  side: "player" | "opponent";
  unit: string | null;
  weaponGroup: string | null;
  availableProfiles: string[];
  phase: TesseraPhase | null;
  message: string;
  resolvedByPolicy: boolean;
  selectedProfile?: string | null;
};

export type TesseraBrowserResult = {
  uiIdentity?: string | null;
  legacyProjection?: {
    status: "derived" | "unavailable";
    phase: TesseraPhase | null;
    metric: TesseraMetric | null;
    scenarioIds: string[];
  };
  settings: Record<string, string>;
  cells: TesseraMatrixCell[];
  scenarios: TesseraScenario[];
  importWarnings: TesseraImportWarnings;
  importIssues?: TesseraImportIssue[];
  integrityIssues?: TesseraMatrixIntegrityIssue[];
  scenarioAttempts?: TesseraScenarioCaptureAttempt[];
  savedListReuse?: {
    mode: "deterministic";
    player: TesseraSavedListReuseAction;
    opponent: TesseraSavedListReuseAction;
  };
  warnings: string[];
};

async function tesseraUiIdentity(page: Page): Promise<string | null> {
  try {
    const scripts = await page
      .locator("script[src]")
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute("src") ?? "")
          .filter(Boolean)
          .sort(),
      );
    const declaredVersion = await page
      .locator('meta[name="version"], meta[name="app-version"]')
      .first()
      .getAttribute("content")
      .catch(() => null);
    return createHash("sha256")
      .update(
        JSON.stringify({
          origin: new URL(page.url()).origin,
          declaredVersion,
          scripts,
        }),
      )
      .digest("hex");
  } catch {
    return null;
  }
}

export type TesseraBrowserInput = {
  profileDirectory: string;
  playerRoszPath: string;
  playerName: string;
  opponentRoszPath: string;
  opponentName: string;
  /** Explicit immutable inputs for non-website providers. */
  playerSimulationInput?: TesseraPreparedRoster["simulationInput"];
  opponentSimulationInput?: TesseraPreparedRoster["simulationInput"];
  licenseKey?: string;
  analysisMode?: TesseraAnalysisMode;
  phases?: readonly TesseraPhase[];
  metrics?: readonly TesseraMetric[];
  profilePolicy?: ProfilePolicyV1 | null;
  frozenScenarioContract?: TesseraFrozenScenarioContract[] | null;
  savedListReuse?: TesseraSavedListReuse | null;
  sessionId?: string;
};

export type TesseraBrowserDependencies = {
  baseUrl?: string;
  headless?: boolean;
  prepareContext?: (context: BrowserContext) => Promise<void>;
  timeoutMs?: number;
  context?: BrowserContext;
  keepContextOpen?: boolean;
  onContext?: (context: BrowserContext) => void;
};

type PreparedSavedListReuse = {
  player: {
    name: string;
    expectedUnitCount: number;
    contentSha256: string;
  };
  opponent: {
    name: string;
    expectedUnitCount: number;
    contentSha256: string;
  };
};

async function prepareSavedListReuse(
  input: TesseraBrowserInput,
): Promise<PreparedSavedListReuse | null> {
  const reuse = input.savedListReuse;
  if (!reuse) return null;
  if (reuse.schemaVersion !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_SAVED_LIST_REUSE_INVALID",
      "The Tessera saved-list reuse contract has an unsupported schema version.",
    );
  }
  for (const [side, identity, filename] of [
    ["player", reuse.player, input.playerRoszPath],
    ["opponent", reuse.opponent, input.opponentRoszPath],
  ] as const) {
    const validationError =
      tesseraSavedListReuseValidationError(identity);
    if (validationError) {
      throw new TesseraAutomationError(
        "TESSERA_SAVED_LIST_REUSE_INVALID",
        `The ${side} Tessera saved-list reuse identity is invalid: ${validationError}.`,
      );
    }
    let content: Buffer;
    try {
      content = await readFile(filename);
    } catch {
      throw new TesseraAutomationError(
        "TESSERA_ROSTER_FILE_MISSING",
        `The ${side} roster archive could not be read before saved-list reuse preflight.`,
      );
    }
    const observedSha256 = createHash("sha256")
      .update(content)
      .digest("hex");
    if (
      observedSha256 !==
      identity.enrichedRoszSha256.toLocaleLowerCase()
    ) {
      throw new TesseraAutomationError(
        "TESSERA_SAVED_LIST_REUSE_INVALID",
        `The ${side} roster archive does not match its saved-list reuse content hash.`,
      );
    }
  }
  for (const [side, identity] of [
    ["player", reuse.player],
    ["opponent", reuse.opponent],
  ] as const) {
    const scopedPolicy = tesseraProfilePolicyForEntryKeys(
      input.profilePolicy,
      identity.profilePolicyEntryKeys,
    );
    if (
      identity.profilePolicyEntryKeys.length > 0 &&
      !scopedPolicy
    ) {
      throw new TesseraAutomationError(
        "TESSERA_SAVED_LIST_REUSE_INVALID",
        `The ${side} saved-list identity refers to Tessera profile-policy entries that are not present.`,
      );
    }
    const observedPolicySha256 =
      scopedTesseraProfilePolicySha256(scopedPolicy);
    if (
      observedPolicySha256 !==
      identity.scopedProfilePolicySha256.toLocaleLowerCase()
    ) {
      throw new TesseraAutomationError(
        "TESSERA_SAVED_LIST_REUSE_INVALID",
        `The ${side} saved-list identity does not match the scoped Tessera profile policy.`,
      );
    }
  }
  return {
    player: {
      name: deterministicTesseraSavedListName(
        "player",
        reuse.player,
      ),
      expectedUnitCount: reuse.player.expectedUnitCount,
      contentSha256:
        reuse.player.enrichedRoszSha256.toLocaleLowerCase(),
    },
    opponent: {
      name: deterministicTesseraSavedListName(
        "opponent",
        reuse.opponent,
      ),
      expectedUnitCount: reuse.opponent.expectedUnitCount,
      contentSha256:
        reuse.opponent.enrichedRoszSha256.toLocaleLowerCase(),
    },
  };
}

function numberFrom(
  value: string,
  pattern: RegExp,
  divisor = 1,
): number | null {
  const match = value.match(pattern);
  return match ? Number(match[1]) / divisor : null;
}

export function parseTesseraMatrixTable(
  rows: string[][],
): TesseraMatrixCell[] {
  if (rows.length < 2 || rows[0].length < 2) return [];
  const targets = rows[0].slice(1);
  const cells: TesseraMatrixCell[] = [];
  for (const row of rows.slice(1)) {
    const attacker = row[0]?.trim();
    if (!attacker) continue;
    row.slice(1).forEach((text, index) => {
      const target = targets[index]?.trim();
      if (!target) return;
      const killProbability = numberFrom(
        text,
        /(?:kill|destroy)?\s*(\d+(?:\.\d+)?)\s*%/i,
        100,
      );
      const expectedDamage = numberFrom(
        text,
        /(\d+(?:\.\d+)?)\s*(?:damage|dmg)\b/i,
      );
      const damagePer100Points = numberFrom(
        text,
        /(\d+(?:\.\d+)?)\s*(?:damage|dmg)?\s*(?:\/|per)\s*100/i,
      );
      if (
        killProbability !== null ||
        expectedDamage !== null ||
        damagePer100Points !== null
      ) {
        cells.push({
          attacker,
          target,
          killProbability,
          expectedDamage,
          damagePer100Points,
        });
      }
    });
  }
  return cells;
}

function structuredImportIssues(
  side: TesseraImportIssue["side"],
  warnings: string[],
): TesseraImportIssue[] {
  return warnings.map((message) => {
    const alternate = /alternate profile|multiple profiles|choose.*profile/i.test(
      message,
    );
    const quoted = [...message.matchAll(/["“]([^"”]+)["”]/g)].map(
      (match) => match[1],
    );
    const unit =
      message.match(/\b(?:for|on|unit)\b\s+["“]?([^"”,:;]+)["”]?/i)?.[1]?.trim() ??
      null;
    const availableText =
      message.match(/(?:profiles?|choose)\s*[:=]\s*([^.;]+)/i)?.[1] ?? "";
    const availableProfiles = availableText
      .split(/\s*(?:,|\bor\b|\|)\s*/i)
      .map((value) => value.replace(/^["“]|["”]$/g, "").trim())
      .filter(Boolean);
    return {
      code: alternate
        ? "alternate-profile"
        : /unverified/i.test(message)
          ? "unverified-import"
          : "import-warning",
      side,
      unit,
      weaponGroup: quoted[0] ?? null,
      availableProfiles,
      phase: /melee|fight/i.test(message)
        ? "fight"
        : /ranged|shoot/i.test(message)
          ? "shooting"
          : null,
      message,
      resolvedByPolicy: false,
      selectedProfile: null,
    };
  });
}

function normalized(value: string): string {
  return normalizeProfileIdentity(value);
}

function importedWeaponGroupMatches(
  importedWeaponGroup: string,
  policyWeaponGroup: string,
): boolean {
  const imported = normalized(importedWeaponGroup);
  const policy = normalized(policyWeaponGroup);
  return (
    imported === policy ||
    imported.startsWith(`${policy} - `) ||
    imported.startsWith(`${policy} – `) ||
    imported.startsWith(`${policy} — `) ||
    imported.startsWith(`${policy}: `)
  );
}

function importedWeaponProfile(
  importedWeaponGroup: string,
  policyWeaponGroup: string,
): string | null {
  if (!importedWeaponGroupMatches(importedWeaponGroup, policyWeaponGroup)) {
    return null;
  }
  const delimiter = importedWeaponGroup.match(/\s+(?:-|–|—|:)\s+/);
  if (!delimiter?.index) return null;
  const base = importedWeaponGroup.slice(0, delimiter.index);
  if (normalized(base) !== normalized(policyWeaponGroup)) return null;
  return importedWeaponGroup
    .slice(delimiter.index + delimiter[0].length)
    .trim();
}

async function profileCountControl(weaponName: Locator): Promise<Locator | null> {
  let container = weaponName.locator("xpath=..");
  for (let depth = 0; depth < 4; depth += 1) {
    const controls = container.locator(
      'input[aria-label="Count" i], input[name="count" i], input[type="number"]',
    );
    if ((await controls.count()) === 1) return controls.first();
    container = container.locator("xpath=..");
  }
  return null;
}

function importedUnitModelCount(text: string): number | null {
  for (const pattern of [
    /\b(\d+)\s*(?:models?|miniatures?)\b/i,
    /\b(?:model count|unit size)\s*:?\s*(\d+)\b/i,
    /(?:×|x)\s*(\d+)\b/i,
  ]) {
    const value = Number(text.match(pattern)?.[1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

async function importedUnitRows(
  page: Page,
  unit: string,
): Promise<Array<{
  checkbox: Locator;
  row: Locator;
  modelCount: number | null;
}>> {
  const checkboxes = page.locator(
    'main input[type="checkbox"][aria-label]',
  );
  const rows: Array<{
    checkbox: Locator;
    row: Locator;
    modelCount: number | null;
  }> = [];
  for (let index = 0; index < (await checkboxes.count()); index += 1) {
    const checkbox = checkboxes.nth(index);
    const label =
      (await checkbox.getAttribute("aria-label").catch(() => null)) ?? "";
    const includedUnit = label.replace(/^include\s+/i, "").trim();
    const includedUnitName = includedUnit
      .replace(
        /\s*(?:[,;:()\-–—]\s*)?\d+\s*(?:models?|miniatures?)\b.*$/i,
        "",
      )
      .trim();
    if (normalized(includedUnitName) !== normalized(unit)) continue;
    const row = checkbox.locator(
      "xpath=ancestor::*[.//button[normalize-space()='Edit']][1]",
    );
    if ((await row.count()) !== 1) continue;
    const text = await row.innerText().catch(() => "");
    rows.push({
      checkbox,
      row,
      modelCount: importedUnitModelCount(`${label} ${text}`),
    });
  }
  return rows;
}

async function importedUnitRowForEntry(
  page: Page,
  entry: ProfilePolicyV1["entries"][number],
): Promise<Locator | null> {
  const rows = await importedUnitRows(page, entry.unit);
  if (rows.length === 0) return null;
  let candidates = rows;
  if (entry.modelCount !== undefined) {
    const exposedModelCounts = rows.some(
      (row) => row.modelCount !== null,
    );
    if (exposedModelCounts) {
      candidates = rows.filter(
        (row) => row.modelCount === entry.modelCount,
      );
      if (candidates.length === 0) return null;
    } else if (rows.length > 1) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera did not expose model counts for duplicate imported unit "${entry.unit}", so RosterPilot could not safely apply its frozen profile policy.`,
      );
    }
  }
  const occurrence = entry.unitOccurrence ?? 1;
  if (
    entry.unitOccurrence === undefined &&
    candidates.length > 1
  ) {
    throw new TesseraAutomationError(
      "TESSERA_PROFILE_POLICY_REQUIRED",
      `The legacy profile-policy entry for "${entry.unit}" is ambiguous across duplicate imported units. Regenerate the scaffold with modelCount and unitOccurrence.`,
    );
  }
  return candidates[occurrence - 1]?.row ?? null;
}

async function applyProfilePolicyInImportedUnitEditor(
  page: Page,
  entries: ProfilePolicyV1["entries"],
): Promise<number> {
  let applied = 0;
  for (const entry of entries) {
    const row = await importedUnitRowForEntry(page, entry);
    if (!row) continue;
    const editButton = row.getByRole("button", { name: "Edit", exact: true });
    if ((await editButton.count()) !== 1) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera did not expose one Edit control for imported unit "${entry.unit}".`,
      );
    }
    await editButton.click();
    const editorHeading = page.getByText("Edit imported unit", { exact: true });
    try {
      await editorHeading.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera did not open its imported-unit editor for "${entry.unit}".`,
      );
    }

    const weaponNames = page.locator('main input[placeholder="Weapon name"]');
    const matchingWeapons: Array<{
      selected: boolean;
      profile: string;
      count: Locator;
      currentCount: number;
    }> = [];
    for (let index = 0; index < (await weaponNames.count()); index += 1) {
      const weaponNameControl = weaponNames.nth(index);
      const weaponName = await weaponNameControl.inputValue();
      const profile = importedWeaponProfile(weaponName, entry.weaponGroup);
      if (profile === null) continue;
      const count = await profileCountControl(weaponNameControl);
      if (!count) {
        throw new TesseraAutomationError(
          "TESSERA_PROFILE_EDITOR_MISMATCH",
          `Tessera did not expose one Count control for "${weaponName}".`,
        );
      }
      matchingWeapons.push({
        selected: normalized(profile) === normalized(entry.selectedProfile),
        profile,
        count,
        currentCount: Number(await count.inputValue()),
      });
    }
    const weaponsByProfile = new Map<
      string,
      typeof matchingWeapons
    >();
    for (const weapon of matchingWeapons) {
      const key = normalized(weapon.profile);
      const profileWeapons = weaponsByProfile.get(key) ?? [];
      profileWeapons.push(weapon);
      weaponsByProfile.set(key, profileWeapons);
    }
    const profileOccurrences = [...weaponsByProfile.values()];
    const groupCount = profileOccurrences[0]?.length ?? 0;
    const completeGroups =
      weaponsByProfile.size >= 2 &&
      groupCount > 0 &&
      profileOccurrences.every(
        (profileWeapons) => profileWeapons.length === groupCount,
      );
    const groups = completeGroups
      ? Array.from({ length: groupCount }, (_unused, index) =>
        profileOccurrences.map((profileWeapons) => profileWeapons[index])
      )
      : [];
    const groupActiveCounts = groups.map((group) =>
      group
        .map((weapon) => weapon.currentCount)
        .filter((count) => Number.isSafeInteger(count) && count > 0)
    );
    const activeTotal = groupActiveCounts.reduce(
      (sum, counts) => sum + (counts[0] ?? 0),
      0,
    );
    if (
      !completeGroups ||
      groups.some(
        (group, index) =>
          group.filter((weapon) => weapon.selected).length !== 1 ||
          groupActiveCounts[index].length !== 1,
      ) ||
      activeTotal !== entry.activeCount
    ) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera's imported-unit editor did not expose complete "${entry.weaponGroup}" profile groups totaling ${entry.activeCount} active weapon(s) for selected profile "${entry.selectedProfile}" (rows=${matchingWeapons.length}, groups=${groups.length}, activeTotal=${activeTotal}).`,
      );
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const activeCount = groupActiveCounts[groupIndex][0];
      for (const weapon of groups[groupIndex]) {
        const expectedCount = weapon.selected
          ? String(activeCount)
          : "0";
        await weapon.count.fill(expectedCount);
        if ((await weapon.count.inputValue()) !== expectedCount) {
          throw new TesseraAutomationError(
            "TESSERA_PROFILE_EDITOR_MISMATCH",
            `Tessera did not retain count ${expectedCount} for "${entry.weaponGroup} - ${weapon.profile}" subgroup ${groupIndex + 1}.`,
          );
        }
      }
    }

    const saveButton = page.getByRole("button", {
      name: "Save",
      exact: true,
    });
    if ((await saveButton.count()) !== 1) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera did not expose one Save control for imported unit "${entry.unit}".`,
      );
    }
    if (!(await saveButton.isEnabled().catch(() => false))) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera rejected the frozen profile counts for imported unit "${entry.unit}".`,
      );
    }
    await saveButton.click();
    try {
      await page
        .getByText("Review import", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_EDITOR_MISMATCH",
        `Tessera did not return to import review after applying "${entry.selectedProfile}" to "${entry.unit}".`,
      );
    }
    applied += 1;
  }
  return applied;
}

async function applyProfilePolicy(
  page: Page,
  issues: TesseraImportIssue[],
  policy: ProfilePolicyV1 | null | undefined,
): Promise<void> {
  const alternateIssues = issues.filter(
    (issue) => issue.code === "alternate-profile",
  );
  if (alternateIssues.length === 0) return;
  if (!policy) {
    throw new TesseraAutomationError(
      "TESSERA_PROFILE_POLICY_REQUIRED",
      "Tessera reported alternate weapon profiles that are not covered by an explicit profile policy.",
    );
  }
  const selects = page.locator("main select");
  for (const issue of alternateIssues) {
    const candidates = policy.entries.filter((entry) => {
      if (
        issue.weaponGroup &&
        !importedWeaponGroupMatches(issue.weaponGroup, entry.weaponGroup)
      ) return false;
      if (
        issue.unit &&
        !normalized(issue.unit).includes(normalized(entry.unit)) &&
        !normalized(entry.unit).includes(normalized(issue.unit))
      ) return false;
      if (issue.phase && entry.phase !== issue.phase) return false;
      return true;
    });
    if (candidates.length === 0) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_POLICY_REQUIRED",
        `The import issue "${issue.message}" did not resolve to a frozen profile-policy entry.`,
      );
    }
    const entry = candidates[0];
    const matchingControls: Array<{ index: number; score: number }> = [];
    for (let index = 0; index < (await selects.count()); index += 1) {
      const control = selects.nth(index);
      const options = await control
        .locator("option")
        .allTextContents()
        .catch(() => []);
      if (
        !options.some(
          (option) =>
            normalized(option) === normalized(entry.selectedProfile),
        )
      ) continue;
      const context = await control
        .locator("xpath=..")
        .innerText()
        .catch(() => "");
      const score =
        (normalized(context).includes(normalized(entry.weaponGroup)) ? 2 : 0) +
        (normalized(context).includes(normalized(entry.unit)) ? 1 : 0);
      matchingControls.push({ index, score });
    }
    matchingControls.sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
    const hasUniqueSelect =
      matchingControls.length > 0 &&
      (
        matchingControls.length === 1 ||
        matchingControls[0].score !== matchingControls[1].score
      );
    if (hasUniqueSelect && candidates.length === 1) {
      await selects
        .nth(matchingControls[0].index)
        .selectOption({ label: entry.selectedProfile });
      issue.resolvedByPolicy = true;
      issue.selectedProfile = entry.selectedProfile;
      continue;
    }
    const applied = await applyProfilePolicyInImportedUnitEditor(
      page,
      candidates,
    );
    if (applied > 0) {
      if (applied !== candidates.length) {
        const currentRows = await importedUnitRows(page, entry.unit);
        const visibleModelCounts = new Set(
          currentRows
            .map((row) => row.modelCount)
            .filter((value): value is number => value !== null),
        );
        const applicableCandidates = candidates.filter(
          (candidate) =>
            candidate.modelCount === undefined ||
            visibleModelCounts.size === 0 ||
            visibleModelCounts.has(candidate.modelCount),
        );
        if (applied !== applicableCandidates.length) {
          throw new TesseraAutomationError(
            "TESSERA_PROFILE_POLICY_APPLICATION_FAILED",
            `Tessera applied ${applied} of ${applicableCandidates.length} occurrence-specific ${entry.weaponGroup} profile decisions for "${entry.unit}".`,
          );
        }
      }
      issue.resolvedByPolicy = true;
      issue.selectedProfile =
        candidates.length === 1
          ? entry.selectedProfile
          : candidates
            .map(
              (candidate) =>
                `${candidate.modelCount ?? "legacy"} models #${candidate.unitOccurrence ?? "legacy"}: ${candidate.selectedProfile}`,
            )
            .join("; ");
      continue;
    }
    if (
      matchingControls.length === 0 ||
      (
        matchingControls.length > 1 &&
        matchingControls[0].score === matchingControls[1].score
      )
    ) {
      throw new TesseraAutomationError(
        "TESSERA_PROFILE_POLICY_APPLICATION_FAILED",
        `Tessera did not expose a unique ${entry.weaponGroup} control for profile "${entry.selectedProfile}".`,
      );
    }
  }
}

function savedListUnitCount(label: string): number | null {
  const units = label.match(/(?:^|\D)(\d+)\s*units?\b/i);
  const trailing = label.match(/\((\d+)\)\s*$/);
  const parsed = Number(units?.[1] ?? trailing?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function savedListName(label: string): string {
  return label
    .replace(/^\s*☰\s*/u, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s*(?:[·\-–—]\s*)?\d+\s+units?\s*$/i, "")
    .trim();
}

function importSideMessage(
  side: TesseraImportIssue["side"],
  message: string,
): string {
  return `[TESSERA_IMPORT_SIDE=${side}] ${message}`;
}

function missingExactSelectionSide(
  error: unknown,
): TesseraImportIssue["side"] | null {
  if (
    !(error instanceof TesseraAutomationError) ||
    error.code !== "TESSERA_LIST_SELECTION_MISMATCH" ||
    !/exposed 0 exact entries/i.test(error.message) ||
    !/identityMatches=0\b/i.test(error.message)
  ) {
    return null;
  }
  const side = error.message.match(
    /^\[TESSERA_IMPORT_SIDE=(player|opponent)\]/,
  )?.[1];
  return side === "player" || side === "opponent"
    ? side
    : null;
}

async function importRosz(
  page: Page,
  filename: string,
  side: TesseraImportIssue["side"],
  policy: ProfilePolicyV1 | null | undefined,
  browserListName: string,
  expectedUnitCount?: number,
): Promise<{
  warnings: string[];
  issues: TesseraImportIssue[];
  unitCount: number;
}> {
  const importButton = page
    .getByRole("button", { name: /import \.rosz/i })
    .first();
  if (!(await importButton.isVisible().catch(() => false))) {
    const body = await page.locator("body").innerText();
    if (/premium|unlock|licen[cs]e/i.test(body)) {
      throw new TesseraAutomationError(
        "TESSERA_PREMIUM_REQUIRED",
        "Tessera requires a premium unlock for roster import in this browser.",
      );
    }
    throw new TesseraAutomationError(
      "TESSERA_ROSTER_INPUT_UNAVAILABLE",
      "The Tessera .rosz import control could not be located.",
    );
  }
  const fileInputs = page.locator(
    'input[type="file"][accept*=".rosz" i]',
  );
  if ((await fileInputs.count()) !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_ROSTER_INPUT_UNAVAILABLE",
      "Tessera did not expose exactly one file input that explicitly accepts .rosz files.",
    );
  }
  try {
    await fileInputs.first().setInputFiles(filename);
  } catch (error) {
    if (
      error instanceof Error &&
      /enoent|no such file|does not exist/i.test(error.message)
    ) {
      throw new TesseraAutomationError(
        "TESSERA_ROSTER_FILE_MISSING",
        `The roster archive "${filename}" could not be read.`,
      );
    }
    throw error;
  }
  try {
    await page
      .getByText("Review import", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      "Tessera accepted the roster file but did not open its import review.",
    );
  }
  const listName = page.getByRole("textbox", {
    name: "Save to list (army name)",
    exact: true,
  });
  if ((await listName.count()) !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      "Tessera did not expose the imported army name control.",
    );
  }
  const reviewText = await page.locator("main").innerText();
  const warnings = reviewText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /warning|alternate profile|unverified/i.test(line))
    .slice(0, 20);
  const issues = structuredImportIssues(side, warnings);
  try {
    await applyProfilePolicy(page, issues, policy);
  } catch (error) {
    if (
      error instanceof TesseraAutomationError &&
      error.code.startsWith("TESSERA_PROFILE_")
    ) {
      throw new TesseraAutomationError(
        error.code,
        importSideMessage(side, error.message),
      );
    }
    throw error;
  }
  const currentListName = page.getByRole("textbox", {
    name: "Save to list (army name)",
    exact: true,
  });
  if ((await currentListName.count()) !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      "Tessera did not retain the imported army name control after profile review.",
    );
  }
  await currentListName.fill(browserListName);
  if (
    normalized(await currentListName.inputValue()) !==
    normalized(browserListName)
  ) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      importSideMessage(
        side,
        "Tessera did not retain the exact run-scoped army name before saving the import.",
      ),
    );
  }
  const add = page.getByRole("button", { name: /^add \d+$/i }).first();
  if (!(await add.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      "Tessera parsed the roster but did not expose its Add control.",
    );
  }
  const addLabel = await add.innerText();
  const unitCount = Number(addLabel.match(/^add\s+(\d+)$/i)?.[1]);
  if (!Number.isSafeInteger(unitCount) || unitCount <= 0) {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      "Tessera's import review did not report a valid positive unit count.",
    );
  }
  if (
    expectedUnitCount !== undefined &&
    unitCount !== expectedUnitCount
  ) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      importSideMessage(
        side,
        `Tessera parsed ${unitCount} units from the roster archive, but the deterministic saved-list contract requires ${expectedUnitCount}. The import was not saved.`,
      ),
    );
  }
  await add.click();
  try {
    await page
      .getByRole("heading", { name: "Roster", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new TesseraAutomationError(
      "TESSERA_IMPORT_REVIEW_MISSING",
      `Tessera did not save imported list "${browserListName}".`,
    );
  }
  return { warnings, issues, unitCount };
}

async function unlockPremium(
  page: Page,
  licenseKey: string,
  allowedOrigin: string,
): Promise<void> {
  if (new URL(page.url()).origin !== allowedOrigin) {
    throw new TesseraAutomationError(
      "TESSERA_ORIGIN_MISMATCH",
      "RosterPilot refused to enter the Tessera key on an unexpected origin.",
    );
  }
  const keyField = page
    .getByRole("textbox", { name: /licen[cs]e key/i })
    .first();
  await keyField.waitFor({ state: "visible", timeout: 10_000 });
  await keyField.fill(licenseKey);
  const unlock = page
    .getByRole("button", { name: /^unlock$/i })
    .first();
  if (!(await unlock.isEnabled().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_PREMIUM_KEY_REJECTED",
      "Tessera did not enable its premium unlock control.",
    );
  }
  await unlock.click();
  const deadline = Date.now() + 10_000;
  let unlocked = false;
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (/invalid|rejected|not valid|could not unlock/i.test(body)) {
      throw new TesseraAutomationError(
        "TESSERA_PREMIUM_KEY_REJECTED",
        "Tessera rejected the configured premium key.",
      );
    }
    const matrix = page
      .getByRole("button", {
        name: /army (?:vs|versus) army|threat matrix/i,
      })
      .first();
    if (await matrix.isVisible().catch(() => false)) {
      const label = await matrix.innerText().catch(() => "");
      if (!/🔒|locked|premium/i.test(label)) {
        unlocked = true;
        break;
      }
    }
    if (!(await keyField.isVisible().catch(() => false))) {
      unlocked = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!unlocked) {
    throw new TesseraAutomationError(
      "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
      "Tessera did not confirm the premium unlock within ten seconds.",
    );
  }
  const done = page.getByRole("button", { name: /^done$/i }).first();
  if (await done.isVisible().catch(() => false)) await done.click();
  const tactica = page
    .getByRole("button", { name: /^tactica$/i })
    .first();
  if (await tactica.isVisible().catch(() => false)) await tactica.click();
}

async function ensureRosterPage(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const rosterHeading = page.getByRole("heading", {
    name: "Roster",
    exact: true,
  });
  const onboarding = page
    .getByRole("button", { name: /^got it$/i })
    .first();
  if (!(await rosterHeading.isVisible().catch(() => false))) {
    await onboarding
      .waitFor({
        state: "visible",
        timeout: Math.min(timeoutMs, 5_000),
      })
      .catch(() => undefined);
    if (await onboarding.isVisible().catch(() => false)) {
      await onboarding.click();
    }
  }
  if (!(await rosterHeading.isVisible().catch(() => false))) {
    const muster = page
      .getByRole("button", { name: /^muster$/i })
      .first();
    await muster.waitFor({ state: "visible", timeout: timeoutMs });
    await muster.click();
  }
  await rosterHeading.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

async function openArmyMatrix(
  page: Page,
  licenseKey?: string,
  allowedOrigin = new URL(TESSERA_URL).origin,
  unlockAttempted = false,
): Promise<void> {
  const direct = page
    .getByRole("button", { name: /army (?:vs|versus) army|threat matrix/i })
    .first();
  if (await direct.isVisible().catch(() => false)) {
    const label = await direct.innerText().catch(() => "");
    if (/🔒|locked|premium/i.test(label)) {
      if (!licenseKey) {
        throw new TesseraAutomationError(
          "TESSERA_PREMIUM_KEY_ABSENT",
          "Tessera Army vs Army requires a configured premium key.",
        );
      }
      if (unlockAttempted) {
        throw new TesseraAutomationError(
          "TESSERA_PREMIUM_STILL_LOCKED",
          "Tessera still reports Army vs Army as locked after a confirmed unlock.",
        );
      }
      await direct.click();
      await unlockPremium(page, licenseKey, allowedOrigin);
      return openArmyMatrix(page, licenseKey, allowedOrigin, true);
    }
    await direct.click();
    return;
  }
  const tactica = page.getByRole("button", { name: /^tactica$/i }).first();
  if (await tactica.isVisible().catch(() => false)) await tactica.click();
  const matrix = page
    .getByRole("button", { name: /army (?:vs|versus) army|threat matrix/i })
    .or(page.getByText(/army (?:vs|versus) army|threat matrix/i))
    .first();
  if (!(await matrix.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_MATRIX_MISSING",
      "The Tessera Army vs Army threat matrix could not be located.",
    );
  }
  const label = await matrix.innerText().catch(() => "");
  if (/🔒|locked|premium/i.test(label)) {
    if (!licenseKey) {
      throw new TesseraAutomationError(
        "TESSERA_PREMIUM_KEY_ABSENT",
        "Tessera Army vs Army requires a configured premium key.",
      );
    }
    if (unlockAttempted) {
      throw new TesseraAutomationError(
        "TESSERA_PREMIUM_STILL_LOCKED",
        "Tessera still reports Army vs Army as locked after a confirmed unlock.",
      );
    }
    await matrix.click();
    await unlockPremium(page, licenseKey, allowedOrigin);
    return openArmyMatrix(page, licenseKey, allowedOrigin, true);
  }
  await matrix.click();
}

type SemanticArmySelectors = {
  player: Locator;
  opponent: Locator;
};

type SavedListOption = {
  label: string;
  value: string;
};

async function semanticArmySelectors(
  page: Page,
): Promise<SemanticArmySelectors> {
  const playerLabel =
    /^(?:list\s*a|lista|army\s*a|player army)(?:\s+(?:group|list|selector))?$/i;
  const opponentLabel =
    /^(?:list\s*b|listb|army\s*b|opponent army)(?:\s+(?:group|list|selector))?$/i;
  const labeledPlayer = page
    .getByLabel(playerLabel)
    .or(page.getByRole("combobox", { name: playerLabel }));
  const labeledOpponent = page
    .getByLabel(opponentLabel)
    .or(page.getByRole("combobox", { name: opponentLabel }));
  const allComboboxes = page.getByRole("combobox");
  const playerSelectorCount = await labeledPlayer.count();
  const opponentSelectorCount = await labeledOpponent.count();
  if (playerSelectorCount !== 1 || opponentSelectorCount !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      `Tessera army selectors are ambiguous (comboboxes=${await allComboboxes.count()}, player=${playerSelectorCount}, opponent=${opponentSelectorCount}).`,
    );
  }
  const player = labeledPlayer.first();
  const opponent = labeledOpponent.first();
  if (
    !(await player.isVisible().catch(() => false)) ||
    !(await opponent.isVisible().catch(() => false))
  ) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      "Tessera did not expose both semantically labeled army selectors.",
    );
  }
  return { player, opponent };
}

async function savedListOptions(
  select: Locator,
): Promise<SavedListOption[]> {
  return select
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        label: (element.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        value: (element as HTMLOptionElement).value,
      })),
    );
}

type SavedListReuseInspection = {
  action: "reused" | "missing";
};

async function inspectSavedListReuseSide(
  page: Page,
  select: Locator,
  expected: { name: string; expectedUnitCount: number },
  side: TesseraImportIssue["side"],
  timeoutMs: number,
): Promise<SavedListReuseInspection> {
  const expectedName = normalized(expected.name);
  const expectedValue = `list:${expected.name}`;
  const deadline = Date.now() + Math.min(timeoutMs, 1_500);
  let options: SavedListOption[] = [];
  let sameName: SavedListOption[] = [];
  do {
    options = await savedListOptions(select);
    sameName = options.filter(
      (candidate) =>
        normalized(savedListName(candidate.label)) === expectedName,
    );
    const truncatedMatches = options.filter((candidate) => {
      const candidateName = savedListName(candidate.label);
      if (!/(?:…|\.\.\.)\s*$/.test(candidateName)) return false;
      const visiblePrefix = normalized(
        candidateName.replace(/(?:…|\.\.\.)\s*$/, ""),
      );
      return (
        visiblePrefix.length > 0 &&
        expectedName.startsWith(visiblePrefix)
      );
    });
    if (truncatedMatches.length > 0) {
      throw new TesseraAutomationError(
        "TESSERA_LIST_SELECTION_MISMATCH",
        importSideMessage(
          side,
          "Tessera truncated a saved entry that could be the deterministic certification identity. RosterPilot refused to import or guess.",
        ),
      );
    }
    if (sameName.length > 0) break;
    await select.focus().catch(() => undefined);
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);

  if (sameName.length === 0) return { action: "missing" };
  if (sameName.length !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      importSideMessage(
        side,
        `Tessera exposed ${sameName.length} saved entries for one deterministic certification identity. RosterPilot refused to import or choose between duplicates.`,
      ),
    );
  }
  const [candidate] = sameName;
  const observedUnitCount = savedListUnitCount(candidate.label);
  if (observedUnitCount !== expected.expectedUnitCount) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      importSideMessage(
        side,
        `The deterministic saved entry reports ${observedUnitCount ?? "an unknown number of"} units; expected ${expected.expectedUnitCount}. RosterPilot refused to import over the mismatched identity.`,
      ),
    );
  }
  if (candidate.value !== expectedValue) {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      importSideMessage(
        side,
        "The deterministic saved entry did not retain its stable selector value. RosterPilot refused to reuse or replace it.",
      ),
    );
  }
  return { action: "reused" };
}

async function inspectSavedListReuse(
  page: Page,
  expected: PreparedSavedListReuse,
  timeoutMs: number,
): Promise<{
  player: SavedListReuseInspection;
  opponent: SavedListReuseInspection;
}> {
  const selectors = await semanticArmySelectors(page);
  const [player, opponent] = await Promise.all([
    inspectSavedListReuseSide(
      page,
      selectors.player,
      expected.player,
      "player",
      timeoutMs,
    ),
    inspectSavedListReuseSide(
      page,
      selectors.opponent,
      expected.opponent,
      "opponent",
      timeoutMs,
    ),
  ]);
  return { player, opponent };
}

async function selectArmies(
  page: Page,
  player: { name: string; unitCount: number },
  opponent: { name: string; unitCount: number },
): Promise<void> {
  const selectors = await semanticArmySelectors(page);
  const playerSelect = selectors.player;
  const opponentSelect = selectors.opponent;

  const selectArmy = async (
    select: Locator,
    roster: { name: string; unitCount: number },
    side: TesseraImportIssue["side"],
  ) => {
    const expectedName = normalized(roster.name);
    const expectedValue = `list:${roster.name}`;
    let options: Array<{ label: string; value: string }> = [];
    let identityMatches: Array<{ label: string; value: string }> = [];
    let matching: Array<{ label: string; value: string }> = [];
    const hydrationDeadline = Date.now() + 10_000;
    while (Date.now() < hydrationDeadline) {
      options = await savedListOptions(select);
      identityMatches = options.filter((candidate) => {
        return (
          candidate.value === expectedValue &&
          normalized(savedListName(candidate.label)) === expectedName
        );
      });
      matching = identityMatches.filter(
        (candidate) =>
          savedListUnitCount(candidate.label) === roster.unitCount,
      );
      if (matching.length > 0) break;
      await select.focus().catch(() => undefined);
      await page.waitForTimeout(100);
    }
    if (matching.length !== 1) {
      const optionHashes = options.slice(0, 20).map((candidate) =>
        createHash("sha256")
          .update(normalized(candidate.label))
          .digest("hex")
          .slice(0, 10),
      );
      const expectedNameHash = createHash("sha256")
        .update(expectedName)
        .digest("hex")
        .slice(0, 10);
      throw new TesseraAutomationError(
        "TESSERA_LIST_SELECTION_MISMATCH",
        importSideMessage(
          side,
          `Tessera exposed ${matching.length} exact entries for the imported army, expected one (options=${options.length}, identityMatches=${identityMatches.length}, expectedUnits=${roster.unitCount}, expectedNameHash=${expectedNameHash}, optionLabelHashes=${optionHashes.join(",") || "none"}).`,
        ),
      );
    }
    const option = matching[0];
    const listedUnitCount = savedListUnitCount(option.label);
    if (listedUnitCount !== roster.unitCount) {
      throw new TesseraAutomationError(
        "TESSERA_LIST_SELECTION_MISMATCH",
        importSideMessage(
          side,
          `Tessera listed "${roster.name}" with ${
            listedUnitCount ?? "an unknown number of"
          } units after importing ${roster.unitCount}.`,
        ),
      );
    }
    await select.selectOption(option.value);
    const selectedValue = await select.inputValue();
    const selectedLabel = await select
      .locator("option:checked")
      .innerText()
      .catch(() => "");
    if (
      selectedValue !== expectedValue ||
      normalized(savedListName(selectedLabel)) !== expectedName ||
      savedListUnitCount(selectedLabel) !== roster.unitCount
    ) {
      throw new TesseraAutomationError(
        "TESSERA_LIST_SELECTION_MISMATCH",
        importSideMessage(
          side,
          `Tessera did not retain imported army "${roster.name}" in its selector.`,
        ),
      );
    }
  };

  await selectArmy(playerSelect, player, "player");
  await selectArmy(opponentSelect, opponent, "opponent");

  const run = page
    .getByRole("button", {
      name: /run|calculate|simulate|build matrix|compare lists/i,
    })
    .first();
  if (!(await run.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_COMPARE_CONTROL_MISSING",
      "Tessera did not expose its army comparison control.",
    );
  }
  const enableDeadline = Date.now() + 3_000;
  while (
    Date.now() < enableDeadline &&
    !(await run.isEnabled().catch(() => false))
  ) {
    await page.waitForTimeout(50);
  }
  if (!(await run.isEnabled().catch(() => false))) {
    const body = await page.locator("main").innerText().catch(() => "");
    if (
      /too many units|unit limit|maximum\s+(?:of\s+)?\d+\s+units|max(?:imum)?\s+units|up to\s+\d+\s+units/i.test(
        body,
      )
    ) {
      throw new TesseraAutomationError(
        "TESSERA_SIDE_UNIT_LIMIT",
        "Tessera disabled comparison because one selected army exceeds its unit limit.",
      );
    }
    throw new TesseraAutomationError(
      "TESSERA_COMPARE_DISABLED",
      "Tessera did not enable comparison after both imported armies were selected.",
    );
  }
  await run.click();
}

const phaseControlNames: Record<TesseraPhase, RegExp> = {
  shooting: /^shooting$/i,
  fight: /^fight$/i,
};

const metricControlNames: Record<TesseraMetric, RegExp> = {
  "wipe-probability": /^p\s*\(\s*wiped\s*\)$/i,
  "half-wipe-probability":
    /^p\s*\(\s*(?:≥?\s*half(?:\s+wiped)?|half-wipe|≥?\s*50\s*%|50\s*%\+?)\s*\)$/i,
  "mean-kills": /^mean kills$/i,
  "mean-damage": /^mean damage$/i,
};

const directionControlNames: Record<TesseraDirection, RegExp> = {
  "player-to-opponent": /^a\s*(?:→|->|to)\s*b$/i,
  "opponent-to-player": /^b\s*(?:→|->|to)\s*a$/i,
};

type MatrixDimensions = {
  attackers: number;
  targets: number;
};

type ScenarioSelection = Pick<
  TesseraScenario,
  "phase" | "direction" | "metric"
>;

function scenarioId(selection: ScenarioSelection): string {
  return `${selection.phase}:${selection.direction}:${selection.metric}`;
}

function normalizeRequestedValues<T extends string>(
  values: readonly T[] | undefined,
  defaults: readonly T[],
): T[] {
  return [...new Set(values?.length ? values : defaults)];
}

function requestedScenarios(input: TesseraBrowserInput): ScenarioSelection[] {
  const mode = input.analysisMode ?? "quick";
  const phases = normalizeRequestedValues(
    input.phases,
    mode === "full" ? TESSERA_PHASES : ["shooting"],
  );
  const metrics = normalizeRequestedValues(
    input.metrics,
    mode === "full" ? TESSERA_METRICS : ["wipe-probability"],
  );
  return phases.flatMap((phase) =>
    metrics.flatMap((metric) =>
      TESSERA_DIRECTIONS.map((direction) => ({
        phase,
        direction,
        metric,
      })),
    ),
  );
}

async function matrixTables(page: Page): Promise<string[][][]> {
  return page.locator("table").evaluateAll((elements) =>
    elements.map((table) =>
      [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("th,td")].map((cell) =>
          (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
        ),
      ),
    ),
  );
}

function matrixArea(rows: string[][]): number {
  if (rows.length < 2 || rows[0].length < 2) return 0;
  return (rows.length - 1) * (rows[0].length - 1);
}

async function extractMatrixRows(page: Page): Promise<string[][]> {
  const candidates = (await matrixTables(page))
    .filter((rows) => matrixArea(rows) > 0)
    .sort((left, right) => matrixArea(right) - matrixArea(left));
  return candidates[0] ?? [];
}

function matrixSha256(rows: string[][]): string {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

type MatrixRefreshWatch = {
  token: string;
};

type MatrixRefreshState = {
  fingerprint: string;
  refreshed: boolean;
  revision: number;
};

async function beginMatrixRefreshWatch(
  page: Page,
): Promise<MatrixRefreshWatch> {
  const token = randomUUID();
  const armed = await page.locator("table").evaluateAll(
    (elements, watchToken) => {
      type BrowserWatch = {
        token: string;
        table: HTMLTableElement;
        revision: number;
        observer: MutationObserver;
      };
      const browserWindow = window as typeof window & {
        __rosterpilotMatrixRefreshWatch?: BrowserWatch;
      };
      browserWindow.__rosterpilotMatrixRefreshWatch?.observer.disconnect();
      const candidate = elements
        .filter((element): element is HTMLTableElement =>
          element instanceof HTMLTableElement
        )
        .map((table) => {
          const rows = table.querySelectorAll("tr");
          const columns = rows[0]?.querySelectorAll("th,td").length ?? 0;
          return {
            area:
              rows.length < 2 || columns < 2
                ? 0
                : (rows.length - 1) * (columns - 1),
            table,
          };
        })
        .sort((left, right) => right.area - left.area)[0];
      if (!candidate || candidate.area === 0) return false;
      const table = candidate.table;

      const state: BrowserWatch = {
        token: watchToken,
        table,
        revision: 0,
        observer: undefined as unknown as MutationObserver,
      };
      state.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const target = mutation.target;
          const mutatesOriginal =
            target === table ||
            (target instanceof Node && table.contains(target));
          const removesOriginal =
            mutation.type === "childList" &&
            [...mutation.removedNodes].some(
              (node) =>
                node === table ||
                (node instanceof Element && node.contains(table)),
            );
          if (mutatesOriginal || removesOriginal) {
            state.revision += 1;
          }
        }
      });
      state.observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      browserWindow.__rosterpilotMatrixRefreshWatch = state;
      return true;
    },
    token,
  );
  if (!armed) {
    throw new TesseraAutomationError(
      "TESSERA_MATRIX_MISSING",
      "Tessera did not expose a result matrix to monitor for freshness.",
    );
  }
  return { token };
}

async function readMatrixRefreshState(
  page: Page,
  watch: MatrixRefreshWatch,
): Promise<MatrixRefreshState> {
  return page.locator("table").evaluateAll(
    (elements, watchToken) => {
      type BrowserWatch = {
        token: string;
        table: HTMLTableElement;
        revision: number;
        observer: MutationObserver;
      };
      const state = (
        window as typeof window & {
          __rosterpilotMatrixRefreshWatch?: BrowserWatch;
        }
      ).__rosterpilotMatrixRefreshWatch;
      const candidate = elements
        .filter((element): element is HTMLTableElement =>
          element instanceof HTMLTableElement
        )
        .map((table) => {
          const rows = [...table.querySelectorAll("tr")].map((row) =>
            [...row.querySelectorAll("th,td")].map((cell) =>
              (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
            ),
          );
          return {
            area:
              rows.length < 2 || rows[0].length < 2
                ? 0
                : (rows.length - 1) * (rows[0].length - 1),
            rows,
            table,
          };
        })
        .sort((left, right) => right.area - left.area)[0];
      const table = candidate?.table;
      const rows = candidate && candidate.area > 0 ? candidate.rows : [];
      if (!state || state.token !== watchToken) {
        return {
          fingerprint: rows.length > 0 ? JSON.stringify(rows) : "",
          refreshed: false,
          revision: -1,
        };
      }
      return {
        fingerprint: rows.length > 0 ? JSON.stringify(rows) : "",
        refreshed:
          state.revision > 0 ||
          !state.table.isConnected ||
          Boolean(table && table !== state.table),
        revision: state.revision,
      };
    },
    watch.token,
  );
}

async function endMatrixRefreshWatch(
  page: Page,
  watch: MatrixRefreshWatch,
): Promise<void> {
  await page.evaluate((watchToken) => {
    type BrowserWatch = {
      token: string;
      observer: MutationObserver;
    };
    const browserWindow = window as typeof window & {
      __rosterpilotMatrixRefreshWatch?: BrowserWatch;
    };
    const state = browserWindow.__rosterpilotMatrixRefreshWatch;
    if (state?.token !== watchToken) return;
    state.observer.disconnect();
    delete browserWindow.__rosterpilotMatrixRefreshWatch;
  }, watch.token).catch(() => undefined);
}

async function waitForMatrixRefresh(
  page: Page,
  watch: MatrixRefreshWatch,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableState = "";
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await readMatrixRefreshState(page, watch);
    if (current.refreshed && current.fingerprint) {
      const currentState = `${current.revision}:${current.fingerprint}`;
      if (currentState === stableState) {
        stableReads += 1;
        if (stableReads >= 3) return;
      } else {
        stableState = currentState;
        stableReads = 1;
      }
    }
    await page.waitForTimeout(50);
  }
  throw new TesseraAutomationError(
    "TESSERA_STALE_MATRIX",
    "Tessera confirmed the selected control but did not mutate or replace the result matrix.",
  );
}

async function waitForMatrixToSettle(
  page: Page,
  watch: MatrixRefreshWatch,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const quietPeriodMs = Math.min(200, Math.max(100, timeoutMs / 4));
  let stableState = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const current = await readMatrixRefreshState(page, watch);
    const currentState = `${current.revision}:${current.fingerprint}`;
    if (current.fingerprint && currentState === stableState) {
      if (Date.now() - stableSince >= quietPeriodMs) return;
    } else {
      stableState = currentState;
      stableSince = Date.now();
    }
    await page.waitForTimeout(50);
  }
  throw new TesseraAutomationError(
    "TESSERA_STALE_MATRIX",
    "Tessera's result matrix did not settle after the phase control changed.",
  );
}

async function pressControl(
  control: Locator,
  description: string,
  timeoutMs: number,
): Promise<boolean> {
  await control
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => undefined);
  if (!(await control.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      `Tessera did not expose its ${description} control.`,
    );
  }
  const pressed = await control.getAttribute("aria-pressed");
  if (pressed === null) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      `Tessera's ${description} control did not expose aria-pressed state.`,
    );
  }
  if (pressed === "true") return false;

  await control.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      (await control.getAttribute("aria-pressed").catch(() => null)) ===
      "true"
    ) {
      return true;
    }
    await control.page().waitForTimeout(50);
  }
  throw new TesseraAutomationError(
    "TESSERA_UI_CHANGED",
    `Tessera did not confirm its ${description} selection.`,
  );
}

async function recomputePhaseMatrix(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const candidates = page.getByRole("button", {
    name: /compare lists/i,
  });
  const visible: Locator[] = [];
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visible.push(candidate);
    }
  }
  if (visible.length === 0) {
    throw new TesseraAutomationError(
      "TESSERA_COMPARE_CONTROL_MISSING",
      "Tessera did not expose its Compare lists control for the selected phase.",
    );
  }
  if (visible.length !== 1) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      `Tessera exposed ${visible.length} visible Compare lists controls; expected one.`,
    );
  }
  const compare = visible[0];
  const enableDeadline = Date.now() + Math.min(timeoutMs, 3_000);
  while (
    Date.now() < enableDeadline &&
    !(await compare.isEnabled().catch(() => false))
  ) {
    await page.waitForTimeout(50);
  }
  if (!(await compare.isEnabled().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_COMPARE_DISABLED",
      "Tessera did not enable Compare lists for the selected phase.",
    );
  }

  if ((await extractMatrixRows(page)).length === 0) {
    await compare.click();
    const deadline = Date.now() + timeoutMs;
    let stableFingerprint = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      const rows = await extractMatrixRows(page);
      const fingerprint = rows.length > 0 ? matrixSha256(rows) : "";
      if (fingerprint && fingerprint === stableFingerprint) {
        stableReads += 1;
        if (stableReads >= 3) return;
      } else {
        stableFingerprint = fingerprint;
        stableReads = fingerprint ? 1 : 0;
      }
      await page.waitForTimeout(50);
    }
    throw new TesseraAutomationError(
      "TESSERA_MATRIX_MISSING",
      "Tessera did not restore its result matrix after Compare lists was retried.",
    );
  } else {
    const watch = await beginMatrixRefreshWatch(page);
    try {
      await compare.click();
      await waitForMatrixRefresh(page, watch, timeoutMs);
    } finally {
      await endMatrixRefreshWatch(page, watch);
    }
  }
}

async function selectScenarioControls(
  page: Page,
  selection: ScenarioSelection,
  timeoutMs: number,
  forcePhaseRecompute = false,
): Promise<boolean> {
  let changed = false;
  if (
    forcePhaseRecompute &&
    (await extractMatrixRows(page)).length === 0
  ) {
    await recomputePhaseMatrix(page, timeoutMs);
    changed = true;
  }
  const selectedPhase = phaseControl(page, selection.phase);
  const phaseChanged =
    (await selectedPhase.getAttribute("aria-pressed").catch(() => null)) !==
    "true";

  if (phaseChanged) {
    // The live Tessera UI updates the selected phase without recomputing its
    // batch. Drain any render caused by the state change, then arm a fresh
    // matrix-scoped watch so only Compare lists can prove the new phase.
    const settleWatch = await beginMatrixRefreshWatch(page);
    try {
      changed =
        (await pressControl(
          selectedPhase,
          `${selection.phase} phase`,
          timeoutMs,
        )) || changed;
      await confirmExclusiveGroupPressed(
        selection.phase,
        TESSERA_PHASES.map((phase) => [phase, phaseControl(page, phase)]),
      );
      await waitForMatrixToSettle(page, settleWatch, timeoutMs);
    } finally {
      await endMatrixRefreshWatch(page, settleWatch);
    }
  }

  if (phaseChanged || forcePhaseRecompute) {
    await recomputePhaseMatrix(page, timeoutMs);
    changed = true;
  }

  const controls: Array<[Locator, string]> = [
    [metricControl(page, selection.metric), `${selection.metric} metric`],
    [
      directionControl(page, selection.direction),
      `${selection.direction} direction`,
    ],
  ];
  const requiresChange = (
    await Promise.all(
      controls.map(([control]) =>
        control.getAttribute("aria-pressed").catch(() => null),
      ),
    )
  ).some((pressed) => pressed !== "true");
  if (requiresChange) {
    // Metric and direction only project the already-computed phase batch.
    // Monitor them separately so their render cannot certify a phase change.
    const watch = await beginMatrixRefreshWatch(page);
    try {
      for (const [control, description] of controls) {
        changed =
          (await pressControl(control, description, timeoutMs)) || changed;
      }
      await confirmExclusivePressed(page, selection);
      await waitForMatrixRefresh(page, watch, timeoutMs);
    } finally {
      await endMatrixRefreshWatch(page, watch);
    }
  }
  await confirmExclusivePressed(page, selection);
  return changed;
}

async function confirmExclusiveGroupPressed(
  expected: string,
  controls: Array<[string, Locator]>,
): Promise<void> {
  const selected: string[] = [];
  for (const [value, control] of controls) {
    if (
      (await control.isVisible().catch(() => false)) &&
      (await control.getAttribute("aria-pressed").catch(() => null)) ===
        "true"
    ) {
      selected.push(value);
    }
  }
  if (selected.length !== 1 || selected[0] !== expected) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      `Tessera did not expose an exclusive aria-pressed state for ${expected}.`,
    );
  }
}

async function confirmExclusivePressed(
  page: Page,
  selection: ScenarioSelection,
): Promise<void> {
  const groups: Array<{
    expected: string;
    controls: Array<[string, Locator]>;
  }> = [
    {
      expected: selection.phase,
      controls: TESSERA_PHASES.map((phase) => [
        phase,
        phaseControl(page, phase),
      ]),
    },
    {
      expected: selection.metric,
      controls: TESSERA_METRICS.map((metric) => [
        metric,
        metricControl(page, metric),
      ]),
    },
    {
      expected: selection.direction,
      controls: TESSERA_DIRECTIONS.map((direction) => [
        direction,
        directionControl(page, direction),
      ]),
    },
  ];
  for (const group of groups) {
    await confirmExclusiveGroupPressed(group.expected, group.controls);
  }
}

function phaseControl(page: Page, phase: TesseraPhase): Locator {
  return page
    .getByRole("button", { name: phaseControlNames[phase] })
    .first();
}

function metricControl(page: Page, metric: TesseraMetric): Locator {
  return page
    .getByRole("button", { name: metricControlNames[metric] })
    .first();
}

function directionControl(page: Page, direction: TesseraDirection): Locator {
  return page
    .getByRole("button", { name: directionControlNames[direction] })
    .first();
}

async function extractSettings(page: Page): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};
  const selects = page.locator("select");
  for (let index = 0; index < (await selects.count()); index += 1) {
    const control = selects.nth(index);
    const label =
      (await control.getAttribute("aria-label")) ??
      (await control.getAttribute("name"));
    if (
      !label ||
      /^(?:list[ab]?|army[ab]?|roster[ab]?)(?:\s|$)/i.test(
        label.trim(),
      )
    ) {
      continue;
    }
    const value = await control.inputValue().catch(() => "");
    if (value) settings[label] = value;
  }
  const pressed = await page
    .locator('button[aria-pressed="true"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
  const phase = pressed.find((value) => /^(shooting|fight)$/i.test(value));
  if (phase) settings.phase = phase;
  const metric = pressed.find((value) =>
    /^(p\s*\(.*\)|mean kills|mean damage)$/i.test(value),
  );
  if (metric) settings.metric = metric;
  const direction = pressed.find((value) =>
    /^(?:a|b)\s*(?:→|->|to)\s*(?:a|b)$/i.test(value),
  );
  if (direction) settings.direction = direction;
  const iterations = await extractIterations(page);
  if (iterations !== null) settings.iterations = String(iterations);
  return settings;
}

async function extractIterations(page: Page): Promise<number | null> {
  const labeled = page.locator(
    'input[aria-label*="iteration" i], input[name*="iteration" i], select[aria-label*="iteration" i], select[name*="iteration" i], input[aria-label*="simulation" i], select[aria-label*="simulation" i]',
  );
  for (let index = 0; index < (await labeled.count()); index += 1) {
    const value = await labeled.nth(index).inputValue().catch(() => "");
    const parsed = Number(value.replaceAll(",", ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const text = await page.locator("main").innerText().catch(() => "");
  const countBeforeLabel = text.match(
    /(\d[\d,]*)\s*(?:iterations?|simulations?|trials?|runs?)\b/i,
  );
  if (countBeforeLabel) {
    return Number(countBeforeLabel[1].replaceAll(",", ""));
  }
  const countAfterLabel = text.match(
    /(?:iterations?|simulations?|trials?|runs?)\s*:?\s*(\d[\d,]*)\b/i,
  );
  return countAfterLabel
    ? Number(countAfterLabel[1].replaceAll(",", ""))
    : null;
}

function stableScenarioSettings(
  settings: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings)
      .filter(
        ([key]) =>
          !["phase", "metric", "direction", "iterations"].includes(
            key.toLocaleLowerCase(),
          ),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function frozenScenarioFor(
  contract: TesseraFrozenScenarioContract[] | null | undefined,
  selection: ScenarioSelection,
): TesseraFrozenScenarioContract | null {
  if (!contract) return null;
  return (
    contract.find(
      (entry) =>
        entry.phase === selection.phase &&
        entry.direction === selection.direction &&
        entry.metric === selection.metric,
    ) ?? null
  );
}

async function applyFrozenSimulationControls(
  page: Page,
  contract: TesseraFrozenScenarioContract[] | null | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!contract?.length) return;
  const iterationValues = [
    ...new Set(
      contract
        .map((entry) => entry.iterations)
        .filter((value): value is number => value !== null),
    ),
  ];
  if (iterationValues.length > 1) {
    throw new TesseraAutomationError(
      "TESSERA_SETTINGS_REPLAY_FAILED",
      "The frozen stage contains inconsistent iteration counts.",
    );
  }
  const expectedIterations = iterationValues[0] ?? null;
  if (expectedIterations !== null) {
    const actualIterations = await extractIterations(page);
    if (actualIterations !== expectedIterations) {
      const controls = page.locator(
        'input[aria-label*="iteration" i], input[name*="iteration" i], select[aria-label*="iteration" i], select[name*="iteration" i], input[aria-label*="simulation" i], select[aria-label*="simulation" i]',
      );
      if ((await controls.count()) !== 1) {
        throw new TesseraAutomationError(
          "TESSERA_SETTINGS_REPLAY_FAILED",
          `Tessera is using ${actualIterations ?? "an unknown number of"} iterations and did not expose one control for the frozen value ${expectedIterations}.`,
        );
      }
      const control = controls.first();
      const watch = await beginMatrixRefreshWatch(page);
      try {
        if ((await control.evaluate((element) => element.tagName)) === "SELECT") {
          await control.selectOption(String(expectedIterations));
        } else {
          await control.fill(String(expectedIterations));
          await control.press("Tab").catch(() => undefined);
        }
        await waitForMatrixRefresh(page, watch, timeoutMs);
      } finally {
        await endMatrixRefreshWatch(page, watch);
      }
      if ((await extractIterations(page)) !== expectedIterations) {
        throw new TesseraAutomationError(
          "TESSERA_SETTINGS_REPLAY_FAILED",
          `Tessera did not retain the frozen ${expectedIterations}-iteration setting.`,
        );
      }
    }
  }

  const expectedSettings = stableScenarioSettings(
    contract[0].settings,
  );
  if (
    contract.some(
      (entry) =>
        JSON.stringify(stableScenarioSettings(entry.settings)) !==
        JSON.stringify(expectedSettings),
    )
  ) {
    throw new TesseraAutomationError(
      "TESSERA_SETTINGS_REPLAY_FAILED",
      "The frozen stage contains inconsistent simulation settings.",
    );
  }
  for (const [label, expectedValue] of Object.entries(
    expectedSettings,
  )) {
    const current = (await extractSettings(page))[label];
    if (current === expectedValue) continue;
    const controls = page.locator("select").filter({
      has: page.locator("option"),
    });
    const matching: Locator[] = [];
    for (let index = 0; index < (await controls.count()); index += 1) {
      const control = controls.nth(index);
      const controlLabel =
        (await control.getAttribute("aria-label")) ??
        (await control.getAttribute("name"));
      if (controlLabel === label) matching.push(control);
    }
    if (matching.length !== 1) {
      throw new TesseraAutomationError(
        "TESSERA_SETTINGS_REPLAY_FAILED",
        `Tessera did not expose one "${label}" control for frozen value "${expectedValue}".`,
      );
    }
    const watch = await beginMatrixRefreshWatch(page);
    try {
      await matching[0].selectOption(expectedValue);
      await waitForMatrixRefresh(page, watch, timeoutMs);
    } finally {
      await endMatrixRefreshWatch(page, watch);
    }
    if ((await extractSettings(page))[label] !== expectedValue) {
      throw new TesseraAutomationError(
        "TESSERA_SETTINGS_REPLAY_FAILED",
        `Tessera did not retain frozen setting ${label}=${expectedValue}.`,
      );
    }
  }
}

function verifyFrozenScenario(
  selection: ScenarioSelection,
  settings: Record<string, string>,
  iterations: number | null,
  contract: TesseraFrozenScenarioContract[] | null | undefined,
): void {
  if (!contract) return;
  const expected = frozenScenarioFor(contract, selection);
  if (!expected) {
    throw new TesseraAutomationError(
      "TESSERA_SETTINGS_CHANGED",
      `The frozen stage has no execution contract for ${scenarioId(selection)}.`,
    );
  }
  if (
    expected.iterations !== iterations ||
    JSON.stringify(stableScenarioSettings(expected.settings)) !==
      JSON.stringify(stableScenarioSettings(settings))
  ) {
    throw new TesseraAutomationError(
      "TESSERA_SETTINGS_CHANGED",
      `Tessera did not reproduce the frozen settings and iteration count for ${scenarioId(selection)}.`,
    );
  }
}

function metricValue(text: string, metric: TesseraMetric): number | null {
  if (/^[—–-]+$/.test(text.trim())) return 0;
  if (
    metric === "wipe-probability" ||
    metric === "half-wipe-probability"
  ) {
    return numberFrom(text, /(\d+(?:\.\d+)?)\s*%/, 100);
  }
  const labeled =
    metric === "mean-kills"
      ? numberFrom(text, /(\d+(?:\.\d+)?)\s*(?:kills?|models?)\b/i)
      : numberFrom(text, /(\d+(?:\.\d+)?)\s*(?:damage|dmg)\b/i);
  if (labeled !== null) return labeled;
  const plain = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  return plain ? Number(plain[1]) : null;
}

function occurrences(labels: string[]): number[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count;
  });
}

function parseScenarioMatrix(
  rows: string[][],
  selection: ScenarioSelection,
): { cells: TesseraScenarioCell[]; dimensions: MatrixDimensions } {
  if (rows.length < 2 || rows[0].length < 2) {
    throw new TesseraAutomationError(
      "TESSERA_INCOMPLETE_MATRIX",
      "Tessera did not expose a matrix with attacker and target headers.",
    );
  }
  const width = rows[0].length;
  if (rows.slice(1).some((row) => row.length !== width)) {
    throw new TesseraAutomationError(
      "TESSERA_INCOMPLETE_MATRIX",
      "Tessera exposed a non-rectangular result matrix.",
    );
  }
  const targets = rows[0].slice(1).map((value) => value.trim());
  const attackers = rows.slice(1).map((row) => row[0]?.trim() ?? "");
  if (targets.some((value) => !value) || attackers.some((value) => !value)) {
    throw new TesseraAutomationError(
      "TESSERA_INCOMPLETE_MATRIX",
      "Tessera exposed a matrix with missing unit labels.",
    );
  }
  const attackerOccurrences = occurrences(attackers);
  const targetOccurrences = occurrences(targets);
  const cells: TesseraScenarioCell[] = [];
  for (let attackerIndex = 0; attackerIndex < attackers.length; attackerIndex += 1) {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const text = rows[attackerIndex + 1][targetIndex + 1];
      const value = metricValue(text, selection.metric);
      if (value === null) {
        throw new TesseraAutomationError(
          "TESSERA_INCOMPLETE_MATRIX",
          `Tessera exposed an unreadable ${selection.metric} value at row ${
            attackerIndex + 1
          }, column ${targetIndex + 1}.`,
        );
      }
      const probabilityMetric =
        selection.metric === "wipe-probability" ||
        selection.metric === "half-wipe-probability";
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (probabilityMetric && value > 1)
      ) {
        throw new TesseraAutomationError(
          "TESSERA_INVALID_MATRIX_VALUE",
          `Tessera exposed an out-of-range ${selection.metric} value at row ${
            attackerIndex + 1
          }, column ${targetIndex + 1}.`,
        );
      }
      const parsed = parseTesseraMatrixTable([
        ["Attacker", targets[targetIndex]],
        [attackers[attackerIndex], text],
      ])[0];
      cells.push({
        attacker: attackers[attackerIndex],
        target: targets[targetIndex],
        direction: selection.direction,
        killProbability:
          selection.metric === "wipe-probability"
            ? value
            : (parsed?.killProbability ?? null),
        expectedDamage:
          selection.metric === "mean-damage"
            ? value
            : (parsed?.expectedDamage ?? null),
        damagePer100Points: parsed?.damagePer100Points ?? null,
        attackerIndex,
        targetIndex,
        attackerOccurrence: attackerOccurrences[attackerIndex],
        targetOccurrence: targetOccurrences[targetIndex],
        metricValue: value,
      });
    }
  }
  return {
    cells,
    dimensions: {
      attackers: attackers.length,
      targets: targets.length,
    },
  };
}

function verifyDimensions(
  selection: ScenarioSelection,
  dimensions: MatrixDimensions,
  expected: Map<TesseraDirection, MatrixDimensions>,
): void {
  const sameDirection = expected.get(selection.direction);
  if (
    sameDirection &&
    (sameDirection.attackers !== dimensions.attackers ||
      sameDirection.targets !== dimensions.targets)
  ) {
    throw new TesseraAutomationError(
      "TESSERA_INCOMPLETE_MATRIX",
      `Tessera changed its ${selection.direction} matrix dimensions from ${sameDirection.attackers}×${sameDirection.targets} to ${dimensions.attackers}×${dimensions.targets}.`,
    );
  }
  const reverseDirection =
    selection.direction === "player-to-opponent"
      ? "opponent-to-player"
      : "player-to-opponent";
  const reverse = expected.get(reverseDirection);
  if (
    reverse &&
    (reverse.attackers !== dimensions.targets ||
      reverse.targets !== dimensions.attackers)
  ) {
    throw new TesseraAutomationError(
      "TESSERA_INCOMPLETE_MATRIX",
      "Tessera's forward and reverse matrix dimensions are not transposes.",
    );
  }
  expected.set(selection.direction, dimensions);
}

function scenarioFailure(
  selection: ScenarioSelection,
  error: unknown,
  attempt: number,
): string {
  const { code, message } = scenarioCaptureFailure(error);
  return `[${code}] Scenario ${scenarioId(selection)} was not captured after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${message}`;
}

const maximumScenarioCaptureAttempts = 2;

function scenarioCaptureFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const classified = classifyTesseraAutomationFailure(error);
  return {
    ...classified,
    retryable:
      error instanceof TesseraAutomationError &&
      (
        error.code === "TESSERA_STALE_MATRIX" ||
        error.code === "TESSERA_MATRIX_MISSING"
      ),
  };
}

function scenarioRetryWarning(
  selection: ScenarioSelection,
  failure: ReturnType<typeof scenarioCaptureFailure>,
  attempt: number,
): string {
  return `[TESSERA_SCENARIO_RETRY] Scenario ${scenarioId(selection)} capture attempt ${attempt}/${maximumScenarioCaptureAttempts} failed with [${failure.code}]: ${failure.message} Retrying once in the same browser session without re-importing armies.`;
}

export async function runTesseraBrowserMatchup(
  input: TesseraBrowserInput,
  dependencies: TesseraBrowserDependencies = {},
): Promise<TesseraBrowserResult> {
  const preparedSavedListReuse =
    await prepareSavedListReuse(input);
  const ownsContext = dependencies.context === undefined;
  const context =
    dependencies.context ??
    (await chromium.launchPersistentContext(input.profileDirectory, {
      channel: "chrome",
      headless: dependencies.headless ?? false,
      acceptDownloads: true,
    }));
  dependencies.onContext?.(context);
  if (ownsContext) {
    await dependencies.prepareContext?.(context);
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const baseUrl = dependencies.baseUrl ?? TESSERA_URL;
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
    });
    const timeout = dependencies.timeoutMs ?? 30_000;
    await ensureRosterPage(page, timeout);
    const browserRunId = randomUUID().slice(0, 8);
    const scopedListName = (
      side: "A" | "B",
      rosterName: string,
    ) =>
      `RP-${side}-${createHash("sha256")
        .update(normalized(rosterName))
        .digest("hex")
        .slice(0, 8)}-${browserRunId}`;
    const playerBrowserListName =
      preparedSavedListReuse?.player.name ??
      scopedListName("A", input.playerName);
    const opponentBrowserListName =
      preparedSavedListReuse?.opponent.name ??
      scopedListName("B", input.opponentName);
    type ImportedRoster = Awaited<ReturnType<typeof importRosz>>;
    const reusedImport = (
      unitCount: number,
    ): ImportedRoster => ({
      warnings: [],
      issues: [],
      unitCount,
    });
    let playerImport: ImportedRoster;
    let opponentImport: ImportedRoster;
    let savedListReuse:
      | TesseraBrowserResult["savedListReuse"]
      | undefined;
    const matrixOrigin = new URL(baseUrl).origin;
    if (preparedSavedListReuse) {
      await openArmyMatrix(
        page,
        input.licenseKey,
        matrixOrigin,
      );
      let inspection = await inspectSavedListReuse(
        page,
        preparedSavedListReuse,
        timeout,
      );
      if (
        inspection.player.action === "missing" ||
        inspection.opponent.action === "missing"
      ) {
        // Read the saved-list inventory twice before creating anything. This
        // absorbs one stale or delayed matrix snapshot without risking a
        // duplicate deterministic identity.
        await page.goto(baseUrl, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        await ensureRosterPage(page, timeout);
        await openArmyMatrix(
          page,
          input.licenseKey,
          matrixOrigin,
        );
        const refreshed = await inspectSavedListReuse(
          page,
          preparedSavedListReuse,
          timeout,
        );
        inspection = {
          player:
            inspection.player.action === "reused"
              ? inspection.player
              : refreshed.player,
          opponent:
            inspection.opponent.action === "reused"
              ? inspection.opponent
              : refreshed.opponent,
        };
      }
      if (
        inspection.player.action === "missing" ||
        inspection.opponent.action === "missing"
      ) {
        await page.goto(baseUrl, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        await ensureRosterPage(page, timeout);
        playerImport =
          inspection.player.action === "reused"
            ? reusedImport(
                preparedSavedListReuse.player.expectedUnitCount,
              )
            : await importRosz(
                page,
                input.playerRoszPath,
                "player",
                input.profilePolicy,
                playerBrowserListName,
                preparedSavedListReuse.player.expectedUnitCount,
              );
        opponentImport =
          inspection.opponent.action === "reused"
            ? reusedImport(
                preparedSavedListReuse.opponent.expectedUnitCount,
              )
            : await importRosz(
                page,
                input.opponentRoszPath,
                "opponent",
                input.profilePolicy,
                opponentBrowserListName,
                preparedSavedListReuse.opponent.expectedUnitCount,
              );
        await openArmyMatrix(
          page,
          input.licenseKey,
          matrixOrigin,
        );
      } else {
        playerImport = reusedImport(
          preparedSavedListReuse.player.expectedUnitCount,
        );
        opponentImport = reusedImport(
          preparedSavedListReuse.opponent.expectedUnitCount,
        );
      }
      savedListReuse = {
        mode: "deterministic",
        player: {
          name: playerBrowserListName,
          expectedUnitCount:
            preparedSavedListReuse.player.expectedUnitCount,
          action:
            inspection.player.action === "reused"
              ? "reused"
              : "imported",
          contentSha256:
            preparedSavedListReuse.player.contentSha256,
        },
        opponent: {
          name: opponentBrowserListName,
          expectedUnitCount:
            preparedSavedListReuse.opponent.expectedUnitCount,
          action:
            inspection.opponent.action === "reused"
              ? "reused"
              : "imported",
          contentSha256:
            preparedSavedListReuse.opponent.contentSha256,
        },
      };
    } else {
      playerImport = await importRosz(
        page,
        input.playerRoszPath,
        "player",
        input.profilePolicy,
        playerBrowserListName,
      );
      opponentImport = await importRosz(
        page,
        input.opponentRoszPath,
        "opponent",
        input.profilePolicy,
        opponentBrowserListName,
      );
      await openArmyMatrix(
        page,
        input.licenseKey,
        matrixOrigin,
      );
    }
    const playerSelection = {
      name: playerBrowserListName,
      unitCount: playerImport.unitCount,
    };
    const opponentSelection = {
      name: opponentBrowserListName,
      unitCount: opponentImport.unitCount,
    };
    try {
      await selectArmies(
        page,
        playerSelection,
        opponentSelection,
      );
    } catch (error) {
      if (
        !(error instanceof TesseraAutomationError) ||
        error.code !== "TESSERA_LIST_SELECTION_MISMATCH" ||
        !/exposed 0 exact entries/i.test(error.message)
      ) {
        throw error;
      }
      // Tessera can reopen this view with a stale saved-list snapshot. Reload
      // it once and retry the stable option values without importing again.
      await page.reload({ waitUntil: "domcontentloaded", timeout });
      await openArmyMatrix(
        page,
        input.licenseKey,
        matrixOrigin,
      );
      let recovered = false;
      let recoveryError: unknown = error;
      for (let repair = 0; repair < 2; repair += 1) {
        try {
          await selectArmies(
            page,
            playerSelection,
            opponentSelection,
          );
          recovered = true;
          break;
        } catch (nextError) {
          recoveryError = nextError;
          const missingSide =
            missingExactSelectionSide(nextError);
          if (!missingSide) throw nextError;
          await page.goto(baseUrl, {
            waitUntil: "domcontentloaded",
            timeout,
          });
          await ensureRosterPage(page, timeout);
          if (missingSide === "player") {
            playerImport = await importRosz(
              page,
              input.playerRoszPath,
              "player",
              input.profilePolicy,
              playerBrowserListName,
              playerSelection.unitCount,
            );
            if (savedListReuse) {
              savedListReuse.player.action = "imported";
            }
          } else {
            opponentImport = await importRosz(
              page,
              input.opponentRoszPath,
              "opponent",
              input.profilePolicy,
              opponentBrowserListName,
              opponentSelection.unitCount,
            );
            if (savedListReuse) {
              savedListReuse.opponent.action = "imported";
            }
          }
          await openArmyMatrix(
            page,
            input.licenseKey,
            matrixOrigin,
          );
        }
      }
      if (!recovered) throw recoveryError;
    }
    const reportedImportWarnings = (
      imported: Awaited<ReturnType<typeof importRosz>>,
    ) =>
      imported.issues.map((issue) =>
        issue.resolvedByPolicy
          ? `[TESSERA_PROFILE_POLICY_APPLIED] ${issue.unit ?? "Imported unit"}: ${issue.weaponGroup ?? "alternate weapon"} uses ${issue.selectedProfile ?? "the frozen selected profile"}.`
          : issue.message,
      );
    const importWarnings: TesseraImportWarnings = {
      player: [...new Set(reportedImportWarnings(playerImport))],
      opponent: [...new Set(reportedImportWarnings(opponentImport))],
    };
    const warnings = [
      ...importWarnings.player,
      ...importWarnings.opponent,
    ];
    await page
      .locator("table")
      .first()
      .waitFor({ state: "visible", timeout })
      .catch(() => undefined);
    if ((await extractMatrixRows(page)).length === 0) {
      throw new TesseraAutomationError(
        "TESSERA_MATRIX_MISSING",
        "Tessera accepted both armies but did not expose a result matrix.",
      );
    }
    await applyFrozenSimulationControls(
      page,
      input.frozenScenarioContract,
      timeout,
    );
    const scenarios: TesseraScenario[] = [];
    const scenarioAttempts: TesseraScenarioCaptureAttempt[] = [];
    const expectedDimensions = new Map<TesseraDirection, MatrixDimensions>();
    let matrixTrusted = true;
    let lastError: unknown;
    for (const selection of requestedScenarios(input)) {
      for (
        let attempt = 1;
        attempt <= maximumScenarioCaptureAttempts;
        attempt += 1
      ) {
        try {
          const changed = await selectScenarioControls(
            page,
            selection,
            timeout,
            !matrixTrusted,
          );
          if (changed) matrixTrusted = true;
          await confirmExclusivePressed(page, selection);
          if (!matrixTrusted) {
            throw new TesseraAutomationError(
              "TESSERA_STALE_MATRIX",
              "Tessera's result matrix is stale after a prior control transition.",
            );
          }
          const rows = await extractMatrixRows(page);
          if (rows.length === 0) {
            throw new TesseraAutomationError(
              "TESSERA_MATRIX_MISSING",
              "Tessera did not expose a result matrix for the selected scenario.",
            );
          }
          const parsed = parseScenarioMatrix(rows, selection);
          verifyDimensions(selection, parsed.dimensions, expectedDimensions);
          const settings = await extractSettings(page);
          const iterations = await extractIterations(page);
          verifyFrozenScenario(
            selection,
            settings,
            iterations,
            input.frozenScenarioContract,
          );
          scenarios.push({
            id: scenarioId(selection),
            ...selection,
            settings,
            iterations,
            cells: parsed.cells,
            matrixSha256: matrixSha256(rows),
            integrity: {
              status: "trusted",
              issueCodes: [],
              aliasedScenarioIds: [],
            },
          });
          scenarioAttempts.push({
            scenarioId: scenarioId(selection),
            attempt,
            status: "success",
            code: null,
            message: null,
            retryable: false,
            willRetry: false,
          });
          break;
        } catch (error) {
          const failure = scenarioCaptureFailure(error);
          const willRetry =
            failure.retryable &&
            attempt < maximumScenarioCaptureAttempts;
          scenarioAttempts.push({
            scenarioId: scenarioId(selection),
            attempt,
            status: "failed",
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            willRetry,
          });
          if (
            failure.code === "TESSERA_STALE_MATRIX" ||
            failure.code === "TESSERA_MATRIX_MISSING"
          ) {
            matrixTrusted = false;
          }
          if (willRetry) {
            warnings.push(
              scenarioRetryWarning(
                selection,
                failure,
                attempt,
              ),
            );
            continue;
          }
          lastError = error;
          warnings.push(scenarioFailure(selection, error, attempt));
          break;
        }
      }
    }
    // Equal-valued matrices are legitimate. Freshness is proven from a
    // matrix-scoped DOM mutation or node replacement at each control change,
    // not inferred from value inequality across captured scenarios.
    const integrityIssues: TesseraMatrixIntegrityIssue[] = [];
    if (scenarios.length === 0) {
      if (lastError instanceof TesseraAutomationError) throw lastError;
      throw new TesseraAutomationError(
        "TESSERA_UI_CHANGED",
        "Tessera did not expose a readable Army vs Army result matrix.",
      );
    }
    let legacyScenarios = scenarios.filter(
      (scenario) =>
        scenario.integrity?.status !== "aliased" &&
        scenario.phase === "shooting" &&
        scenario.metric === "wipe-probability",
    );
    if (legacyScenarios.length === 0) {
      const fallback = scenarios.find(
        (scenario) =>
          scenario.integrity?.status !== "aliased" &&
          (scenario.metric === "wipe-probability" ||
            scenario.metric === "half-wipe-probability"),
      );
      if (fallback) {
        legacyScenarios = scenarios.filter(
          (scenario) =>
            scenario.integrity?.status !== "aliased" &&
            scenario.phase === fallback.phase &&
            scenario.metric === fallback.metric,
        );
      }
    }
    const cells: TesseraMatrixCell[] = legacyScenarios.flatMap((scenario) =>
      scenario.cells.map((cell) => ({
        attacker: cell.attacker,
        target: cell.target,
        direction: cell.direction,
        killProbability: cell.metricValue,
        expectedDamage: cell.expectedDamage,
        damagePer100Points: cell.damagePer100Points,
      })),
    );
    const legacySettings =
      legacyScenarios.find(
        (scenario) => scenario.direction === "player-to-opponent",
      )?.settings ??
      legacyScenarios[0]?.settings ??
      scenarios[0].settings;
    return {
      uiIdentity: await tesseraUiIdentity(page),
      legacyProjection:
        legacyScenarios.length > 0
          ? {
              status: "derived",
              phase: legacyScenarios[0].phase,
              metric: legacyScenarios[0].metric,
              scenarioIds: legacyScenarios.map(
                (scenario) => scenario.id,
              ),
            }
          : {
              status: "unavailable",
              phase: null,
              metric: null,
              scenarioIds: [],
            },
      settings: legacySettings,
      cells,
      scenarios,
      importWarnings,
      importIssues: [
        ...playerImport.issues,
        ...opponentImport.issues,
      ],
      integrityIssues,
      scenarioAttempts,
      ...(savedListReuse ? { savedListReuse } : {}),
      warnings: [...new Set(warnings)],
    };
  } finally {
    if (!dependencies.keepContextOpen) {
      await context.close();
    }
  }
}
