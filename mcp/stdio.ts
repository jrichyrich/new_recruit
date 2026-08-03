import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  previewFactionStressPortfolio,
} from "../lib/rosterpilot";
import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";
import {
  deliverRosterToNewRecruit,
  getNewRecruitConnectionStatus,
} from "../local/new-recruit/companion";
import {
  restoreNewRecruitMutationArtifactFromTesseraRun,
  inspectNewRecruitMutationReceipt,
} from "../local/new-recruit/cache";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import {
  compareRosterStressRevision,
  runRosterStressTest,
} from "../local/tessera/stress";
import {
  runTesseraProviderParityWorkflow,
} from "../local/tessera/provider-parity-workflow";
import {
  buildAndStressRosterAgainstFaction,
} from "../local/tessera/full-loop";
import {
  buildAndAnalyzeRosterMatchup,
} from "../local/tessera/exact-full-loop";
import {
  cancelTesseraRun,
  getTesseraRunStatus,
  resolveTesseraRunProfiles,
  resumeTesseraRun,
  startTesseraRun,
} from "../local/tessera/jobs";
import {
  approveAndMaterializeTesseraOptimizerCandidates,
  approveStoredTesseraOptimizerWinner,
  finalizeStoredTesseraOptimizer,
  getTesseraOptimizerStatus,
  recordStoredTesseraOptimizerComparison,
  retainStoredTesseraOptimizerBaseline,
  startTesseraOptimizer,
} from "../local/tessera/optimizer-store";
import {
  approveAndMaterializeTesseraGeneralOptimizerCandidates,
  approveStoredTesseraGeneralOptimizerWinner,
  finalizeStoredTesseraGeneralOptimizer,
  getTesseraGeneralOptimizerStatus,
  recordStoredTesseraGeneralOptimizerComparison,
  retainStoredTesseraGeneralOptimizerBaseline,
  startTesseraGeneralOptimizer,
} from "../local/tessera/general-optimizer-store";
import { getRuntimeProvenance } from "../local/runtime-provenance";
import {
  getCurrentLocalDataBundleProvider,
  initializeLocalDataBundleProvider,
} from "../local/data-bundles/configure";
import { createRosterPilotMcpServer } from "./server";
import {
  approveRosterJourneyDataMigration,
  chooseRosterJourneyAction,
  continueRosterJourneySafely,
  getRosterJourney,
  repairRosterJourneyTesseraWebCompatibility,
  startRosterJourneyRepairedTesseraWebRun,
  startRosterJourney,
} from "../local/workflow/journey";

await initializeLocalDataBundleProvider();
const server = createRosterPilotMcpServer({
  localDataUpdates: true,
  dataBundleProviderResolver: getCurrentLocalDataBundleProvider,
  runtimeProvenance: getRuntimeProvenance,
  workflowJourneys: {
    start: startRosterJourney,
    status: getRosterJourney,
    continue: continueRosterJourneySafely,
    choose: chooseRosterJourneyAction,
    repairWebCompatibility:
      repairRosterJourneyTesseraWebCompatibility,
    approveDataMigration: approveRosterJourneyDataMigration,
    startRepairedWeb: startRosterJourneyRepairedTesseraWebRun,
  },
  artifactWriter: (artifact, outputPath, overwrite) =>
    writeExportArtifact(artifact, outputPath, { overwrite }),
  handoffWriter: (artifacts, outputDirectory, overwrite) =>
    writeExportArtifacts(artifacts, outputDirectory, { overwrite }),
  newRecruitCompanion: {
    status: getNewRecruitConnectionStatus,
    inspectMutation: inspectNewRecruitMutationReceipt,
    deliver: (roster, options) =>
      deliverRosterToNewRecruit(roster, options),
  },
  tesseraCompanion: {
    status: getTesseraConnectionStatus,
    prepare: (roster, options) =>
      prepareRosterForTessera(roster, options),
    analyze: (playerRoster, opponent, options) =>
      analyzeRosterMatchup(playerRoster, opponent, options),
    buildAndAnalyze: (input, options) =>
      buildAndAnalyzeRosterMatchup(input, options),
    compare: (baselineReportPath, revisedRoster, options) =>
      compareRosterRevision(baselineReportPath, revisedRoster, options),
    stressTest: (playerRoster, opponent, options) =>
      runRosterStressTest(playerRoster, opponent, options),
    previewPortfolio: (input) =>
      previewFactionStressPortfolio(input),
    buildAndStress: (input, options) =>
      buildAndStressRosterAgainstFaction(input, options),
    compareStressRevision: (baselineReportPath, revisedRoster, options) =>
      compareRosterStressRevision(
        baselineReportPath,
        revisedRoster,
        options,
      ),
    compareProviders: (options) =>
      runTesseraProviderParityWorkflow(options),
  },
  tesseraRunJobs: {
    start: startTesseraRun,
    status: getTesseraRunStatus,
    resume: resumeTesseraRun,
    resolveProfiles: resolveTesseraRunProfiles,
    restoreNewRecruitArtifact: (roster, jobPath) =>
      restoreNewRecruitMutationArtifactFromTesseraRun({
        roster,
        jobPath,
      }),
    cancel: cancelTesseraRun,
  },
  tesseraOptimizerStore: {
    start: startTesseraOptimizer,
    status: getTesseraOptimizerStatus,
    approveCandidates:
      approveAndMaterializeTesseraOptimizerCandidates,
    recordComparison:
      recordStoredTesseraOptimizerComparison,
    approveWinner: approveStoredTesseraOptimizerWinner,
    retainBaseline: retainStoredTesseraOptimizerBaseline,
    finalize: finalizeStoredTesseraOptimizer,
  },
  tesseraGeneralOptimizerStore: {
    start: startTesseraGeneralOptimizer,
    status: getTesseraGeneralOptimizerStatus,
    approveCandidates:
      approveAndMaterializeTesseraGeneralOptimizerCandidates,
    recordComparison:
      recordStoredTesseraGeneralOptimizerComparison,
    approveWinner: approveStoredTesseraGeneralOptimizerWinner,
    retainBaseline: retainStoredTesseraGeneralOptimizerBaseline,
    finalize: finalizeStoredTesseraGeneralOptimizer,
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
