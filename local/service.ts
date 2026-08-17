import path from "node:path";

import { RosterPilotService } from "../lib/rosterpilot/service";
import { rosterPilotSupportDirectory } from "./agent/paths";
import {
  getCurrentLocalDataBundleProvider,
  initializeLocalDataBundleProvider,
} from "./data-bundles/configure";
import {
  deliverRosterToNewRecruit,
  getNewRecruitConnectionStatus,
} from "./new-recruit/companion";
import { reconcileUncertainNewRecruitMutation } from "./new-recruit/cache";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
} from "./tessera/companion";
import { runRosterStressTest } from "./tessera/stress";
import {
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
  localTesseraScenarioContract,
} from "./tessera/scenario-contract";

export async function createLocalRosterPilotService(): Promise<RosterPilotService> {
  await initializeLocalDataBundleProvider();
  const service = new RosterPilotService({
    rootDirectory: path.join(rosterPilotSupportDirectory(), "lean-v1"),
    newRecruitStatus: getNewRecruitConnectionStatus,
    deliverToNewRecruit: deliverRosterToNewRecruit,
    reconcileNewRecruitMutation: async (input) => {
      await reconcileUncertainNewRecruitMutation(input);
    },
    runStress: (roster, opponentFactionId, options) =>
      runRosterStressTest(
        roster,
        { kind: "faction", factionId: opponentFactionId },
        {
          outputDirectory: options.outputDirectory,
          rootDir: options.outputDirectory,
          allowOutsideRoot: false,
          overwrite: options.overwrite,
          simulationBackend: options.backend,
          suite: options.suite,
          analysisStrategy: options.strategy,
          executionMode: "simulate",
          experimental: true,
          resumeManifestPath: options.resumeManifestPath,
          profilePolicyPath: options.profilePolicyPath,
          forceRetry: options.forceRetry,
          catalogueDriftMode: options.catalogueDriftMode,
          scenarioContract: options.backend === "local-engine"
            ? localTesseraScenarioContract(
                10_000,
                TESSERA_SCENARIO_PHASES,
                TESSERA_SCENARIO_METRICS,
              )
            : undefined,
        },
      ),
    runExactStress: (roster, opponent, options) =>
      options.baselineReportPath
        ? compareRosterRevision(
            options.baselineReportPath,
            roster,
            {
              outputDirectory: options.outputDirectory,
              rootDir: options.outputDirectory,
              allowOutsideRoot: false,
              overwrite: options.overwrite,
              simulationBackend: options.backend,
              executionMode: "simulate",
              profilePolicyPath: options.profilePolicyPath,
              allowPointMismatch: options.allowPointMismatch,
              includeChangeCandidates: false,
              providerCompatibilityMode: "observe",
              catalogueDriftMode: options.catalogueDriftMode,
            },
          )
        : analyzeRosterMatchup(
            roster,
            { kind: "roster", roster: opponent },
            {
              outputDirectory: options.outputDirectory,
              rootDir: options.outputDirectory,
              allowOutsideRoot: false,
              overwrite: options.overwrite,
              simulationBackend: options.backend,
              executionMode: "simulate",
              analysisMode: "full",
              profilePolicyPath: options.profilePolicyPath,
              allowPointMismatch: options.allowPointMismatch,
              includeChangeCandidates: true,
              providerCompatibilityMode: "observe",
              catalogueDriftMode: options.catalogueDriftMode,
              selectedPlayerAbilityIds:
                options.selectedPlayerAbilityIds,
              activationMode: options.activationMode,
              selectedAttachmentBindings:
                options.selectedAttachmentBindings,
              scenarioContract: options.backend === "local-engine"
                ? localTesseraScenarioContract(
                    10_000,
                    TESSERA_SCENARIO_PHASES,
                    TESSERA_SCENARIO_METRICS,
                  )
                : undefined,
            },
          ),
    lease: async (operation) => {
      const provider = await getCurrentLocalDataBundleProvider();
      const { withDataBundleSnapshotLease } = await import(
        "../lib/rosterpilot/data-operations"
      );
      return withDataBundleSnapshotLease(operation, provider);
    },
  });
  await service.initialize();
  return service;
}
