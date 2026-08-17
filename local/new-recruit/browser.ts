import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

import {
  NEW_RECRUIT_MY_LISTS,
  NEW_RECRUIT_ORIGIN,
  type BrokerCredentials,
  type WorkerDeliveryRequest,
  type WorkerProbeResult,
  type WorkerResult,
} from "./contracts";
import {
  newRecruitUiIdentityFingerprint,
} from "./ui-identity";

export {
  newRecruitUiIdentityFingerprint,
  safeNewRecruitUiIdentity,
} from "./ui-identity";

export class NewRecruitAutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type BrowserDependencies = {
  getCredentials: () => Promise<BrokerCredentials>;
  prepareContext?: (context: BrowserContext) => Promise<void>;
  baseUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
};

export type NewRecruitBrowserSession = {
  deliver: (input: WorkerDeliveryRequest) => Promise<WorkerResult>;
  probe: () => Promise<WorkerProbeResult>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

type ImportRosterResult = {
  imported: boolean;
  listUrl: string | null;
  remoteOutcomeUnknown?: boolean;
};

const preExistingRosterRowAttribute =
  "data-rosterpilot-pre-existing-list";

function listIdentity(value: string, baseUrl = value): string | null {
  try {
    const url = new URL(value, baseUrl);
    const match = url.pathname.match(/^\/app\/Lists\/([^/]+)\/?$/i);
    return match ? `${url.origin}/app/Lists/${match[1]}` : null;
  } catch {
    return null;
  }
}

async function markPreExistingRosterRows(
  page: Page,
  rosterName: string,
): Promise<Set<string>> {
  const identities = new Set<string>();
  const semanticRows = page
    .locator("tr.listRow")
    .filter({ hasText: rosterName });
  const rows = (await semanticRows.count()) > 0
    ? semanticRows
    : page.getByText(rosterName, { exact: true });
  for (let index = 0; index < (await rows.count()); index += 1) {
    const href = await rows.nth(index).evaluate(
      (element, attribute) => {
        const row = element.matches("tr")
          ? element
          : element.closest("tr") ?? element;
        row.setAttribute(attribute, "true");
        return row
          .querySelector('a[href*="/app/Lists/"]')
          ?.getAttribute("href") ?? null;
      },
      preExistingRosterRowAttribute,
    );
    const identity = href ? listIdentity(href, page.url()) : null;
    if (identity) identities.add(identity);
  }
  return identities;
}

async function rosterRowEvidence(
  candidate: Locator,
  baseUrl: string,
): Promise<{ preExisting: boolean; identity: string | null }> {
  const evidence = await candidate.evaluate(
    (element, attribute) => {
      const row = element.matches("tr.listRow")
        ? element
        : element.closest("tr") ?? element;
      const anchor = row.querySelector('a[href*="/app/Lists/"]');
      return {
        preExisting:
          row.hasAttribute(attribute) || element.hasAttribute(attribute),
        href: anchor?.getAttribute("href") ?? null,
      };
    },
    preExistingRosterRowAttribute,
  );
  return {
    preExisting: evidence.preExisting,
    identity: evidence.href
      ? listIdentity(evidence.href, baseUrl)
      : null,
  };
}

/**
 * Wait for the possible veil overlay to disappear and then return a locator for the Export control.
 * The function respects environment-configurable timeouts.
 */
async function waitForExportControl(page: Page, timeoutMs: number = EXPORT_VEIL_WAIT_MS): Promise<Locator> {
  const veil = page.locator('.veil');
  // If a veil is present, wait for it to be hidden.
  if (await veil.isVisible().catch(() => false)) {
    await veil.waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => {});
  }
  const deadline = Date.now() + timeoutMs;
  const candidates = [
    page.getByRole('button', { name: /export/i }),
    page.getByRole('link', { name: /export/i }),
    page.locator("button:has-text('Export')"),
    page.locator("a:has-text('Export')"),
    page.locator("[aria-label*='Export' i]"),
    page.locator("[title*='Export' i]"),
    page.getByText(/^export( list)?$/i, { exact: true }),
  ];
  while (Date.now() < deadline) {
    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new NewRecruitAutomationError(
    "NEW_RECRUIT_UI_CHANGED",
    "The New Recruit Export control could not be located.",
  );
}

// Configuration defaults (can be overridden via env vars)
const EXPORT_RETRY_COUNT = Number(process.env.EXPORT_RETRY_COUNT) || 3;
const EXPORT_RETRY_DELAY_MS = Number(process.env.EXPORT_RETRY_DELAY_MS) || 2000;
const EXPORT_VEIL_WAIT_MS = Number(process.env.EXPORT_VEIL_WAIT_MS) || 10_000;

export { stopsNewRecruitBrowserSession } from "./contracts";

async function captureNewRecruitUiIdentity(
  page: Page,
): Promise<string | null> {
  try {
    const origin = new URL(page.url()).origin;
    const versionMetadata = page
      .locator('meta[name="version"], meta[name="app-version"]')
      .first();
    const declaredVersion =
      (await versionMetadata.count()) > 0
        ? await versionMetadata
            .getAttribute("content")
            .catch(() => null)
        : null;
    const scriptSources = await page
      .locator("script[src]")
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute("src") ?? "")
          .filter(Boolean),
      );
    return newRecruitUiIdentityFingerprint({
      origin,
      declaredVersion,
      scriptSources,
    });
  } catch {
    return null;
  }
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").replace(/['’]/g, "'").trim().toLocaleLowerCase();
}

