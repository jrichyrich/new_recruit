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
  getConfiguredDataBundleProvider,
} from "../lib/rosterpilot/data-operations";
import {
  initializeLocalDataBundleProvider,
} from "../local/data-bundles/configure";
import { createRosterPilotMcpServer } from "./server";

await initializeLocalDataBundleProvider();
const server = createRosterPilotMcpServer({
  dataBundleProvider:
    getConfiguredDataBundleProvider() ?? undefined,
  runtimeProvenance: getRuntimeProvenance,
  artifactWriter: (artifact, outputPath, overwrite) =>
    writeExportArtifact(artifact, outputPath, { overwrite }),
  handoffWriter: (artifacts, outputDirectory, overwrite) =>
    writeExportArtifacts(artifacts, outputDirectory, { overwrite }),
  newRecruitCompanion: {
    status: getNewRecruitConnectionStatus,
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
