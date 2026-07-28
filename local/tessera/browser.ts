import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

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
};

export type TesseraScenario = {
  id: string;
  phase: TesseraPhase;
  direction: TesseraDirection;
  metric: TesseraMetric;
  settings: Record<string, string>;
  iterations: number | null;
  cells: TesseraScenarioCell[];
};

export type TesseraImportWarnings = {
  player: string[];
  opponent: string[];
};

export type TesseraBrowserResult = {
  settings: Record<string, string>;
  cells: TesseraMatrixCell[];
  scenarios: TesseraScenario[];
  importWarnings: TesseraImportWarnings;
  warnings: string[];
};

export type TesseraBrowserInput = {
  profileDirectory: string;
  playerRoszPath: string;
  playerName: string;
  opponentRoszPath: string;
  opponentName: string;
  licenseKey?: string;
  analysisMode?: TesseraAnalysisMode;
  phases?: readonly TesseraPhase[];
  metrics?: readonly TesseraMetric[];
};

export type TesseraBrowserDependencies = {
  baseUrl?: string;
  headless?: boolean;
  prepareContext?: (context: BrowserContext) => Promise<void>;
  timeoutMs?: number;
};

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

async function importRosz(page: Page, filename: string): Promise<string[]> {
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
      "TESSERA_UI_CHANGED",
      "The Tessera .rosz import control could not be located.",
    );
  }
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await importButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filename);
  await page
    .getByText("Review import", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const reviewText = await page.locator("main").innerText();
  const warnings = reviewText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /warning|alternate profile|unverified/i.test(line))
    .slice(0, 20);
  const add = page.getByRole("button", { name: /^add \d+$/i }).first();
  if (!(await add.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      "Tessera parsed the roster but did not expose its Add control.",
    );
  }
  await add.click();
  await page
    .getByRole("heading", { name: "Roster", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  return warnings;
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
      "TESSERA_PREMIUM_REJECTED",
      "Tessera did not enable its premium unlock control.",
    );
  }
  await unlock.click();
  await page.waitForTimeout(750);
  const done = page.getByRole("button", { name: /^done$/i }).first();
  if (await done.isVisible().catch(() => false)) await done.click();
  const tactica = page
    .getByRole("button", { name: /^tactica$/i })
    .first();
  if (await tactica.isVisible().catch(() => false)) await tactica.click();
}

async function openArmyMatrix(
  page: Page,
  licenseKey?: string,
  allowedOrigin = new URL(TESSERA_URL).origin,
): Promise<void> {
  const direct = page
    .getByRole("button", { name: /army (?:vs|versus) army|threat matrix/i })
    .first();
  if (await direct.isVisible().catch(() => false)) {
    const label = await direct.innerText().catch(() => "");
    if (/🔒|locked|premium/i.test(label)) {
      if (!licenseKey) {
        throw new TesseraAutomationError(
          "TESSERA_PREMIUM_REQUIRED",
          "Tessera Army vs Army requires a configured premium key.",
        );
      }
      await direct.click();
      await unlockPremium(page, licenseKey, allowedOrigin);
      return openArmyMatrix(page, undefined, allowedOrigin);
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
      "TESSERA_UI_CHANGED",
      "The Tessera Army vs Army threat matrix could not be located.",
    );
  }
  const label = await matrix.innerText().catch(() => "");
  if (/🔒|locked|premium/i.test(label)) {
    if (!licenseKey) {
      throw new TesseraAutomationError(
        "TESSERA_PREMIUM_REQUIRED",
        "Tessera Army vs Army requires a configured premium key.",
      );
    }
    await matrix.click();
    await unlockPremium(page, licenseKey, allowedOrigin);
    return openArmyMatrix(page, undefined, allowedOrigin);
  }
  await matrix.click();
}