export function newRecruitDisplayNames(unitName: string): string[] {
  const name = normalized(unitName);
  const names = [name];
  if (name.endsWith(" squad")) {
    names.push(`${name.slice(0, -" squad".length)}s`);
  }
  return [...new Set(names)];
}

export function newRecruitUnitLabelMatches(
  bodyText: string,
  unit: { name: string; modelCount: number },
): boolean {
  const body = normalized(bodyText);
  return newRecruitDisplayNames(unit.name).some((unitName) => (
    body.includes(`(${unit.modelCount}) ${unitName}`) ||
    body.includes(`${unit.modelCount}x ${unitName}`) ||
    body.includes(`${unit.modelCount} x ${unitName}`) ||
    body.includes(`${unit.modelCount} ${unitName}`) ||
    body.includes(`1x ${unitName}`) ||
    body.includes(`1 x ${unitName}`) ||
    body.includes(unitName)
  ));
}

async function firstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function isAuthenticatedSession(page: Page): Promise<boolean> {
  return page
    .locator('a[href$="/app/Profile"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function visibleLoginError(page: Page): Promise<string | null> {
  const messages = await page
    .locator('[role="alert"], [role="status"], .error, .alert, .notification, .toast')
    .evaluateAll((elements) =>
      elements
        .filter((element) =>
          Boolean(
            (element as HTMLElement).offsetWidth ||
              (element as HTMLElement).offsetHeight ||
              element.getClientRects().length,
          ),
        )
        .map((element) =>
          (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        )
        .filter(Boolean)
        .slice(0, 3),
    )
    .catch(() => []);
  return messages.length ? messages.join(" ").slice(0, 500) : null;
}

async function ensureAuthenticated(
  page: Page,
  getCredentials: () => Promise<BrokerCredentials>,
  allowedOrigin: string,
): Promise<boolean> {
  if (await isAuthenticatedSession(page)) return true;
  let password = await firstVisible(page, [
    'input[type="password"]',
    'input[name*="password" i]',
  ]);
  if (!password) {
    await page.goto(
      `${allowedOrigin}/app/Login?newAccount=true&returnPath=app-Lists`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => undefined);
    password = await firstVisible(page, [
      'input[type="password"]',
      'input[name*="password" i]',
    ]);
  }

  if (!password) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit login form could not be located for an unverified session.",
    );
  }
  if (new URL(page.url()).origin !== allowedOrigin) {
    throw new NewRecruitAutomationError(
      "LOGIN_ORIGIN_REJECTED",
      `Refusing to enter credentials at ${new URL(page.url()).origin}.`,
    );
  }

  const credentials = await getCredentials();
  const username = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[type="text"]',
  ]);
  if (!username) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit username field could not be located.",
    );
  }
  await username.fill(credentials.username);
  await password.fill(credentials.password);
  credentials.username = "";
  credentials.password = "";

  const submit = page
    .getByRole("button", { name: /log ?in|sign ?in|connect/i })
    .first();
  if (!(await submit.isVisible().catch(() => false))) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit login button could not be located.",
    );
  }
  const authenticationCompleted = Promise.race([
    page
      .waitForURL(
        (url) =>
          url.origin === allowedOrigin &&
          !url.pathname.toLocaleLowerCase().endsWith("/app/login"),
        { timeout: 20_000 },
      )
      .then(() => true),
    page
      .locator('a[href$="/app/Profile"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true),
    page.waitForTimeout(20_000).then(() => false),
  ]);
  await submit.click();
  if (!(await authenticationCompleted)) {
    const loginError = await visibleLoginError(page);
    throw new NewRecruitAutomationError(
      "LOGIN_FAILED",
      loginError
        ? `New Recruit rejected the login: ${loginError}`
        : "New Recruit did not complete its post-login redirect. Reconfigure the credential and try again.",
    );
  }
  if (new URL(page.url()).pathname !== "/app/MyLists") {
    await page.goto(`${allowedOrigin}/app/MyLists`, {
      waitUntil: "domcontentloaded",
    });
  }
  await page
    .getByRole("button", { name: /import/i })
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => undefined);
  if (!(await isAuthenticatedSession(page))) {
    throw new NewRecruitAutomationError(
      "LOGIN_FAILED",
      "New Recruit did not expose its authenticated Profile control after login. Reconfigure the credential and try again.",
    );
  }
  return false;
}

