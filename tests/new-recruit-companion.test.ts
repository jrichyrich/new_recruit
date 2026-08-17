import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import { buildRoster, exportRoster } from "../lib/rosterpilot";
import { LocalAgentError } from "../local/agent/client";
import {
  ensureCurrentLocalAgent,
  type LifecycleResult,
} from "../local/agent/lifecycle";
import { runNewRecruitBrowserDelivery } from "../local/new-recruit/browser";
import {
  deliverRosterToNewRecruit,
  probeNewRecruitLiveUi,
} from "../local/new-recruit/companion";
import { readNewRecruitMutationReceipt } from "../local/new-recruit/cache";
import { prepareRosterForTessera } from "../local/tessera/companion";
import {
  newRecruitUiIdentityFingerprint,
  safeNewRecruitUiIdentity,
} from "../local/new-recruit/ui-identity";

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runBrowserTests =
  process.env.ROSTERPILOT_BROWSER_TESTS === "1" && (await chromeAvailable());

async function runTestProcess(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

test("Keychain broker releases credentials only to the local-agent consumer", async () => {
  const source = await readFile(
    path.resolve("native", "NewRecruitKeychainBroker.swift"),
    "utf8",
  );
  assert.match(source, /kSecReturnData/);
  assert.match(source, /ROSTERPILOT_KEYCHAIN_CONSUMER_TOKEN/);
  assert.match(source, /authorizedKeychainConsumer/);
  assert.match(source, /CREDENTIAL_RELEASE_DISABLED/);
  assert.match(
    source,
    /guard authorizedKeychainConsumer\(\) else \{\s*credentialReleaseDisabled\(provider\)/,
  );
});

test(
  "compiled Keychain broker rejects retrieve without the local-agent consumer token",
  { skip: process.platform !== "darwin" },
  async () => {
    const build = await runTestProcess(process.execPath, [
      "scripts/build-new-recruit-companion.mjs",
    ]);
    assert.equal(build.code, 0, build.stderr);
    const broker = path.resolve(
      "native",
      ".build",
      "rosterpilot-keychain",
    );
    const unauthorized = [
      undefined,
      {
        ...process.env,
        ROSTERPILOT_KEYCHAIN_CONSUMER_TOKEN: "0".repeat(64),
      },
    ];
    for (const env of unauthorized) {
      for (const provider of ["new-recruit", "tessera"] as const) {
        const result = await runTestProcess(
          broker,
          ["retrieve", provider],
          env,
        );
        assert.equal(result.code, 5, result.stderr);
        const response = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(response).sort(), ["code", "message", "ok"]);
        assert.equal(response.ok, false);
        assert.equal(response.code, "CREDENTIAL_RELEASE_DISABLED");
        assert.equal(typeof response.message, "string");
      }
    }
  },
);

test("local-agent installation always rebuilds the Keychain broker", async () => {
  const source = await readFile(
    path.resolve("local", "agent", "lifecycle.ts"),
    "utf8",
  );
  const installStart = source.indexOf("export async function installLocalAgent");
  const copyStart = source.indexOf(
    "  const broker = installedBrokerPath();",
    installStart,
  );
  assert.ok(installStart >= 0 && copyStart > installStart);
  const installPreparation = source.slice(installStart, copyStart);
  assert.doesNotMatch(
    installPreparation,
    /if \(!\(await exists\(staged\)\)\) \{\s*await run\(process\.execPath/,
  );
  assert.match(
    installPreparation,
    /await run\(process\.execPath, \[\s*path\.join\(projectRoot, "scripts", "build-new-recruit-companion\.mjs"\)/,
  );
  assert.match(source, /ensureKeychainConsumerToken/);
  assert.match(source, /ROSTERPILOT_KEYCHAIN_CONSUMER_TOKEN/);
});

test("ensure-current reinstalls even when the TypeScript agent is current", async () => {
  const current: LifecycleResult = {
    ok: true,
    installed: true,
    running: true,
    launchAgentPath: "/fixture/agent.plist",
    brokerPath: "/fixture/old-broker",
    socketPath: "/fixture/agent.sock",
  };
  let installs = 0;
  const result = await ensureCurrentLocalAgent({
    status: async () => current,
    install: async () => {
      installs += 1;
      return { ...current, brokerPath: "/fixture/rebuilt-broker" };
    },
    restart: async () => assert.fail("restart must not replace installation"),
  });
  assert.equal(installs, 1);
  assert.deepEqual(result.repairActions, ["install"]);
  assert.equal(result.brokerPath, "/fixture/rebuilt-broker");
});

test("ensure-current reinstalls a stale local agent instead of restarting", async () => {
  const stale: LifecycleResult = {
    ok: false,
    installed: true,
    running: true,
    launchAgentPath: "/fixture/agent.plist",
    brokerPath: "/fixture/old-broker",
    socketPath: "/fixture/agent.sock",
    code: "LOCAL_AGENT_RUNTIME_STALE",
    assessment: {
      current: false,
      checkoutCurrent: true,
      buildCurrent: false,
      protocolCurrent: true,
      agentRuntimeFresh: false,
      localRuntimeFresh: true,
      issues: [
        {
          code: "LOCAL_AGENT_RUNTIME_STALE",
          message: "RosterPilot source files changed after the local agent started.",
          repair: "restart",
          nextStep: 'Run "npm run rosterpilot -- agent ensure-current" from this checkout.',
        },
      ],
    },
  };
  let installs = 0;
  const result = await ensureCurrentLocalAgent({
    status: async () => stale,
    install: async () => {
      installs += 1;
      return { ...stale, ok: true, brokerPath: "/fixture/rebuilt-broker" };
    },
    restart: async () => assert.fail("restart must not replace installation"),
  });
  assert.equal(installs, 1);
  assert.deepEqual(result.repairActions, ["install"]);
  assert.equal(result.brokerPath, "/fixture/rebuilt-broker");
});

async function chromeAvailable(): Promise<boolean> {
  try {
    await access(chrome);
    return true;
  } catch {
    return false;
  }
}

async function enrichedArchiveForRoster(
  roster: NonNullable<ReturnType<typeof buildRoster>["data"]>,
  options: {
    gameSystemRevision?: number;
    catalogueId?: string;
    omitProfilesForUnit?: number;
  } = {},
): Promise<Uint8Array> {
  const exported = await exportRoster(roster, "rosz");
  assert.equal(exported.ok, true);
  assert.ok(exported.data);
  const files = unzipSync(exported.data!.content as Uint8Array);
  const entry = Object.keys(files).find((name) => /\.ros$/i.test(name));
  assert.ok(entry);
  let xml = strFromU8(files[entry!]);
  xml = xml.replace(
    /generatedBy="[^"]*"/,
    'generatedBy="https://newrecruit.eu"',
  );
  if (options.gameSystemRevision !== undefined) {
    xml = xml.replace(
      /gameSystemRevision="\d+"/,
      `gameSystemRevision="${options.gameSystemRevision}"`,
    );
  }
  if (options.catalogueId !== undefined) {
    xml = xml.replace(
      /catalogueId="[^"]+"/,
      `catalogueId="${options.catalogueId}"`,
    );
  }
  const profiles =
    '<profiles><profile name="Fixture model" typeName="Unit"/><profile name="Fixture weapon" typeName="Melee Weapons"/></profiles>';
  let selectionDepth = 0;
  let topLevelUnit = -1;
  xml = xml.replace(
    /<selection\b[^>]*>|<\/selection>/g,
    (token) => {
      if (token === "</selection>") {
        selectionDepth -= 1;
        return token;
      }
      const topLevel = selectionDepth === 0;
      const selfClosing = token.endsWith("/>");
      const topLevelRosterUnit =
        topLevel && /\btype="(?:unit|model)"/.test(token);
      if (topLevelRosterUnit) topLevelUnit += 1;
      const includeProfiles =
        topLevelRosterUnit &&
        topLevelUnit !== options.omitProfilesForUnit;
      if (selfClosing) {
        return includeProfiles
          ? `${token.slice(0, -2)}>${profiles}</selection>`
          : token;
      }
      selectionDepth += 1;
      return includeProfiles ? `${token}${profiles}` : token;
    },
  );
  files[entry!] = strToU8(xml);
  return zipSync(files);
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
function staleRoster() {
  document.body.innerHTML = \`
    <h1>Custodes Mobile Strike Force</h1>
    <p>Imperium - Adeptus Custodes</p>
    <p>500pts</p>
    <p>1x Shield-Captain</p>\`;
}
function lists() {
  document.querySelector('meta[name="app-version"]').content = "fixture-authenticated-v1";
  document.body.innerHTML = '<a href="/app/Profile">Profile</a>' + (broken
    ? '<h1>My Lists</h1><button>Unknown action</button>'
    : '<h1>My Lists</h1><button id="import">Import List</button><input hidden id="file" type="file"><table><tbody id="lists">' +
      (duplicateExisting ? '<tr class="listRow" data-existing-list><td><a href="/app/Lists/existing">Custodes Mobile Strike Force</a></td></tr>' : '') +
      '</tbody></table>');
  if (broken) return;
  const existingRow = document.querySelector('[data-existing-list]');
  if (existingRow) {
    existingRow.onclick = (event) => {
      event.preventDefault();
      history.pushState({}, "", "/app/Lists/existing");
      staleRoster();
    };
  }
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
    if (duplicateExisting) {
      document.querySelector("#lists").insertAdjacentHTML(
        "beforeend",
        '<tr class="listRow" data-new-list><td><a href="/app/Lists/fixture">Custodes Mobile Strike Force</a></td></tr>',
      );
      document.querySelector('[data-new-list]').onclick = (event) => {
        event.preventDefault();
        history.pushState({}, "", "/app/Lists/fixture");
        roster();
      };
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
        mutationReceiptMode: "external",
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
      mutationReceiptMode: "external",
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
  assert.equal(
    result.violations[0]?.code,
    "ROSTER_DATA_INTEGRITY_MISMATCH",
  );
  assert.equal(agentCalls, 0);
});

test("semantic review-required blocks export and New Recruit before mutation", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const reviewRequired = structuredClone(built.data!);
  reviewRequired.sourceData.bundleId = "9".repeat(64);
  reviewRequired.sourceData.rosterRulesHash = "8".repeat(64);
  const referencedUnit = Object.keys(
    reviewRequired.sourceData.entityHashes,
  ).find((key) => key.startsWith("unit:"));
  assert.ok(referencedUnit);
  reviewRequired.sourceData.entityHashes[referencedUnit] =
    "7".repeat(64);

  const exported = await exportRoster(reviewRequired, "rosz");
  assert.equal(exported.ok, false);
  assert.equal(exported.data, null);
  assert.ok(
    exported.violations.some(
      (issue) => issue.code === "ROSTER_DATA_REVIEW_REQUIRED",
    ),
  );

  let agentCalls = 0;
  const delivered = await deliverRosterToNewRecruit(
    reviewRequired,
    {
      outputDirectory: path.join(
        os.tmpdir(),
        "unused-review-required",
      ),
      allowOutsideRoot: true,
      downloadEnrichedRosz: true,
      downloadPrettyHtml: false,
      mutationReceiptMode: "external",
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
  assert.equal(delivered.ok, false);
  assert.equal(delivered.data, null);
  assert.ok(
    delivered.violations.some(
      (issue) => issue.code === "ROSTER_DATA_REVIEW_REQUIRED",
    ),
  );
  assert.equal(
    agentCalls,
    0,
    "review-required must fail before any remote mutation",
  );
});

test("direct New Recruit delivery accepts only a matching verified catalogue identity", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-catalogue-match-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!);
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationReceiptMode: "external",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        provisionalArtifactStore: async () => {},
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "e".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/catalogue-match-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.catalogueProvenance?.status, "matched");
    assert.equal(result.data?.connectorEvents?.[0]?.outcome, "verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing optional Pretty HTML preserves a verified New Recruit delivery", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-pretty-partial-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!);
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: true,
        mutationReceiptMode: "external",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "e".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/pretty-partial-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data?.imported, true);
    assert.equal(
      result.data?.artifacts.some(
        (artifact) => artifact.format === "new-recruit-pretty-html",
      ),
      false,
    );
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === "NEW_RECRUIT_PRETTY_HTML_UNAVAILABLE",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct New Recruit delivery rejects a verified enriched roster from a drifted live catalogue", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-catalogue-drift-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      gameSystemRevision:
        built.data!.sourceData.newRecruit.gameSystemRevision + 1,
    });
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationReceiptMode: "external",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        provisionalArtifactStore: async () => {},
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "d".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/catalogue-drift-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    );
    assert.equal(result.data?.catalogueProvenance?.status, "drift");
    assert.equal(result.data?.connectorEvents?.[0]?.outcome, "verified");
    const retainedEnriched = result.data?.artifacts.find(
      (artifact) => artifact.format === "new-recruit-enriched-rosz",
    );
    assert.ok(retainedEnriched?.written);
    assert.match(
      result.violations[0]?.message ?? "",
      new RegExp(
        retainedEnriched!.written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    assert.match(
      result.violations[0]?.message ?? "",
      /manually reviewed or imported for an explicit diagnostic/i,
    );
    assert.ok(
      result.data?.artifacts.some(
        (artifact) =>
          artifact.format === "new-recruit-enriched-rosz",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct New Recruit delivery permits verified catalogue drift only in diagnostic mode", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-catalogue-drift-diagnostic-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      gameSystemRevision:
        built.data!.sourceData.newRecruit.gameSystemRevision + 1,
    });
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationReceiptMode: "external",
        catalogueDriftMode: "diagnostic",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        provisionalArtifactStore: async () => {},
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "f".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/catalogue-drift-diagnostic-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.violations.length, 0);
    assert.equal(result.data?.catalogueProvenance?.status, "drift");
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code ===
          "TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic mode still rejects faction-catalogue drift", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-catalogue-id-drift-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      catalogueId: "unexpected-faction-catalogue",
    });
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationReceiptMode: "external",
        catalogueDriftMode: "diagnostic",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "a".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/catalogue-id-drift-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    );
    assert.equal(result.data?.catalogueProvenance?.status, "drift");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct delivery rejects a partially profiled enriched roster", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-partial-profiles-"),
  );
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      omitProfilesForUnit: 0,
    });
    const result = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationReceiptMode: "external",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        agentDeliver: async () => ({
          worker: {
            ok: true,
            uiIdentity: "b".repeat(64),
            imported: true,
            sessionReused: false,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/partial-profile-fixture",
            verification: {
              name: true,
              faction: true,
              points: true,
              units: [],
              mismatches: [],
            },
          },
          enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
        }),
      },
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "ENRICHED_ROSZ_VERIFICATION_FAILED",
    );
    assert.match(
      result.violations[0]?.message ?? "",
      /complete per-unit model\/weapon profiles/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a strict revision-drift failure is reused provisionally by a later diagnostic preparation", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Provisional reuse fixture",
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-provisional-reuse-"),
  );
  const previousSupport = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = path.join(
    directory,
    "support",
  );
  let deliveryCalls = 0;
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      gameSystemRevision:
        built.data!.sourceData.newRecruit.gameSystemRevision + 1,
    });
    const first = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: path.join(directory, "first"),
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationRunId: "provisional-first",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        runtimeIssue: () => null,
        agentDeliver: async () => {
          deliveryCalls += 1;
          return {
            worker: {
              ok: true,
              uiIdentity: "c".repeat(64),
              imported: true,
              sessionReused: false,
              listUrl:
                "https://www.newrecruit.eu/app/Lists/provisional-reuse-fixture",
              verification: {
                name: true,
                faction: true,
                points: true,
                units: [],
                mismatches: [],
              },
            },
            enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
          };
        },
      },
    );
    assert.equal(first.ok, false);
    assert.equal(
      first.violations[0]?.code,
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    );

    const diagnostic = await prepareRosterForTessera(
      built.data!,
      {
        outputDirectory: path.join(directory, "diagnostic"),
        allowOutsideRoot: true,
        mutationRunId: "provisional-second",
        catalogueDriftMode: "diagnostic",
      },
      { runtimeIssue: () => null },
    );
    assert.equal(
      diagnostic.ok,
      true,
      JSON.stringify(diagnostic.violations),
    );
    assert.equal(diagnostic.data?.cacheReused, true);
    assert.ok(
      diagnostic.warnings.some(
        (warning) =>
          warning.code === "NEW_RECRUIT_PROVISIONAL_CACHE_REUSED",
      ),
    );
    assert.equal(deliveryCalls, 1);

    const strictAgain = await prepareRosterForTessera(
      built.data!,
      {
        outputDirectory: path.join(directory, "strict-again"),
        allowOutsideRoot: true,
        mutationRunId: "provisional-third",
      },
      { runtimeIssue: () => null },
    );
    assert.equal(strictAgain.ok, false);
    assert.equal(
      strictAgain.violations[0]?.code,
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    );
    assert.equal(deliveryCalls, 1);
  } finally {
    if (previousSupport === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = previousSupport;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a created mutation recovers its retained artifacts when provisional persistence failed", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Mutation artifact recovery fixture",
  });
  assert.ok(built.data);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-mutation-recovery-"),
  );
  const previousSupport = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = path.join(
    directory,
    "support",
  );
  let agentCalls = 0;
  let fallbackDeliveryCalls = 0;
  try {
    const enriched = await enrichedArchiveForRoster(built.data!, {
      gameSystemRevision:
        built.data!.sourceData.newRecruit.gameSystemRevision + 1,
    });
    const first = await deliverRosterToNewRecruit(
      built.data!,
      {
        outputDirectory: path.join(directory, "first"),
        allowOutsideRoot: true,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        mutationRunId: "mutation-recovery-first",
      },
      {
        platform: "darwin",
        browserAvailable: true,
        runtimeIssue: () => null,
        provisionalArtifactStore: async () => {
          throw new Error("simulated provisional store failure");
        },
        agentDeliver: async () => {
          agentCalls += 1;
          return {
            worker: {
              ok: true,
              uiIdentity: "d".repeat(64),
              imported: true,
              sessionReused: false,
              listUrl:
                "https://www.newrecruit.eu/app/Lists/mutation-recovery-fixture",
              verification: {
                name: true,
                faction: true,
                points: true,
                units: [],
                mismatches: [],
              },
            },
            enrichedRoszBase64: Buffer.from(enriched).toString("base64"),
          };
        },
      },
    );
    assert.equal(first.ok, false);
    assert.equal(first.violations[0]?.code, "NEW_RECRUIT_CATALOGUE_DRIFT");
    assert.ok(
      first.warnings.some(
        (warning) =>
          warning.code === "NEW_RECRUIT_PROVISIONAL_CACHE_WRITE_FAILED",
      ),
    );
    const receipt = await readNewRecruitMutationReceipt(built.data!);
    assert.equal(receipt?.attempts[0]?.outcome, "created");
    assert.ok(receipt?.attempts[0]?.recoveryArtifact);
    assert.ok(
      receipt!.attempts[0]!.recoveryArtifact!.enrichedRoszPath.startsWith(
        path.join(
          process.env.ROSTERPILOT_SUPPORT_DIRECTORY!,
          "cache",
          "new-recruit",
          "v1",
          "mutation-artifacts",
        ),
      ),
    );
    await rm(path.join(directory, "first"), {
      recursive: true,
      force: true,
    });

    const strictRecovery = await prepareRosterForTessera(
      built.data!,
      {
        outputDirectory: path.join(directory, "strict-recovery"),
        allowOutsideRoot: true,
        mutationRunId: "mutation-recovery-strict",
      },
      {
        runtimeIssue: () => null,
        persistentCacheDelivery: true,
        deliver: async () => {
          fallbackDeliveryCalls += 1;
          throw new Error("strict recovery must happen before delivery");
        },
      },
    );
    assert.equal(strictRecovery.ok, false);
    assert.equal(
      strictRecovery.violations[0]?.code,
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    );
    assert.ok(strictRecovery.data);
    assert.match(
      strictRecovery.data!.sourceRoszSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      strictRecovery.data!.enrichedRoszSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(fallbackDeliveryCalls, 0);

    const recovered = await prepareRosterForTessera(
      { ...built.data!, name: "Renamed recovery fixture" },
      {
        outputDirectory: path.join(directory, "recovered"),
        allowOutsideRoot: true,
        mutationRunId: "mutation-recovery-second",
        catalogueDriftMode: "diagnostic",
      },
      {
        runtimeIssue: () => null,
        persistentCacheDelivery: true,
        deliver: async () => {
          fallbackDeliveryCalls += 1;
          throw new Error("recovery must happen before delivery");
        },
      },
    );
    assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
    assert.equal(recovered.data?.cacheReused, true);
    assert.equal(recovered.data?.summary.rosterName, built.data!.name);
    assert.ok(
      recovered.warnings.some(
        (warning) =>
          warning.code === "NEW_RECRUIT_MUTATION_ARTIFACT_REUSED",
      ),
    );
    assert.equal(agentCalls, 1);
    assert.equal(fallbackDeliveryCalls, 0);

    await writeFile(
      receipt!.attempts[0]!.recoveryArtifact!.enrichedRoszPath,
      Buffer.from("tampered"),
    );
    const tampered = await prepareRosterForTessera(
      built.data!,
      {
        outputDirectory: path.join(directory, "tampered"),
        allowOutsideRoot: true,
        mutationRunId: "mutation-recovery-third",
        catalogueDriftMode: "diagnostic",
      },
      {
        runtimeIssue: () => null,
        persistentCacheDelivery: true,
        deliver: async () => {
          fallbackDeliveryCalls += 1;
          throw new Error("tampered recovery must fail before delivery");
        },
      },
    );
    assert.equal(tampered.ok, false);
    assert.equal(
      tampered.violations[0]?.code,
      "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
    );
    assert.equal(fallbackDeliveryCalls, 0);
  } finally {
    if (previousSupport === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = previousSupport;
    }
    await rm(directory, { recursive: true, force: true });
  }
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
        mutationReceiptMode: "external",
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
  "browser companion ignores an initial same-name list route after import",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-browser-stale-route-"),
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
            "https://rosterpilot.test/app/Lists/existing?duplicate=1",
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
      assert.deepEqual(result.verification?.mismatches, []);
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
