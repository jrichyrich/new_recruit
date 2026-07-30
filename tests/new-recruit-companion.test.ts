import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import { buildRoster } from "../lib/rosterpilot";
import { LocalAgentError } from "../local/agent/client";
import { runNewRecruitBrowserDelivery } from "../local/new-recruit/browser";
import {
  deliverRosterToNewRecruit,
  probeNewRecruitLiveUi,
} from "../local/new-recruit/companion";
import {
  newRecruitUiIdentityFingerprint,
  safeNewRecruitUiIdentity,
} from "../local/new-recruit/ui-identity";

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
  const duplicateExisting =
    url.searchParams.get("duplicate") === "1";
  const truncatedUnits =
    url.searchParams.get("truncated") === "1";
  const reorderedUnits =
    url.searchParams.get("reordered") === "1";
  const emptyDownload =
    url.searchParams.get("emptydownload") === "1";
  const enrichedXml = `<?xml version="1.0"?><roster name="Custodes Mobile Strike Force" generatedBy="https://newrecruit.eu"><cost name="pts" value="990"/><forces><force name="Imperium - Adeptus Custodes" catalogueName="Imperium - Adeptus Custodes"><selections><selection name="Blade Champion" number="1" type="model"/><selection name="Allarus Custodians" number="1" type="unit"><selections><selection name="Allarus Custodian" number="6" type="model"/></selections></selection></selections></force></forces><profiles><profile name="Blade Champion" typeName="Unit"/><profile name="Vaultswords" typeName="Melee Weapons"/></profiles></roster>`;
  const enrichedBase64 = Buffer.from(
    zipSync({ "fixture.ros": strToU8(enrichedXml) }),
  ).toString("base64");
  return `<!doctype html>
<html>
<head><meta name="app-version" content="login-shell"></head>
<body></body>
<script>
const loginRequired = ${JSON.stringify(login)};
const mismatch = ${JSON.stringify(mismatch)};
const broken = ${JSON.stringify(broken)};
const noDownload = ${JSON.stringify(noDownload)};
const delayedRow = ${JSON.stringify(delayedRow)};
const stuckRow = ${JSON.stringify(stuckRow)};
const duplicateExisting = ${JSON.stringify(duplicateExisting)};
const truncatedUnits = ${JSON.stringify(truncatedUnits)};
const reorderedUnits = ${JSON.stringify(reorderedUnits)};
const emptyDownload = ${JSON.stringify(emptyDownload)};
function roster() {
  const unitLines = [
    '<p>1x Blade Champion</p>',
    '<p>(6) Allarus Custodians</p>',
    '<p>6 Agamatus Custodians</p>',
    '<p>1x Pallas Grav-attack</p>',
  ];
  if (reorderedUnits) unitLines.reverse();
  if (truncatedUnits) {
    unitLines[0] = '<p>1x Blade Champ…</p>';
  }
  document.body.innerHTML = \`
    <h1>Custodes Mobile Strike Force</h1>
    <p>Imperium - Adeptus Custodes</p>
    <p>\${mismatch ? "980" : "990"}pts</p>
    \${unitLines.join("")}
    <button id="export">Export</button>\`;
  document.querySelector("#export").onclick = () => {
    document.body.insertAdjacentHTML("beforeend", '<a id="rosz" download="fixture.rosz" href="data:application/zip;base64,' + (emptyDownload ? '' : '${enrichedBase64}') + '">.rosz</a><button id="pretty">Pretty</button>');
    document.querySelector("#pretty").onclick = () => {
      document.body.innerHTML = noDownload
        ? '<h1>Pretty roster</h1><button>Save as HTML</button>'
        : '<h1>Pretty roster</h1><a download="pretty.html" href="data:text/html,%3Ch1%3ECustodes%3C%2Fh1%3E">Save as HTML</a>';
    };
  };
}
function lists() {
  document.querySelector('meta[name="app-version"]').content = "fixture-authenticated-v1";
  document.body.innerHTML = '<a href="/app/Profile">Profile</a>' + (broken
    ? '<h1>My Lists</h1><button>Unknown action</button>'
    : '<h1>My Lists</h1><button id="import">Import List</button><input hidden id="file" type="file"><table><tbody id="lists">' +
      (duplicateExisting ? '<tr><td><a href="/app/Lists/existing">Custodes Mobile Strike Force</a></td></tr>' : '') +
      '</tbody></table>');
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

test("New Recruit UI identity is deterministic, change-sensitive, and hash-only", () => {
  const secret = "signed-secret-that-must-not-leak";
  const input = {
    origin: "https://www.newrecruit.eu/app/MyLists?private=1",
    declaredVersion: " 2026.07.30 ",
    scriptSources: [
      `/assets/chunk.js?signature=${secret}`,
      "https://www.newrecruit.eu/assets/app.js",
      `/assets/chunk.js?signature=${secret}`,
    ],
  };
  const identity = newRecruitUiIdentityFingerprint(input);
  assert.match(identity, /^[0-9a-f]{64}$/);
  assert.equal(
    newRecruitUiIdentityFingerprint({
      ...input,
      scriptSources: [...input.scriptSources].reverse(),
    }),
    identity,
  );
  assert.notEqual(
    newRecruitUiIdentityFingerprint({
      ...input,
      declaredVersion: "2026.07.31",
    }),
    identity,
  );
  assert.notEqual(
    newRecruitUiIdentityFingerprint({
      ...input,
      origin: "https://preview.newrecruit.eu",
    }),
    identity,
  );
  const serialized = JSON.stringify({ uiIdentity: identity });
  assert.doesNotMatch(
    serialized,
    /newrecruit|chunk\.js|2026\.07\.30|signed-secret/i,
  );
  assert.equal(safeNewRecruitUiIdentity(identity), identity);
  assert.equal(
    safeNewRecruitUiIdentity(
      "https://www.newrecruit.eu/assets/app.js",
    ),
    null,
  );
  assert.equal(
    safeNewRecruitUiIdentity(identity.toUpperCase()),
    null,
  );
});

test("delivery publishes the validated source ROSZ when the local agent is unavailable", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    preferences: ["mobility"],
  });
  assert.equal(built.ok, true);
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-agent-fallback-"),
  );
  try {
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
      },
      {
        platform: "darwin",
        browserAvailable: true,
        agentDeliver: async () => {
          throw new LocalAgentError(
            "LOCAL_AGENT_UNAVAILABLE",
            "Fixture local agent unavailable.",
          );
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.data?.imported, false);
    assert.equal(result.data?.artifacts.length, 1);
    assert.equal(
      result.data?.artifacts[0].format,
      "rosterpilot-source-rosz",
    );
    await access(result.data!.artifacts[0].written);
    assert.equal(
      result.violations[0]?.code,
      "LOCAL_AGENT_UNAVAILABLE",
    );
    assert.equal(result.data?.connectorEvents?.length, 1);
    assert.equal(
      result.data?.connectorEvents?.[0]?.origin,
      "new-remote",
    );
    assert.equal(
      result.data?.connectorEvents?.[0]?.outcome,
      "uncertain",
    );
    assert.match(
      result.data?.connectorEvents?.[0]?.contentSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("New Recruit live UI probe is current, authenticated, and non-mutating", async () => {
  let probeCalls = 0;
  const success = await probeNewRecruitLiveUi({
    platform: "darwin",
    browserAvailable: true,
    agentProbe: async () => {
      probeCalls += 1;
      return {
        ok: true,
        uiIdentity: "d".repeat(64),
        sessionReused: true,
        importControlVisible: true,
      };
    },
  });
  assert.equal(success.ok, true);
  assert.equal(success.data?.uiIdentity, "d".repeat(64));
  assert.equal(success.data?.importControlVisible, true);
  assert.equal(probeCalls, 1);

  const drifted = await probeNewRecruitLiveUi({
    platform: "darwin",
    browserAvailable: true,
    agentProbe: async () => ({
      ok: true,
      uiIdentity: null,
      sessionReused: true,
      importControlVisible: false,
    }),
  });
  assert.equal(drifted.ok, false);
  assert.equal(
    drifted.violations[0]?.code,
    "NEW_RECRUIT_UI_IDENTITY_MISSING",
  );
  assert.equal(probeCalls, 1);
});

test("New Recruit catalogue drift stops before an external mutation", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const stale = structuredClone(built.data!);
  stale.sourceData.newRecruit.commit =
    "0000000000000000000000000000000000000000";
  let agentCalls = 0;
  const result = await deliverRosterToNewRecruit(
    stale,
    {
      outputDirectory: path.join(os.tmpdir(), "unused-certification"),
      allowOutsideRoot: true,
      downloadEnrichedRosz: true,
      downloadPrettyHtml: false,
    },
    {
      platform: "darwin",
      browserAvailable: true,
      agentDeliver: async () => {
        agentCalls += 1;
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.violations[0]?.code, "CATALOGUE_VERSION_CHANGED");
  assert.equal(agentCalls, 0);
});

test("an imported list with an invalid enriched archive is an uncertain non-retryable outcome", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.equal(built.ok, true);
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-invalid-enriched-"),
  );
  try {
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
      },
      {
        platform: "darwin",
        browserAvailable: true,
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "c".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/uncertain-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(
            "not-a-valid-rosz",
          ).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "ENRICHED_ROSZ_VERIFICATION_FAILED",
    );
    assert.equal(result.data?.imported, true);
    assert.equal(result.data?.uiIdentity, "c".repeat(64));
    assert.equal(result.data?.connectorEvents?.length, 1);
    assert.deepEqual(
      result.data?.connectorEvents?.map((event) => ({
        provider: event.provider,
        action: event.action,
        origin: event.origin,
        outcome: event.outcome,
      })),
      [
        {
          provider: "new-recruit",
          action: "prepare",
          origin: "new-remote",
          outcome: "uncertain",
        },
      ],
    );
    assert.match(
      result.data?.connectorEvents?.[0]?.contentSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(result.data?.diagnosticArtifacts?.length, 1);
    const diagnostic = result.data?.diagnosticArtifacts?.[0];
    assert.equal(
      diagnostic?.kind,
      "rejected-new-recruit-enriched-rosz",
    );
    assert.match(diagnostic?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(diagnostic?.path ?? "", /_diagnostics/);
    assert.equal(
      await readFile(diagnostic!.path, "utf8"),
      "not-a-valid-rosz",
    );
    assert.equal(
      result.data?.artifacts.some(
        (artifact) =>
          artifact.format === "new-recruit-enriched-rosz",
      ),
      false,
    );
    const certificationRetryable =
      !result.data?.connectorEvents?.some(
        (event) => event.outcome === "uncertain",
      );
    assert.equal(certificationRetryable, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "browser companion logs in, imports, verifies, and downloads without leaking credentials",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-test-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      const enrichedRoszPath = path.join(directory, "enriched.rosz");
      const prettyHtmlPath = path.join(directory, "pretty.html");
      await writeFile(roszPath, "fixture");
      const secret = "fixture-secret-never-return";
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          enrichedRoszPath,
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
      assert.equal(
        result.uiIdentity,
        newRecruitUiIdentityFingerprint({
          origin: "https://rosterpilot.test",
          declaredVersion: "fixture-authenticated-v1",
          scriptSources: [],
        }),
      );
      assert.deepEqual(result.verification?.mismatches, []);
      assert.ok((await readFile(enrichedRoszPath)).length > 0);
      assert.match(await readFile(prettyHtmlPath, "utf8"), /Custodes/);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-authenticated-v1|login-shell/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion creates a new list instead of replacing an existing list with the same name",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-duplicate-"),
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
          baseUrl:
            "https://rosterpilot.test/app/MyLists?duplicate=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error(
              "An authenticated session must not request credentials.",
            );
          },
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.imported, true);
      assert.match(result.listUrl ?? "", /\/app\/Lists\/fixture$/);
      assert.doesNotMatch(result.listUrl ?? "", /existing/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion rejects truncated New Recruit unit labels",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-truncated-"),
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
          baseUrl:
            "https://rosterpilot.test/app/MyLists?truncated=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error(
              "An authenticated session must not request credentials.",
            );
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "VERIFICATION_FAILED");
      assert.equal(result.imported, true);
      assert.match(result.message ?? "", /Blade Champion/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion accepts reordered New Recruit unit rows",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-reordered-"),
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
          baseUrl:
            "https://rosterpilot.test/app/MyLists?reordered=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error(
              "An authenticated session must not request credentials.",
            );
          },
        },
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.verification?.mismatches, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion rejects an empty enriched ROSZ download",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-empty-download-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      const enrichedRoszPath = path.join(
        directory,
        "enriched.rosz",
      );
      await writeFile(roszPath, "fixture");
      const result = await runNewRecruitBrowserDelivery(
        {
          action: "deliver",
          brokerPath: "/not-used",
          profileDirectory: path.join(directory, "profile"),
          roszPath,
          enrichedRoszPath,
          prettyHtmlPath: null,
          expected,
        },
        {
          baseUrl:
            "https://rosterpilot.test/app/MyLists?emptydownload=1",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            throw new Error(
              "An authenticated session must not request credentials.",
            );
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "DOWNLOAD_FAILED");
      assert.equal(result.imported, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "browser companion reuses a stale authenticated session without requesting credentials",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-session-"),
    );
    try {
      const roszPath = path.join(directory, "roster.rosz");
      await writeFile(roszPath, "fixture");
      let credentialCalls = 0;
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
          baseUrl: "https://rosterpilot.test/app/MyLists",
          headless: true,
          prepareContext: fixtureBrowserDependency(),
          getCredentials: async () => {
            credentialCalls += 1;
            throw new Error("must not be called");
          },
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.sessionReused, true);
      assert.equal(credentialCalls, 0);
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
