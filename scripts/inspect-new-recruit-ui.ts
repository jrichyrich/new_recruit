import os from "node:os";

import { chromium } from "playwright-core";

import {
  NEW_RECRUIT_MY_LISTS,
  NEW_RECRUIT_ORIGIN,
} from "../local/new-recruit/contracts";

const profileDirectory =
  process.env.ROSTERPILOT_NEW_RECRUIT_PROFILE ??
  `${os.homedir()}/Library/Application Support/RosterPilot/NewRecruitChrome`;
const expectedRosterName = process.argv.slice(2).join(" ").trim();
const diagnosticRoszPath = process.env.ROSTERPILOT_DIAGNOSTIC_ROSZ;
const diagnosticScreenshotPath =
  process.env.ROSTERPILOT_DIAGNOSTIC_SCREENSHOT;
const inspectMenu = process.env.ROSTERPILOT_INSPECT_MENU === "1";
const inspectLogin = process.env.ROSTERPILOT_INSPECT_LOGIN === "1";

const context = await chromium.launchPersistentContext(profileDirectory, {
  channel: "chrome",
  headless: false,
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(NEW_RECRUIT_MY_LISTS, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(inspectMenu ? 8_000 : 2_000);
  if (inspectLogin) {
    await page.goto(
      `${NEW_RECRUIT_ORIGIN}/app/Login?newAccount=true&returnPath=app-Lists`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(1_000);
    const url = new URL(page.url());
    const inputs = await page.locator("input").evaluateAll((elements) =>
      elements.map((element) => ({
        type: element.getAttribute("type"),
        name: element.getAttribute("name"),
        placeholder: element.getAttribute("placeholder"),
        visible: Boolean(
          element.offsetWidth ||
            element.offsetHeight ||
            element.getClientRects().length,
        ),
      })),
    );
    const buttons = await page.getByRole("button").evaluateAll((elements) =>
      elements
        .filter((element) =>
          Boolean(
            element.offsetWidth ||
              element.offsetHeight ||
              element.getClientRects().length,
          ),
        )
        .map((element) =>
          (
            element.textContent ??
            element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    );
    const links = await page.getByRole("link").evaluateAll((elements) =>
      elements
        .filter((element) =>
          Boolean(
            element.offsetWidth ||
              element.offsetHeight ||
              element.getClientRects().length,
          ),
        )
        .map((element) => ({
          text: (
            element.textContent ??
            element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
          href: (element as HTMLAnchorElement).href,
        }))
        .filter((element) => element.text),
    );
    process.stdout.write(
      `${JSON.stringify(
        { path: url.pathname, inputs, buttons, links },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 0;
  } else {
  const url = new URL(page.url());
  const loginVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (url.origin !== NEW_RECRUIT_ORIGIN || loginVisible) {
    process.stdout.write(
      `${JSON.stringify({
        authenticated: false,
        path: url.pathname,
        message:
          "The dedicated profile requires authentication; no page content was inspected.",
      })}\n`,
    );
  } else {
    const matchingRosterLinks = expectedRosterName
      ? await page.locator("a").evaluateAll(
          (links, rosterName) =>
            links
              .filter((link) =>
                (link.textContent ?? "").includes(String(rosterName)),
              )
              .map((link) => ({
                text: (link.textContent ?? "").replace(/\s+/g, " ").trim(),
                href: (link as HTMLAnchorElement).href,
              })),
          expectedRosterName,
        )
      : [];
    const anonymousMode = await page
      .getByText(/using New Recruit without an Account/i)
      .first()
      .isVisible()
      .catch(() => false);
    const matchingRosterElements = expectedRosterName
      ? await page.getByText(expectedRosterName, { exact: true }).evaluateAll(
          (elements) =>
            elements.slice(0, 3).map((element) => {
              let current: Element | null = element;
              const ancestors: Array<{
                tag: string;
                role: string | null;
                href: string | null;
                onclick: boolean;
                className: string;
              }> = [];
              for (
                let index = 0;
                current && index < 5;
                index += 1, current = current.parentElement
              ) {
                ancestors.push({
                  tag: current.tagName.toLowerCase(),
                  role: current.getAttribute("role"),
                  href:
                    current instanceof HTMLAnchorElement ? current.href : null,
                  onclick:
                    current.hasAttribute("onclick") ||
                    typeof (current as HTMLElement).onclick === "function",
                  className:
                    typeof (current as HTMLElement).className === "string"
                      ? (current as HTMLElement).className
                      : "",
                });
              }
              return ancestors;
            }),
        )
      : [];
    const importButtons = await page.getByRole("button").evaluateAll((buttons) =>
      buttons
        .map((button) =>
          (
            button.textContent ??
            button.getAttribute("aria-label") ??
            button.getAttribute("title") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((text) => /import/i.test(text)),
    );
    const importButton = page
      .getByRole("button", { name: /import/i })
      .first();
    const fileChooserPromise = diagnosticRoszPath
      ? page
          .waitForEvent("filechooser", { timeout: 3_000 })
          .catch(() => null)
      : null;
    if (!inspectMenu && (await importButton.isVisible().catch(() => false))) {
      await importButton.click();
      await page.waitForTimeout(300);
    }
    const fileChooser = fileChooserPromise
      ? await fileChooserPromise
      : null;
    const importLinks = await page.getByRole("link").evaluateAll((links) =>
      links
        .map((link) => ({
          text: (
            link.textContent ??
            link.getAttribute("aria-label") ??
            link.getAttribute("title") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
          href: (link as HTMLAnchorElement).href,
        }))
        .filter((link) => /import/i.test(link.text)),
    );
    const fileInputs = await page
      .locator('input[type="file"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => ({
          accept: input.getAttribute("accept"),
          visible: Boolean(
            (input as HTMLElement).offsetWidth ||
              (input as HTMLElement).offsetHeight ||
              input.getClientRects().length,
          ),
        })),
      );
    const dialog = page.getByRole("dialog").first();
    const dialogText = (await dialog.isVisible().catch(() => false))
      ? (await dialog.innerText()).replace(/\s+/g, " ").trim().slice(0, 1_000)
      : null;
    const visibleButtons = await page.getByRole("button").evaluateAll((buttons) =>
      buttons
        .filter(
          (button) =>
            Boolean(
              button.offsetWidth ||
                button.offsetHeight ||
                button.getClientRects().length,
            ),
        )
        .map((button) =>
          (
            button.textContent ??
            button.getAttribute("aria-label") ??
            button.getAttribute("title") ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    );
    let postImport: Record<string, unknown> | null = null;
    if (diagnosticRoszPath) {
      if (fileChooser) {
        await fileChooser.setFiles(diagnosticRoszPath);
      } else {
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(diagnosticRoszPath);
      }
      await page
        .waitForURL(/\/app\/Lists\//i, { timeout: 30_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
      const postUrl = new URL(page.url());
      const alerts = await page
        .locator(
          '[role="alert"], [role="status"], .alert, .notification, .toast',
        )
        .evaluateAll((elements) =>
          elements
            .filter(
              (element) =>
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
            .slice(0, 10),
        );
      const postMatchingRosterLinks = expectedRosterName
        ? await page.locator("a").evaluateAll(
            (links, rosterName) =>
              links
                .filter((link) =>
                  (link.textContent ?? "").includes(String(rosterName)),
                )
                .map((link) => ({
                  text: (link.textContent ?? "").replace(/\s+/g, " ").trim(),
                  href: (link as HTMLAnchorElement).href,
                })),
            expectedRosterName,
          )
        : [];
      const visibleText = (await page.locator("body").innerText())
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(
          (line) =>
            line &&
            /error|failed|invalid|unsupported|import|\.ros|roster|custodes/i.test(
              line,
            ),
        )
        .slice(0, 30);
      if (diagnosticScreenshotPath) {
        await page.screenshot({
          path: diagnosticScreenshotPath,
          fullPage: true,
        });
      }
      postImport = {
        path: postUrl.pathname,
        imported: /\/app\/Lists\//i.test(postUrl.pathname),
        fileChooserUsed: Boolean(fileChooser),
        matchingRosterLinks: postMatchingRosterLinks,
        alerts,
        visibleText,
        screenshotWritten: Boolean(diagnosticScreenshotPath),
      };
    }
    let accountControls: Array<{ role: string; text: string; href?: string }> =
      [];
    if (inspectMenu) {
      const menu = page.getByRole("button", { name: /^menu$/i }).first();
      if (await menu.isVisible().catch(() => false)) {
        await menu.click();
        await page.waitForTimeout(300);
      }
      const buttons = await page.getByRole("button").evaluateAll((elements) =>
        elements
          .filter(
            (element) =>
              Boolean(
                element.offsetWidth ||
                  element.offsetHeight ||
                  element.getClientRects().length,
              ),
          )
          .map((element) => ({
            role: "button",
            text: (
              element.textContent ??
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          }))
          .filter((element) => /account|log|sign/i.test(element.text)),
      );
      const links = await page.getByRole("link").evaluateAll((elements) =>
        elements
          .filter(
            (element) =>
              Boolean(
                element.offsetWidth ||
                  element.offsetHeight ||
                  element.getClientRects().length,
              ),
          )
          .map((element) => ({
            role: "link",
            text: (
              element.textContent ??
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
            href: (element as HTMLAnchorElement).href,
          }))
          .filter((element) => /account|log|sign/i.test(element.text)),
      );
      accountControls = [...buttons, ...links];
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          authenticated: true,
          anonymousMode,
          path: url.pathname,
          matchingRosterLinks,
          matchingRosterElements,
          importButtons,
          importLinks,
          fileInputs,
          dialogText,
          visibleButtons,
          postImport,
          accountControls,
        },
        null,
        2,
      )}\n`,
    );
  }
  }
} finally {
  await context.close();
}
