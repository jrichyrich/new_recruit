import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

const cliPrefix = ["--import", "tsx", "cli/rosterpilot.ts"];
const archetypeBaselines = [
  "horde=horde.json",
  "elite=elite.json",
  "ranged-pressure=ranged-pressure.json",
  "armour-monster=armour-monster.json",
  "fast-scoring-msu=fast-scoring-msu.json",
  "melee-pressure=melee-pressure.json",
] as const;

type CliFailure = Error & {
  code?: number;
  stderr?: string;
  stdout?: string;
};

async function expectCliFailure(
  args: string[],
  expected: RegExp,
): Promise<string> {
  try {
    await run(process.execPath, [...cliPrefix, ...args], {
      cwd: process.cwd(),
    });
    assert.fail(`Expected CLI command to fail: ${args.join(" ")}`);
  } catch (error) {
    const failure = error as CliFailure;
    assert.equal(failure.code, 1);
    const diagnostic = failure.stderr ?? "";
    assert.match(diagnostic, expected);
    return diagnostic;
  }
}

function startArgs(baselines: readonly string[]): string[] {
  return [
    "tessera",
    "general-optimizer-start",
    "--file",
    "player.json",
    "--portfolio",
    "portfolio.json",
    ...baselines.flatMap((baseline) => ["--baseline", baseline]),
  ];
}

test("CLI help exposes the general-six optimizer lifecycle without replacing the original optimizer", async () => {
  const { stdout } = await run(
    process.execPath,
    [...cliPrefix, "--help"],
    { cwd: process.cwd() },
  );

  for (const command of [
    "general-optimizer-start",
    "general-optimizer-status",
    "general-optimizer-approve-candidates",
    "general-optimizer-record-comparison",
    "general-optimizer-approve-winner",
    "general-optimizer-retain-baseline",
    "general-optimizer-finalize",
  ]) {
    assert.match(stdout, new RegExp(`rosterpilot tessera ${command}`));
  }

  assert.match(
    stdout,
    /general-optimizer-start[^\n]*--portfolio[^\n]*--file|general-optimizer-start[^\n]*--file[^\n]*--portfolio/,
  );
  assert.match(
    stdout,
    /--baseline horde=horde\.json[^\n]*--baseline elite=elite\.json[^\n]*--baseline ranged-pressure=ranged\.json/,
  );
  assert.match(
    stdout,
    /general-optimizer-record-comparison[^\n]*--candidate[^\n]*--archetype[^\n]*--request-sha256[^\n]*--report/,
  );

  for (const originalCommand of [
    "optimizer-start",
    "optimizer-status",
    "optimizer-approve-candidates",
    "optimizer-record-comparison",
    "optimizer-approve-winner",
    "optimizer-retain-baseline",
    "optimizer-finalize",
  ]) {
    assert.match(
      stdout,
      new RegExp(`rosterpilot tessera ${originalCommand}`),
    );
  }
});

test("general optimizer start fails closed on incomplete and malformed baseline mappings", async () => {
  const failures = await Promise.all([
    expectCliFailure(
      startArgs(archetypeBaselines.slice(0, 5)),
      /six|6|baseline/i,
    ),
    expectCliFailure(
      startArgs([
        ...archetypeBaselines.slice(0, 5),
        "horde=duplicate-horde.json",
      ]),
      /duplicate|exactly once|horde/i,
    ),
    expectCliFailure(
      startArgs([
        ...archetypeBaselines.slice(0, 5),
        "unknown-threat=unknown.json",
      ]),
      /unknown|archetype|unknown-threat/i,
    ),
    expectCliFailure(
      startArgs([
        ...archetypeBaselines.slice(0, 5),
        "melee-pressure",
      ]),
      /archetype.*=.*report|mapping|baseline/i,
    ),
  ]);

  for (const diagnostic of failures) {
    assert.doesNotMatch(diagnostic, /ENOENT|player\.json|portfolio\.json/i);
  }
});

test("general optimizer start requires the player roster, portfolio, and six baselines", async () => {
  await Promise.all([
    expectCliFailure(
      [
        "tessera",
        "general-optimizer-start",
        "--portfolio",
        "portfolio.json",
        ...archetypeBaselines.flatMap((baseline) => [
          "--baseline",
          baseline,
        ]),
      ],
      /--file|player roster/i,
    ),
    expectCliFailure(
      [
        "tessera",
        "general-optimizer-start",
        "--file",
        "player.json",
        ...archetypeBaselines.flatMap((baseline) => [
          "--baseline",
          baseline,
        ]),
      ],
      /--portfolio/i,
    ),
    expectCliFailure(
      [
        "tessera",
        "general-optimizer-start",
        "--file",
        "player.json",
        "--portfolio",
        "portfolio.json",
      ],
      /--baseline|six|6/i,
    ),
  ]);
});

test("general optimizer lifecycle commands validate their operation-specific arguments", async () => {
  const cases: Array<{ args: string[]; expected: RegExp }> = [
    {
      args: ["tessera", "general-optimizer-status"],
      expected: /--optimizer|--state/i,
    },
    {
      args: [
        "tessera",
        "general-optimizer-approve-candidates",
        "--optimizer",
        "optimizer.json",
        "--expected-revision",
        "0",
      ],
      expected: /--candidate|--approval-id|--approved-by/i,
    },
    {
      args: [
        "tessera",
        "general-optimizer-record-comparison",
        "--optimizer",
        "optimizer.json",
        "--expected-revision",
        "2",
        "--candidate",
        "candidate-1",
      ],
      expected: /--archetype|--request-sha256|--report/i,
    },
    {
      args: [
        "tessera",
        "general-optimizer-approve-winner",
        "--optimizer",
        "optimizer.json",
        "--expected-revision",
        "8",
      ],
      expected: /--candidate|--approval-id|--approved-by/i,
    },
    {
      args: [
        "tessera",
        "general-optimizer-retain-baseline",
        "--optimizer",
        "optimizer.json",
        "--expected-revision",
        "8",
      ],
      expected: /--approval-id|--approved-by/i,
    },
    {
      args: [
        "tessera",
        "general-optimizer-finalize",
        "--optimizer",
        "optimizer.json",
        "--expected-revision",
        "9",
        "--delivery-intent",
        "deliver-new-recruit",
      ],
      expected: /--intent-id|--recorded-by/i,
    },
  ];

  const diagnostics = await Promise.all(
    cases.map(({ args, expected }) => expectCliFailure(args, expected)),
  );
  for (const diagnostic of diagnostics) {
    assert.doesNotMatch(diagnostic, /ENOENT/i);
  }
});

test("general optimizer record-comparison rejects unknown archetypes before reading artifacts", async () => {
  const diagnostic = await expectCliFailure(
    [
      "tessera",
      "general-optimizer-record-comparison",
      "--optimizer",
      "optimizer.json",
      "--expected-revision",
      "2",
      "--candidate",
      "candidate-1",
      "--archetype",
      "flying-bananas",
      "--request-sha256",
      "a".repeat(64),
      "--report",
      "comparison.json",
    ],
    /unknown|archetype|flying-bananas/i,
  );
  assert.doesNotMatch(diagnostic, /ENOENT|optimizer\.json|comparison\.json/i);
});
