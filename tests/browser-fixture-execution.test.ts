import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeBrowserFixtureRegistry,
  parseJunitTestCases,
} from "../local/certification/browser-fixture-execution";

function junit(
  testName: string,
  body = "",
): string {
  const suffix = body
    ? `>${body}</testcase>`
    : "/>";
  return `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="${testName}" time="0.125" classname="test" file="tests/fixture.test.ts"${suffix}
</testsuites>`;
}

test("JUnit browser evidence distinguishes pass, skip, and failure", () => {
  assert.deepEqual(
    parseJunitTestCases(
      `<?xml version="1.0"?><testsuites>
<testcase name="passes &amp; verifies" time="0.1" file="/fixture/pass.ts"/>
<testcase name="skips" time="0" file="/fixture/skip.ts"><skipped type="skipped" message="true"/></testcase>
<testcase name="fails" time="0.2" file="/fixture/fail.ts"><failure type="testCodeFailure">expected &quot;pass&quot;</failure></testcase>
</testsuites>`,
    ).map((result) => ({
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
    })),
    [
      {
        name: "passes & verifies",
        status: "pass",
        durationMs: 100,
      },
      { name: "skips", status: "skipped", durationMs: 0 },
      { name: "fails", status: "fail", durationMs: 200 },
    ],
  );
});

test("registered source text cannot pass without successful execution evidence", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-browser-evidence-"),
  );
  try {
    await mkdir(path.join(projectRoot, "data"));
    await mkdir(path.join(projectRoot, "tests"));
    await writeFile(
      path.join(projectRoot, "tests", "fixture.test.ts"),
      'test("registered fixture executes", () => {});\n',
    );
    const registryPath = path.join(
      projectRoot,
      "data",
      "certification-browser-fixtures.json",
    );
    await writeFile(
      registryPath,
      `${JSON.stringify({
        schemaVersion: 2,
        fixtureKind:
          "rosterpilot-browser-certification-registry",
        fixtures: [
          {
            id: "registered-fixture",
            automatedBy: "tests/fixture.test.ts",
            testName: "registered fixture executes",
          },
        ],
      })}\n`,
    );

    const passed = await executeBrowserFixtureRegistry(
      {
        projectRoot,
        registryPath,
        fixtureIds: ["registered-fixture"],
      },
      {
        run: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputExceeded: false,
          stdout: junit("registered fixture executes"),
          stderr: "",
        }),
      },
    );
    assert.equal(passed.results[0].status, "pass");
    assert.equal(passed.observations[0].file, "tests/fixture.test.ts");
    assert.match(passed.registry.sha256, /^[0-9a-f]{64}$/);
    assert.match(
      passed.sourceFiles[0].sha256,
      /^[0-9a-f]{64}$/,
    );

    const passedWithoutOptionalJunitFile =
      await executeBrowserFixtureRegistry(
        {
          projectRoot,
          registryPath,
          fixtureIds: ["registered-fixture"],
        },
        {
          run: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputExceeded: false,
            stdout: junit("registered fixture executes").replace(
              ' file="tests/fixture.test.ts"',
              "",
            ),
            stderr: "",
          }),
        },
      );
    assert.equal(passedWithoutOptionalJunitFile.results[0].status, "pass");
    assert.equal(passedWithoutOptionalJunitFile.observations[0].file, null);

    const skipped = await executeBrowserFixtureRegistry(
      {
        projectRoot,
        registryPath,
        fixtureIds: ["registered-fixture"],
      },
      {
        run: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputExceeded: false,
          stdout: junit(
            "registered fixture executes",
            '<skipped type="skipped" message="true"/>',
          ),
          stderr: "",
        }),
      },
    );
    assert.equal(skipped.results[0].status, "skipped");
    assert.equal(
      skipped.results[0].code,
      "CERTIFICATION_BROWSER_FIXTURE_SKIPPED",
    );

    const crashedAfterPass =
      await executeBrowserFixtureRegistry(
        {
          projectRoot,
          registryPath,
          fixtureIds: ["registered-fixture"],
        },
        {
          run: async () => ({
            exitCode: 1,
            signal: null,
            timedOut: false,
            outputExceeded: false,
            stdout: junit("registered fixture executes"),
            stderr: "runner failed after reporting the test",
          }),
        },
      );
    assert.equal(crashedAfterPass.results[0].status, "fail");
    assert.equal(
      crashedAfterPass.results[0].code,
      "CERTIFICATION_BROWSER_FIXTURE_RUNNER_FAILED",
    );

    const failed = await executeBrowserFixtureRegistry(
      {
        projectRoot,
        registryPath,
        fixtureIds: ["registered-fixture"],
      },
      {
        run: async () => ({
          exitCode: 1,
          signal: null,
          timedOut: false,
          outputExceeded: false,
          stdout: junit(
            "registered fixture executes",
            `<failure>expected local fixture state at ${projectRoot}</failure>`,
          ),
          stderr: "",
        }),
      },
    );
    assert.equal(failed.results[0].status, "fail");
    assert.equal(
      failed.results[0].code,
      "CERTIFICATION_BROWSER_FIXTURE_FAILED",
    );
    assert.match(
      failed.results[0].detail ?? "",
      /expected local fixture state/,
    );
    assert.doesNotMatch(
      failed.results[0].detail ?? "",
      new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      failed.results[0].detail ?? "",
      /<project-root>/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
