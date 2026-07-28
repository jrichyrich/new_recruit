import { stat } from "node:fs/promises";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import {
  NEW_RECRUIT_MY_LISTS,
  NEW_RECRUIT_ORIGIN,
  type BrokerCredentials,
  type WorkerRequest,
  type WorkerResult,
} from "./contracts";

export class NewRecruitAutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type BrowserDependencies = {
  getCredentials: () => Promise<BrokerCredentials>;
  prepareContext?: (context: BrowserContext) => Promise<void>;
  baseUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
};

type ImportRosterResult = {
  imported: boolean;
  listUrl: string | null;
};

const listUrlPattern = /\/app\/Lists\//i;

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
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

export async function runNewRecruitAuthenticationCheck(
  profileDirectory: string,
  dependencies: Pick<BrowserDependencies, "getCredentials" | "headless">,
): Promise<{
  ok: boolean;
  sessionReused: boolean;
  code?: string;
  message?: string;
}> {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chrome",
    headless: dependencies.headless ?? false,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(NEW_RECRUIT_MY_LISTS, {
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
      NEW_RECRUIT_ORIGIN,
    );
    return { ok: true, sessionReused };
  } catch (error) {
    return {
      ok: false,
      sessionReused: false,
      code:
        error instanceof NewRecruitAutomationError
          ? error.code
          : "COMPANION_FAILED",
      message:
        error instanceof Error ? error.message : "Authentication check failed.",
    };
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
  const fileChooserPromise = page
    .waitForEvent("filechooser", { timeout: 3_000 })
    .catch(() => null);
  if (await importButton.isVisible().catch(() => false)) {
    await importButton.click();
  } else if (await importLink.isVisible().catch(() => false)) {
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

  await page.waitForTimeout(250);
  if (!listUrlPattern.test(page.url())) {
    const confirms = page.getByRole("button", {
      name: /import|upload|create/i,
    });
    for (let index = (await confirms.count()) - 1; index >= 0; index -= 1) {
      const confirm = confirms.nth(index);
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click();
        break;
      }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listUrlPattern.test(page.url())) {
      return { imported: true, listUrl: page.url() };
    }
    if ((await rosterRows.count()) > initialRosterCount) {
      const matchingRows = page
        .locator("tr.listRow")
        .filter({ hasText: rosterName });
      while (Date.now() < deadline) {
        if (listUrlPattern.test(page.url())) {
          return { imported: true, listUrl: page.url() };
        }
        const candidates =
          (await matchingRows.count()) > 0 ? matchingRows : rosterRows;
        for (
          let index = 0;
          index < (await candidates.count()) && Date.now() < deadline;
          index += 1
        ) {
          const candidate = candidates.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
          await candidate.click({ timeout: 2_000 }).catch(() => undefined);
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          const opened = await page
            .waitForURL(listUrlPattern, {
              timeout: Math.min(2_000, remainingMs),
            })
            .then(() => true)
            .catch(() => false);
          if (opened) {
            return { imported: true, listUrl: page.url() };
          }
        }
        await page.waitForTimeout(250);
      }
      return { imported: true, listUrl: null };
    }
    await page.waitForTimeout(250);
  }
  return { imported: false, listUrl: null };
}

async function verifyRoster(page: Page, expected: WorkerRequest["expected"]) {
  const body = normalized(await page.locator("body").innerText());
  const name = body.includes(normalized(expected.name));
  const faction = body.includes(normalized(expected.factionName));
  const pointPatterns = [
    `${expected.totalPoints}pts`,
    `${expected.totalPoints} pts`,
    `[${expected.totalPoints}pts]`,
  ];
  const points = pointPatterns.some((pattern) => body.includes(normalized(pattern)));
  const units = expected.units.map((unit) => {
    const unitName = normalized(unit.name);
    const matched =
      body.includes(`(${unit.modelCount}) ${unitName}`) ||
      body.includes(`${unit.modelCount}x ${unitName}`) ||
      body.includes(`${unit.modelCount} x ${unitName}`) ||
      body.includes(`${unit.modelCount} ${unitName}`) ||
      (unit.modelCount === 1 && body.includes(unitName));
    return { ...unit, matched };
  });
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

async function downloadPrettyHtml(
  context: BrowserContext,
  page: Page,
  outputPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const exportButton = page
    .getByRole("button", { name: /^export( list)?$/i })
    .first();
  const exportLink = page.getByRole("link", { name: /^export( list)?$/i }).first();
  const exportText = page.getByText(/^export( list)?$/i, { exact: true }).first();
  if (await exportButton.isVisible().catch(() => false)) await exportButton.click();
  else if (await exportLink.isVisible().catch(() => false)) await exportLink.click();
  else if (await exportText.isVisible().catch(() => false)) await exportText.click();
  else {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit Export control could not be located.",
    );
  }

  const pretty = page
    .getByRole("button", { name: /^pretty$/i })
    .or(page.getByRole("link", { name: /^pretty$/i }))
    .first();
  if (!(await pretty.isVisible().catch(() => false))) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit Pretty export control could not be located.",
    );
  }

  const popupPromise = context.waitForEvent("page", { timeout: 4_000 }).catch(() => null);
  await pretty.click();
  const prettyPage = (await popupPromise) ?? page;
  await prettyPage.waitForLoadState("domcontentloaded").catch(() => undefined);
  const save = prettyPage
    .getByRole("button", { name: /save as html/i })
    .or(prettyPage.getByRole("link", { name: /save as html/i }))
    .first();
  if (!(await save.isVisible().catch(() => false))) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit Save as HTML control could not be located.",
    );
  }
  const downloadPromise = prettyPage.waitForEvent("download", {
    timeout: timeoutMs,
  });
  await save.click();
  const download = await downloadPromise.catch(() => {
    throw new NewRecruitAutomationError(
      "DOWNLOAD_FAILED",
      "New Recruit did not start an HTML download.",
    );
  });
  await download.saveAs(outputPath);
  if ((await stat(outputPath)).size === 0) {
    throw new NewRecruitAutomationError(
      "DOWNLOAD_FAILED",
      "The downloaded New Recruit HTML file was empty.",
    );
  }
}