async function runNewRecruitAuthenticationCheckInContext(
  context: BrowserContext,
  dependencies: Pick<
    BrowserDependencies,
    "getCredentials" | "baseUrl"
  >,
): Promise<WorkerProbeResult> {
  const baseUrl = dependencies.baseUrl ?? NEW_RECRUIT_MY_LISTS;
  const allowedOrigin = dependencies.baseUrl
    ? new URL(dependencies.baseUrl).origin
    : NEW_RECRUIT_ORIGIN;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: /import/i })
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => undefined);
    const sessionReused = await ensureAuthenticated(
      page,
      dependencies.getCredentials,
      allowedOrigin,
    );
    if (new URL(page.url()).origin !== allowedOrigin) {
      throw new NewRecruitAutomationError(
        "LOGIN_ORIGIN_REJECTED",
        `New Recruit authentication completed at an unexpected origin: ${new URL(page.url()).origin}.`,
      );
    }
    const importControl = page
      .getByRole("button", { name: /import( list| roster)?/i })
      .first()
      .or(page.getByRole("link", { name: /import/i }).first());
    const importControlVisible = await importControl
      .isVisible()
      .catch(() => false);
    if (!importControlVisible) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_UI_CHANGED",
        "The authenticated New Recruit page did not expose its semantic import control.",
      );
    }
    const uiIdentity =
      await captureNewRecruitUiIdentity(page);
    if (!uiIdentity) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_UI_IDENTITY_MISSING",
        "The authenticated New Recruit page did not expose a safe UI build identity.",
      );
    }
    return {
      ok: true,
      sessionReused,
      uiIdentity,
      importControlVisible: true,
    };
  } catch (error) {
    return {
      ok: false,
      sessionReused: false,
      uiIdentity: null,
      importControlVisible: false,
      code:
        error instanceof NewRecruitAutomationError
          ? error.code
          : "COMPANION_FAILED",
      message:
        error instanceof Error ? error.message : "Authentication check failed.",
    };
  }
}