async function selectArmies(
  page: Page,
  playerName: string,
  opponentName: string,
): Promise<void> {
  const selects = page.locator("select");
  if ((await selects.count()) < 2) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      "Tessera did not expose both army selectors.",
    );
  }

  const selectArmy = async (index: number, rosterName: string) => {
    const select = selects.nth(index);
    const options = await select.locator("option").evaluateAll((elements) =>
      elements.map((element) => ({
        label: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        value: (element as HTMLOptionElement).value,
      })),
    );
    const option = options.find((candidate) =>
      candidate.label.includes(rosterName),
    );
    if (!option) {
      throw new TesseraAutomationError(
        "TESSERA_UI_CHANGED",
        `Tessera did not list the imported army "${rosterName}".`,
      );
    }
    await select.selectOption(option.value);
  };

  await selectArmy(0, playerName);
  await selectArmy(1, opponentName);

  const run = page
    .getByRole("button", {
      name: /run|calculate|simulate|build matrix|compare lists/i,
    })
    .first();
  if (!(await run.isVisible().catch(() => false))) {
    throw new TesseraAutomationError(
      "TESSERA_UI_CHANGED",
      "Tessera did not expose its army comparison control.",
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

async function matrixFingerprint(page: Page): Promise<string> {
  const rows = await extractMatrixRows(page);
  return rows.length > 0 ? JSON.stringify(rows) : "";
}

async function matrixMutationRevision(page: Page): Promise<number> {
  return page.evaluate(() => {
    type MatrixObserverState = {
      revision: number;
      observer: MutationObserver;
      target: Element;
    };
    const scopedWindow = window as Window & {
      __rosterPilotMatrixObserver?: MatrixObserverState;
    };
    const target = document.querySelector("main") ?? document.body;
    const current = scopedWindow.__rosterPilotMatrixObserver;
    if (current?.target === target) return current.revision;
    current?.observer.disconnect();
    const state: MatrixObserverState = {
      revision: 0,
      observer: new MutationObserver(() => {
        state.revision += 1;
      }),
      target,
    };
    state.observer.observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    scopedWindow.__rosterPilotMatrixObserver = state;
    return state.revision;
  });
}

async function waitForMatrixFingerprintChange(
  page: Page,
  previous: string,
  previousRevision: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let changed = "";
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await matrixFingerprint(page);
    const revision = await matrixMutationRevision(page);
    if (
      current &&
      (current !== previous || revision > previousRevision)
    ) {
      if (current === changed) {
        stableReads += 1;
        if (stableReads >= 3) return;
      } else {
        changed = current;
        stableReads = 1;
      }
    }
    await page.waitForTimeout(50);
  }
  throw new TesseraAutomationError(
    "TESSERA_STALE_MATRIX",
    "Tessera confirmed the selected control but did not refresh the result matrix.",
  );
}

async function waitForPressed(
  page: Page,
  control: Locator,
  description: string,
  timeoutMs: number,
  requireMatrixChange: boolean,
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

  const before = await matrixFingerprint(page);
  const beforeRevision = await matrixMutationRevision(page);
  await control.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await control.getAttribute("aria-pressed").catch(() => null)) === "true") {
      if (requireMatrixChange) {
        await waitForMatrixFingerprintChange(
          page,
          before,
          beforeRevision,
          timeoutMs,
        );
      }
      return true;
    }
    await page.waitForTimeout(50);
  }
  throw new TesseraAutomationError(
    "TESSERA_UI_CHANGED",
    `Tessera did not confirm its ${description} selection.`,
  );
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
    const selected: string[] = [];
    for (const [value, control] of group.controls) {
      if (
        (await control.isVisible().catch(() => false)) &&
        (await control.getAttribute("aria-pressed").catch(() => null)) ===
          "true"
      ) {
        selected.push(value);
      }
    }
    if (selected.length !== 1 || selected[0] !== group.expected) {
      throw new TesseraAutomationError(
        "TESSERA_UI_CHANGED",
        `Tessera did not expose an exclusive aria-pressed state for ${group.expected}.`,
      );
    }
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
      (await control.getAttribute("name")) ??
      `control-${index + 1}`;
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
): string {
  const message =
    error instanceof Error ? error.message : "unknown Tessera browser failure";
  return `Scenario ${scenarioId(selection)} was not captured: ${message}`;
}