async function downloadEnrichedRosz(
  page: Page,
  outputPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const exportControl = page
    .getByRole("button", { name: /^export( list)?$/i })
    .or(page.getByRole("link", { name: /^export( list)?$/i }))
    .or(page.getByText(/^export( list)?$/i, { exact: true }))
    .first();
  if (!(await exportControl.isVisible().catch(() => false))) {
    throw new NewRecruitAutomationError(
      "NEW_RECRUIT_UI_CHANGED",
      "The New Recruit Export control could not be located.",
    );
  }
  await exportControl.click();
  const rosz = page
    .getByRole("button", { name: /^\.rosz$/i })
    .or(page.getByRole("link", { name: /^\.rosz$/i }))
    .or(page.getByText(/^\.rosz$/i, { exact: true }))
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

export async function runNewRecruitBrowserDelivery(
  input: WorkerRequest,
  dependencies: BrowserDependencies,
): Promise<WorkerResult> {
  const baseUrl = dependencies.baseUrl ?? NEW_RECRUIT_MY_LISTS;
  const allowedOrigin = dependencies.baseUrl
    ? new URL(dependencies.baseUrl).origin
    : NEW_RECRUIT_ORIGIN;
  const context = await chromium.launchPersistentContext(input.profileDirectory, {
    channel: "chrome",
    headless: dependencies.headless ?? false,
    acceptDownloads: true,
  });
  await dependencies.prepareContext?.(context);
  let imported = false;
  let sessionReused = true;
  let listUrl: string | null = null;
  let verification: WorkerResult["verification"] = null;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    sessionReused = await ensureAuthenticated(
      page,
      dependencies.getCredentials,
      allowedOrigin,
    );
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
        "IMPORT_FAILED",
        "New Recruit did not create a newly imported list.",
      );
    }
    if (!listUrl) {
      throw new NewRecruitAutomationError(
        "IMPORTED_LIST_NOT_OPENED",
        "New Recruit created the imported list, but the companion could not open it for verification. Do not retry the import automatically.",
      );
    }
    verification = await verifyRoster(page, input.expected);
    if (verification.mismatches.length) {
      return {
        ok: false,
        code: "VERIFICATION_FAILED",
        message: verification.mismatches.join(" "),
        imported,
        sessionReused,
        listUrl,
        enrichedRoszPath: null,
        prettyHtmlPath: null,
        verification,
      };
    }
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
    return {
      ok: true,
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
      imported,
      sessionReused,
      listUrl,
      enrichedRoszPath: null,
      prettyHtmlPath: null,
      verification,
    };
  } finally {
    await context.close();
  }
}