export async function runNewRecruitAuthenticationCheck(
  profileDirectory: string,
  dependencies: Pick<BrowserDependencies, "getCredentials" | "headless">,
): Promise<WorkerProbeResult> {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chrome",
    headless: false,
  });
  try {
    return await runNewRecruitAuthenticationCheckInContext(
      context,
      dependencies,
    );
  } finally {
    await context.close();
  }
}

async function importRoster(
  page: Page,
  roszPath: string,
  rosterName: string,
  timeoutMs = 30_000,
): Promise<ImportRosterResult> {
  const rosterRows = page.getByText(rosterName, { exact: true });
  const importButton = page
    .getByRole("button", { name: /import( list| roster)?/i })
    .first();
  const importLink = page.getByRole("link", { name: /import/i }).first();
  await importButton
    .or(importLink)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => undefined);
  const initialRosterCount = await rosterRows.count();
  const initialListIdentity = listIdentity(page.url());
  const preExistingListIdentities = await markPreExistingRosterRows(
    page,
    rosterName,
  );
  if (initialListIdentity) {
    preExistingListIdentities.add(initialListIdentity);
  }
  const isNewListUrl = (value: string | URL): boolean => {
    const identity = listIdentity(String(value));
    return identity !== null && !preExistingListIdentities.has(identity);
  };
  const fileChooserPromise = page
    .waitForEvent("filechooser", { timeout: 3_000 })
    .catch(() => null);
  if (await importButton.isVisible().catch(() => false)) {
    await importButton.evaluate((el) => el.setAttribute("data-rosterpilot-original", "true")).catch(() => undefined);
    await importButton.click();
  } else if (await importLink.isVisible().catch(() => false)) {
    await importLink.evaluate((el) => el.setAttribute("data-rosterpilot-original", "true")).catch(() => undefined);
    await importLink.click();
  } else {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit import control could not be located.",
    );
  }

  const fileChooser = await fileChooserPromise;
  if (fileChooser) {
    await fileChooser.setFiles(roszPath);
  } else {
    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.isVisible().catch(() => false))) {
      await fileInput
        .waitFor({ state: "attached", timeout: 8_000 })
        .catch(() => undefined);
    }
    if ((await fileInput.count()) === 0) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_UI_CHANGED",
        "The New Recruit import file field could not be located.",
      );
    }
    await fileInput.setInputFiles(roszPath);
  }

  let confirmClicked = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isNewListUrl(page.url())) {
      return { imported: true, listUrl: page.url() };
    }

    if ((await rosterRows.count()) > initialRosterCount) {
      const matchingRows = page
        .locator("tr.listRow")
        .filter({ hasText: rosterName });
      const candidates =
        (await matchingRows.count()) > 0 ? matchingRows : rosterRows;
      for (
        let index = 0;
        index < (await candidates.count()) && Date.now() < deadline;
        index += 1
      ) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const evidence = await rosterRowEvidence(candidate, page.url());
        if (
          evidence.preExisting ||
          (evidence.identity !== null &&
            preExistingListIdentities.has(evidence.identity))
        ) {
          continue;
        }
        await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
        await candidate.click({ timeout: 2_000 }).catch(() => undefined);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const opened = await page
          .waitForURL((url) => isNewListUrl(url), {
            timeout: Math.min(2_000, remainingMs),
          })
          .then(() => true)
          .catch(() => false);
        if (opened) {
          return { imported: true, listUrl: page.url() };
        }
      }
    } else if (!confirmClicked) {
      const confirms = page.getByRole("button", {
        name: /import|upload|create/i,
      });
      const count = await confirms.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        const confirm = confirms.nth(index);
        if (await confirm.isVisible().catch(() => false)) {
          const isOriginal = await confirm
            .evaluate((el) => el.hasAttribute("data-rosterpilot-original"))
            .catch(() => false);
          if (!isOriginal) {
            try {
              await confirm.click({ timeout: 2_000 });
              confirmClicked = true;
              break;
            } catch {
              // Click failed, perhaps it's disabled or not ready.
              // Do not set confirmClicked to true so we retry.
            }
          }
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return {
    imported: false,
    listUrl: null,
    remoteOutcomeUnknown: true,
  };
}

function matchRosterText(
  bodyText: string,
  expected: WorkerDeliveryRequest["expected"],
) {
  const body = normalized(bodyText);
  const name = body.includes(normalized(expected.name));
  const faction = body.includes(normalized(expected.factionName));
  const pointPatterns = [
    `${expected.totalPoints}pts`,
    `${expected.totalPoints} pts`,
    `[${expected.totalPoints}pts]`,
  ];
  const points = pointPatterns.some((pattern) => body.includes(normalized(pattern)));
  const units = expected.units.map((unit) => ({
    ...unit,
    matched: newRecruitUnitLabelMatches(body, unit),
  }));
  const mismatches: string[] = [];
  if (!name) mismatches.push(`Roster name "${expected.name}" was not found.`);
  if (!faction) mismatches.push(`Faction "${expected.factionName}" was not found.`);
  if (!points) mismatches.push(`Total ${expected.totalPoints} points was not found.`);
  for (const unit of units) {
    if (!unit.matched) {
      mismatches.push(`${unit.modelCount}x ${unit.name} was not found.`);
    }
  }
  return { name, faction, points, units, mismatches };
}

async function verifyRoster(
  page: Page,
  expected: WorkerDeliveryRequest["expected"],
) {
  let verification = matchRosterText(
    await page.locator("body").innerText(),
    expected,
  );
  const deadline = Date.now() + 2_000;
  while (verification.mismatches.length && Date.now() < deadline) {
    await page
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => undefined);
    await page.waitForTimeout(250);
    verification = matchRosterText(
      await page.locator("body").innerText(),
      expected,
    );
  }
  return verification;
}