export async function runTesseraBrowserMatchup(
  input: TesseraBrowserInput,
  dependencies: TesseraBrowserDependencies = {},
): Promise<TesseraBrowserResult> {
  const context = await chromium.launchPersistentContext(input.profileDirectory, {
    channel: "chrome",
    headless: dependencies.headless ?? false,
    acceptDownloads: true,
  });
  await dependencies.prepareContext?.(context);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(dependencies.baseUrl ?? TESSERA_URL, {
      waitUntil: "domcontentloaded",
    });
    const timeout = dependencies.timeoutMs ?? 30_000;
    const rosterHeading = page.getByRole("heading", {
      name: "Roster",
      exact: true,
    });
    const onboarding = page.getByRole("button", { name: /^got it$/i }).first();
    if (!(await rosterHeading.isVisible().catch(() => false))) {
      await onboarding
        .waitFor({ state: "visible", timeout: Math.min(timeout, 5_000) })
        .catch(() => undefined);
      if (await onboarding.isVisible().catch(() => false)) {
        await onboarding.click();
      }
    }
    if (!(await rosterHeading.isVisible().catch(() => false))) {
      const muster = page
        .getByRole("button", { name: /^muster$/i })
        .first();
      await muster.waitFor({ state: "visible", timeout });
      await muster.click();
    }
    await rosterHeading.waitFor({ state: "visible", timeout });
    const importWarnings: TesseraImportWarnings = {
      player: [
        ...new Set(await importRosz(page, input.playerRoszPath)),
      ],
      opponent: [
        ...new Set(await importRosz(page, input.opponentRoszPath)),
      ],
    };
    const warnings = [
      ...importWarnings.player,
      ...importWarnings.opponent,
    ];
    await openArmyMatrix(
      page,
      input.licenseKey,
      new URL(dependencies.baseUrl ?? TESSERA_URL).origin,
    );
    await selectArmies(page, input.playerName, input.opponentName);
    await page
      .locator("table")
      .first()
      .waitFor({ state: "visible", timeout })
      .catch(() => undefined);
    const scenarios: TesseraScenario[] = [];
    const expectedDimensions = new Map<TesseraDirection, MatrixDimensions>();
    let matrixTrusted = true;
    let lastError: unknown;
    for (const selection of requestedScenarios(input)) {
      try {
        const requireChange = scenarios.length > 0;
        const changedPhase = await waitForPressed(
          page,
          phaseControl(page, selection.phase),
          `${selection.phase} phase`,
          timeout,
          requireChange,
        );
        if (changedPhase) matrixTrusted = true;
        const changedMetric = await waitForPressed(
          page,
          metricControl(page, selection.metric),
          `${selection.metric} metric`,
          timeout,
          requireChange,
        );
        if (changedMetric) matrixTrusted = true;
        const changedDirection = await waitForPressed(
          page,
          directionControl(page, selection.direction),
          `${selection.direction} direction`,
          timeout,
          requireChange,
        );
        if (changedDirection) matrixTrusted = true;
        await confirmExclusivePressed(page, selection);
        if (!matrixTrusted) {
          throw new TesseraAutomationError(
            "TESSERA_STALE_MATRIX",
            "Tessera's result matrix is stale after a prior control transition.",
          );
        }
        const parsed = parseScenarioMatrix(
          await extractMatrixRows(page),
          selection,
        );
        verifyDimensions(selection, parsed.dimensions, expectedDimensions);
        scenarios.push({
          id: scenarioId(selection),
          ...selection,
          settings: await extractSettings(page),
          iterations: await extractIterations(page),
          cells: parsed.cells,
        });
      } catch (error) {
        lastError = error;
        if (
          error instanceof TesseraAutomationError &&
          error.code === "TESSERA_STALE_MATRIX"
        ) {
          matrixTrusted = false;
        }
        warnings.push(scenarioFailure(selection, error));
      }
    }
    if (scenarios.length === 0) {
      if (lastError instanceof TesseraAutomationError) throw lastError;
      throw new TesseraAutomationError(
        "TESSERA_UI_CHANGED",
        "Tessera did not expose a readable Army vs Army result matrix.",
      );
    }
    const legacyScenarios = scenarios.filter(
      (scenario) =>
        scenario.phase === "shooting" &&
        scenario.metric === "wipe-probability",
    );
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
      settings: legacySettings,
      cells,
      scenarios,
      importWarnings,
      warnings: [...new Set(warnings)],
    };
  } finally {
    await context.close();
  }
}
