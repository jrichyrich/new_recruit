import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNewRecruitBrowserDelivery } from "../local/new-recruit/browser";

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runBrowserTests =
  process.env.ROSTERPILOT_BROWSER_TESTS === "1" && (await chromeAvailable());

async function chromeAvailable(): Promise<boolean> {
  try {
    await access(chrome);
    return true;
  } catch {
    return false;
  }
}

function fixturePage(requestUrl: string): string {
  const url = new URL(requestUrl, "http://localhost");
  const login = url.searchParams.get("login") === "1";
  const mismatch = url.searchParams.get("mismatch") === "1";
  const broken = url.searchParams.get("broken") === "1";
  const noDownload = url.searchParams.get("nodownload") === "1";
  const delayedRow = url.searchParams.get("delayedrow") === "1";
  const stuckRow = url.searchParams.get("stuckrow") === "1";
  return `<!doctype html>
<html>
<body></body>
<script>
const loginRequired = ${JSON.stringify(login)};
const mismatch = ${JSON.stringify(mismatch)};
const broken = ${JSON.stringify(broken)};
const noDownload = ${JSON.stringify(noDownload)};
const delayedRow = ${JSON.stringify(delayedRow)};
const stuckRow = ${JSON.stringify(stuckRow)};
function roster() {
  document.body.innerHTML = \`
    <h1>Custodes Mobile Strike Force</h1>
    <p>Imperium - Adeptus Custodes</p>
    <p>\${mismatch ? "980" : "990"}pts</p>
    <p>1x Blade Champion</p>
    <p>(6) Allarus Custodians</p>
    <p>(6) Agamatus Custodians</p>
    <p>1x Pallas Grav-attack</p>
    <button id="export">Export</button>\`;
  document.querySelector("#export").onclick = () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="pretty">Pretty</button>');
    document.querySelector("#pretty").onclick = () => {
      document.body.innerHTML = noDownload
        ? '<h1>Pretty roster</h1><button>Save as HTML</button>'
        : '<h1>Pretty roster</h1><a download="pretty.html" href="data:text/html,%3Ch1%3ECustodes%3C%2Fh1%3E">Save as HTML</a>';
    };
  };
}
function lists() {
  document.body.innerHTML = '<a href="/app/Profile">Profile</a>' + (broken
    ? '<h1>My Lists</h1><button>Unknown action</button>'
    : '<h1>My Lists</h1><button id="import">Import List</button><input hidden id="file" type="file"><table><tbody id="lists"></tbody></table>');
  if (broken) return;
  document.querySelector("#import").onclick = () => {
    document.querySelector("#file").hidden = false;
  };
  document.querySelector("#file").onchange = () => {
    if (delayedRow || stuckRow) {
      document.querySelector("#lists").innerHTML =
        '<tr class="listRow"><td><span>Custodes Mobile Strike Force</span></td></tr>';
      if (delayedRow) {
        setTimeout(() => {
          document.querySelector("tr.listRow").onclick = () => {
            history.pushState({}, "", "/app/Lists/fixture");
            roster();
          };
        }, 750);
      }
      return;
    }
    history.pushState({}, "", "/app/Lists/fixture");
    roster();
  };
}
if (loginRequired) {
  document.body.innerHTML = '<input name="email" type="email"><input name="password" type="password"><button id="login">Log in</button>';
  document.querySelector("#login").onclick = lists;
} else {
  lists();
}
</script>
</html>`;
}

function fixtureBrowserDependency() {
  return async (context: import("playwright-core").BrowserContext) => {
    await context.route("https://rosterpilot.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: fixturePage(route.request().url()),
      });
    });
  };
}

const expected = {
  name: "Custodes Mobile Strike Force",
  factionName: "Imperium - Adeptus Custodes",
  totalPoints: 990,
  units: [
    { name: "Blade Champion", modelCount: 1 },
    { name: "Allarus Custodians", modelCount: 6 },
    { name: "Agamatus Custodians", modelCount: 6 },
    { name: "Pallas Grav-attack", modelCount: 1 },
  ],
};

test(
  "browser companion logs in, imports, verifies, and downloads without leaking credentials",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-test-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      const prettyHtmlPath = path.join(directory, "pretty.html");
      await writeFile(roszPath, "fixture");
      const secret = "fixture-secret-never-return";
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath,
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?login=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => ({
            username: "fixture@example.test",
            password: secret,
          }),
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.imported, true);
      assert.equal(result.sessionReused, false);
      assert.deepEqual(result.verification?.mismatches, []);
      assert.match(await readFile(prettyHtmlPath, "utf8"), /Custodes/);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion reports verification differences without deleting the imported list",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-mismatch-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath: null,
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?mismatch=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error("Active sessions must not request credentials.");
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "VERIFICATION_FAILED");
      assert.equal(result.imported, true);
      assert.match(result.listUrl ?? "", /\/app\/Lists\/fixture$/);
      assert.match(result.message ?? "", /990 points/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion retries a created row until it can open and verify it",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-delayed-row-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath: null,
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?delayedrow=1",
          headless: true,
          timeoutMs: 5_000,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error("Active sessions must not request credentials.");
          },
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.imported, true);
      assert.match(result.listUrl ?? "", /\/app\/Lists\/fixture$/);
      assert.deepEqual(result.verification?.mismatches, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion reports a created list when its row cannot be opened",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-stuck-row-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath: null,
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?stuckrow=1",
          headless: true,
          timeoutMs: 750,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error("Active sessions must not request credentials.");
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "IMPORTED_LIST_NOT_OPENED");
      assert.equal(result.imported, true);
      assert.equal(result.listUrl, null);
      assert.match(result.message ?? "", /Do not retry/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion fails closed when New Recruit import controls change",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-broken-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath: null,
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?broken=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => ({
            username: "unused",
            password: "unused",
          }),
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "NEW_RECRUIT_UI_CHANGED");
      assert.equal(result.imported, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion preserves import details when Pretty HTML download times out",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-download-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          prettyHtmlPath: path.join(directory, "pretty.html"),
          expected,
        },
        {
          baseUrl: "https://rosterpilot.test/app/MyLists?nodownload=1",
          headless: true,
          timeoutMs: 500,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error("Active sessions must not request credentials.");
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "DOWNLOAD_FAILED");
      assert.equal(result.imported, true);
      assert.match(result.listUrl ?? "", /\/app\/Lists\/fixture$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