async function downloadPrettyHtml(
  context: BrowserContext,
  page: Page,
  outputPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
   let exportControl: Locator | null = null;
   for (let attempt = 0; attempt < EXPORT_RETRY_COUNT; attempt++) {
     try {
       exportControl = await waitForExportControl(page, EXPORT_VEIL_WAIT_MS);
       await exportControl.click({ timeout: 10_000 });
       break;
     } catch {
       if (attempt === EXPORT_RETRY_COUNT - 1) {
         throw new NewRecruitAutomationError(
           "NEW_RECRUIT_UI_CHANGED",
           "The New Recruit Export control could not be clicked after retries."
         );
       }
       await page.waitForTimeout(EXPORT_RETRY_DELAY_MS);
     }
   }

  const pretty = page
    .getByText(/^pretty$/i, { exact: true })
    .first();
  try {
    await pretty.waitFor({ state: "visible", timeout: 4_000 });
  } catch {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit Pretty export control could not be located.",
    );
  }

  const popupPromise = context
    .waitForEvent("page", { timeout: Math.min(timeoutMs, 4_000) })
    .catch(() => null);
  await pretty.click();
  const prettyPage = (await popupPromise) ?? page;
  await prettyPage.waitForLoadState("domcontentloaded").catch(() => undefined);
  const html = await prettyPage.content();
  await writeFile(outputPath, html, "utf-8");
  if ((await stat(outputPath)).size === 0) {
    throw new NewRecruitAutomationError(
      "DOWNLOAD_FAILED",
      "The saved New Recruit HTML file was empty.",
    );
  }
  if (prettyPage !== page) {
    await prettyPage.close().catch(() => undefined);
  }
}

