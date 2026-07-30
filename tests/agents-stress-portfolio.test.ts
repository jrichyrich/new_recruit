import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTesseraStressPortfolioContract,
  exportRoster,
  generateFactionStressPortfolio,
  rosterExecutionFingerprint,
  validateRoster,
  type TesseraStressSuite,
} from "../lib/rosterpilot";

const cases: Array<{
  pointsLimit: number;
  suite: TesseraStressSuite;
  expectedReady: number;
}> = [
  { pointsLimit: 1000, suite: "core-3", expectedReady: 3 },
  { pointsLimit: 1000, suite: "diverse-9", expectedReady: 9 },
  { pointsLimit: 2000, suite: "core-3", expectedReady: 3 },
  { pointsLimit: 2000, suite: "diverse-9", expectedReady: 9 },
];

test(
  "Agents of the Imperium builds complete exportable stress portfolios with its named Warlord anchor",
  { timeout: 300_000 },
  async () => {
    for (const testCase of cases) {
      const generated = generateFactionStressPortfolio({
        faction: "agents-of-the-imperium",
        pointsLimit: testCase.pointsLimit,
        suite: testCase.suite,
      });
      assert.equal(
        generated.ok,
        true,
        generated.violations
          .map((violation) => violation.message)
          .join("; "),
      );
      assert.ok(generated.data);

      const portfolio = generated.data;
      const contract =
        evaluateTesseraStressPortfolioContract(portfolio);
      assert.equal(contract.accepted, true);
      assert.equal(contract.maximumResultStatus, "complete");
      assert.equal(contract.completeCoverage, true);
      assert.equal(portfolio.coverage.ready, testCase.expectedReady);
      assert.equal(portfolio.coverage.unavailable, 0);
      assert.equal(portfolio.items.length, testCase.expectedReady);
      assert.deepEqual(portfolio.coverage.missingPostures, []);
      assert.equal(
        portfolio.coverage.namedCharacterCoverageStatus,
        "included",
      );
      assert.deepEqual(
        portfolio.contract?.reviewedNotApplicableTemplateIds ?? [],
        [],
      );

      const ready = portfolio.items.filter(
        (item) => item.status === "ready",
      );
      const executionFingerprints = ready.map((item) => {
        assert.ok(item.roster);
        assert.equal(item.allowNamedCharacters, true);
        assert.equal(item.containsNamedCharacter, true);
        assert.equal(validateRoster(item.roster).ok, true);
        assert.ok(
          item.roster.totalPoints >= testCase.pointsLimit * 0.95,
        );
        assert.ok(item.roster.totalPoints <= testCase.pointsLimit);
        return rosterExecutionFingerprint(item.roster);
      });
      assert.equal(
        new Set(executionFingerprints).size,
        testCase.expectedReady,
      );

      for (const item of ready) {
        assert.ok(item.roster);
        const exported = await exportRoster(item.roster, "rosz");
        assert.equal(
          exported.ok,
          true,
          exported.violations
            .map((violation) => violation.message)
            .join("; "),
        );
        assert.ok(exported.data);
      }
    }
  },
);