async function downloadEnrichedRosz(
  page: Page,
  outputPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  let exportControl: Locator | null = null;
  for (let attempt = 0; attempt < EXPORT_RETRY_COUNT; attempt++) {
    try {
      exportControl = await waitForExportControl(page, EXPORT_VEIL_WAIT_MS);
      await exportControl.click({ timeout: 10_000 });
      break;
    } catch {
      if (attempt === EXPORT_RETRY_COUNT - 1) {
        throw new NewRecruitAutomationError(
          "NEW_RECRUIT_UI_CHANGED",
          "The New Recruit Export control could not be clicked after retries."
        );
      }
      await page.waitForTimeout(EXPORT_RETRY_DELAY_MS);
    }
  }
  const rosz = page
    .getByText(/^\.rosz$/i, { exact: true })
    .first();
  if (!(await rosz.isVisible().catch(() => false))) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit .rosz export control could not be located.",
    );
  }
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await rosz.click();
  const download = await downloadPromise.catch(() => {
    throw new NewRecruitAutomationError(
      "DOWNLOAD_FAILED",
      "New Recruit did not start an enriched .rosz download.",
    );
  });
  await download.saveAs(outputPath);
  if ((await stat(outputPath)).size === 0) {
    throw new NewRecruitAutomationError(
      "DOWNLOAD_FAILED",
      "The downloaded New Recruit .rosz file was empty.",
    );
  }
}

async function runNewRecruitBrowserDeliveryInContext(
  input: WorkerDeliveryRequest,
  dependencies: BrowserDependencies,
  context: BrowserContext,
): Promise<WorkerResult> {
  const baseUrl = dependencies.baseUrl ?? NEW_RECRUIT_MY_LISTS;
  const allowedOrigin = dependencies.baseUrl
    ? new URL(dependencies.baseUrl).origin
    : NEW_RECRUIT_ORIGIN;
  let imported = false;
  let sessionReused = true;
  let listUrl: string | null = null;
  let uiIdentity: string | null = null;
  let verification: WorkerResult["verification"] = null;
  try {
    const page =
      context.pages().find((candidate) => !candidate.isClosed()) ??
      (await context.newPage());
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    sessionReused = await ensureAuthenticated(
      page,
      dependencies.getCredentials,
      allowedOrigin,
    );
    if (
      new URL(page.url()).origin !== allowedOrigin ||
      !(await isAuthenticatedSession(page))
    ) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_AUTHENTICATED_ORIGIN_REJECTED",
        "New Recruit did not expose authenticated My Lists at the expected origin.",
      );
    }
    uiIdentity = await captureNewRecruitUiIdentity(page);
    if (!uiIdentity) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_UI_IDENTITY_UNAVAILABLE",
        "The authenticated New Recruit UI identity could not be captured before import.",
      );
    }
    const importResult = await importRoster(
      page,
      input.roszPath,
      input.expected.name,
      dependencies.timeoutMs,
    );
    imported = importResult.imported;
    listUrl = importResult.listUrl;
    if (!imported) {
      throw new NewRecruitAutomationError(
        importResult.remoteOutcomeUnknown
          ? "IMPORT_OUTCOME_UNCERTAIN"
          : "IMPORT_FAILED",
        importResult.remoteOutcomeUnknown
          ? "The import was submitted, but New Recruit did not expose enough evidence to determine whether a list was created. Do not retry automatically."
          : "New Recruit did not create a newly imported list.",
      );
    }
    if (!listUrl) {
      throw new NewRecruitAutomationError(
        "IMPORTED_LIST_NOT_OPENED",
        "New Recruit created the imported list, but the companion could not open it for verification. Do not retry the import automatically.",
      );
    }
    verification = await verifyRoster(page, input.expected);
    if (input.enrichedRoszPath) {
      await downloadEnrichedRosz(
        page,
        input.enrichedRoszPath,
        dependencies.timeoutMs,
      );
    }
    if (input.prettyHtmlPath) {
      await downloadPrettyHtml(
        context,
        page,
        input.prettyHtmlPath,
        dependencies.timeoutMs,
      );
    }
    if (verification.mismatches.length && !input.enrichedRoszPath) {
      return {
        ok: false,
        code: "VERIFICATION_FAILED",
        message: verification.mismatches.join(" "),
        uiIdentity,
        imported,
        sessionReused,
        listUrl,
        enrichedRoszPath: null,
        prettyHtmlPath: input.prettyHtmlPath,
        verification,
      };
    }
    return {
      ok: true,
      uiIdentity,
      imported,
      sessionReused,
      listUrl,
      enrichedRoszPath: input.enrichedRoszPath ?? null,
      prettyHtmlPath: input.prettyHtmlPath,
      verification,
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof NewRecruitAutomationError
          ? error.code
          : "COMPANION_FAILED",
      message: error instanceof Error ? error.message : "Delivery failed.",
      remoteOutcomeUnknown:
        error instanceof NewRecruitAutomationError &&
        error.code === "IMPORT_OUTCOME_UNCERTAIN",
      uiIdentity,
      imported,
      sessionReused,
      listUrl,
      enrichedRoszPath: null,
      prettyHtmlPath: null,
      verification,
    };
  }
}

export function createNewRecruitBrowserSession(
  profileDirectory: string,
  dependencies: BrowserDependencies,
): NewRecruitBrowserSession {
  const normalizedProfileDirectory = path.resolve(profileDirectory);
  let context: BrowserContext | null = null;
  let contextPromise: Promise<BrowserContext> | null = null;
  let closed = false;
  let active = false;

  const browserContext = async (): Promise<BrowserContext> => {
    if (closed) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_BROWSER_SESSION_CLOSED",
        "The New Recruit browser session is closed.",
      );
    }
    if (context) return context;
    contextPromise ??= chromium
      .launchPersistentContext(normalizedProfileDirectory, {
        channel: "chrome",
        headless: false,
        acceptDownloads: true,
      })
      .then(async (created) => {
        try {
          await dependencies.prepareContext?.(created);
          context = created;
          return created;
        } catch (error) {
          await created.close().catch(() => undefined);
          throw error;
        }
      })
      .finally(() => {
        contextPromise = null;
      });
    return contextPromise;
  };

  const exclusively = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active) {
      throw new NewRecruitAutomationError(
        "BROWSER_PROFILE_BUSY",
        "The New Recruit browser session already has an active operation.",
      );
    }
    active = true;
    try {
      return await operation();
    } finally {
      active = false;
    }
  };

  const resetContext = async (): Promise<void> => {
    const pending = contextPromise;
    const current = context;
    context = null;
    contextPromise = null;
    const created = current ?? (await pending?.catch(() => null));
    context = null;
    await created?.close().catch(() => undefined);
  };

  return {
    deliver: (input) =>
      exclusively(async () => {
        if (path.resolve(input.profileDirectory) !== normalizedProfileDirectory) {
          throw new NewRecruitAutomationError(
            "NEW_RECRUIT_WORKER_SESSION_MISMATCH",
            "The persistent New Recruit browser refused a delivery for another profile.",
          );
        }
        return runNewRecruitBrowserDeliveryInContext(
          input,
          dependencies,
          await browserContext(),
        );
      }),
    probe: () =>
      exclusively(async () =>
        runNewRecruitAuthenticationCheckInContext(
          await browserContext(),
          dependencies,
        ),
      ),
    reset: () => exclusively(resetContext),
    close: async () => {
      if (closed) return;
      if (active) {
        throw new NewRecruitAutomationError(
          "BROWSER_PROFILE_BUSY",
          "The New Recruit browser session cannot close during an active operation.",
        );
      }
      closed = true;
      await resetContext();
    },
  };
}

export async function runNewRecruitBrowserDelivery(
  input: WorkerDeliveryRequest,
  dependencies: BrowserDependencies,
): Promise<WorkerResult> {
  const session = createNewRecruitBrowserSession(
    input.profileDirectory,
    dependencies,
  );
  try {
    return await session.deliver(input);
  } finally {
    await session.close();
  }
}
