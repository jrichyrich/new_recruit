import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getLocalAgentStatus, LocalAgentError } from "./client";
import {
  installedBrokerPath,
  launchAgentPath,
  localAgentLogDirectory,
  localAgentSpoolDirectory,
  localAgentSocketPath,
  newRecruitProfileDirectory,
  projectRoot,
  stagedBrokerPath,
} from "./paths";
import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  type LocalAgentStatus,
} from "./contracts";
import { getRuntimeProvenance } from "../runtime-provenance";
import {
  defaultLocalDataBundleEnvironment,
} from "../data-bundles/defaults";

const run = promisify(execFile);
export const LOCAL_AGENT_LABEL = "com.jasonricha.rosterpilot.agent";
const ENSURE_CURRENT_NEXT_STEP =
  'Run "npm run rosterpilot -- agent ensure-current" from this checkout.';

export type LocalAgentReadinessIssue = {
  code: string;
  message: string;
  repair: "install" | "restart" | "rerun";
  nextStep: string;
};

export type LocalAgentInstallationAssessment = {
  current: boolean;
  checkoutCurrent: boolean;
  buildCurrent: boolean;
  protocolCurrent: boolean;
  agentRuntimeFresh: boolean;
  localRuntimeFresh: boolean;
  issues: LocalAgentReadinessIssue[];
};

export type LifecycleResult = {
  ok: boolean;
  installed: boolean;
  running: boolean;
  brokerChanged?: boolean;
  credentialReauthorizationRequired?: boolean;
  installationCurrent?: boolean;
  launchAgentPath: string;
  brokerPath: string;
  socketPath: string;
  status?: LocalAgentStatus;
  assessment?: LocalAgentInstallationAssessment;
  initialIssues?: LocalAgentReadinessIssue[];
  repairActions?: Array<"install" | "restart">;
  nextSteps?: string[];
  code?: string;
  message?: string;
};

export function assessLocalAgentInstallation(
  status: LocalAgentStatus,
  options: {
    expectedProjectDirectory?: string;
    currentRuntime?: ReturnType<typeof getRuntimeProvenance>;
  } = {},
): LocalAgentInstallationAssessment {
  const expectedProjectDirectory =
    options.expectedProjectDirectory ?? projectRoot;
  const currentRuntime = options.currentRuntime ?? getRuntimeProvenance();
  const checkoutCurrent =
    status.projectDirectory === expectedProjectDirectory;
  const protocolCurrent =
    status.protocolCompatible &&
    status.protocolVersion === LOCAL_AGENT_PROTOCOL_VERSION;
  const buildCurrent =
    Boolean(status.runtime) &&
    status.runtime?.buildId === currentRuntime.buildId;
  const agentRuntimeFresh =
    Boolean(status.runtime) && status.runtime?.stale === false;
  const localRuntimeFresh = currentRuntime.stale === false;
  const issues: LocalAgentReadinessIssue[] = [];

  if (!checkoutCurrent) {
    issues.push({
      code: "LOCAL_AGENT_CHECKOUT_MISMATCH",
      message: `The running local agent belongs to ${status.projectDirectory}, not ${expectedProjectDirectory}.`,
      repair: "install",
      nextStep: ENSURE_CURRENT_NEXT_STEP,
    });
  }
  if (!protocolCurrent) {
    issues.push({
      code: "LOCAL_AGENT_PROTOCOL_MISMATCH",
      message: `The running local agent uses protocol ${status.protocolVersion}; this checkout requires protocol ${LOCAL_AGENT_PROTOCOL_VERSION}.`,
      repair: checkoutCurrent ? "restart" : "install",
      nextStep: ENSURE_CURRENT_NEXT_STEP,
    });
  }
  if (!status.runtime) {
    issues.push({
      code: "LOCAL_AGENT_BUILD_UNKNOWN",
      message:
        "The running local agent did not report build provenance, so its source cannot be verified.",
      repair: checkoutCurrent ? "restart" : "install",
      nextStep: ENSURE_CURRENT_NEXT_STEP,
    });
  } else {
    if (!agentRuntimeFresh) {
      issues.push({
        code: "LOCAL_AGENT_RUNTIME_STALE",
        message:
          "RosterPilot source files changed after the local agent started.",
        repair: "restart",
        nextStep: ENSURE_CURRENT_NEXT_STEP,
      });
    }
    if (!buildCurrent) {
      issues.push({
        code: "LOCAL_AGENT_BUILD_MISMATCH",
        message: `The running local-agent build (${status.runtime.buildId}) does not match this checkout (${currentRuntime.buildId}).`,
        repair: checkoutCurrent ? "restart" : "install",
        nextStep: ENSURE_CURRENT_NEXT_STEP,
      });
    }
  }
  if (!localRuntimeFresh) {
    issues.push({
      code: "LOCAL_RUNTIME_STALE",
      message:
        "RosterPilot source files changed after this command started, so the current build comparison is no longer stable.",
      repair: "rerun",
      nextStep: "Rerun the command from the current checkout.",
    });
  }

  return {
    current:
      checkoutCurrent &&
      protocolCurrent &&
      buildCurrent &&
      agentRuntimeFresh &&
      localRuntimeFresh,
    checkoutCurrent,
    buildCurrent,
    protocolCurrent,
    agentRuntimeFresh,
    localRuntimeFresh,
    issues,
  };
}

function assessmentNextSteps(
  assessment: LocalAgentInstallationAssessment,
): string[] {
  return [...new Set(assessment.issues.map((issue) => issue.nextStep))];
}

function primaryAssessmentIssue(
  assessment: LocalAgentInstallationAssessment,
): LocalAgentReadinessIssue | undefined {
  return assessment.issues[0];
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function digest(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(options: {
  nodeExecutable: string;
  projectDirectory: string;
  brokerPath: string;
  socketPath: string;
  profileDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  dataProviderMode?: "local-source" | "signed-channel";
  dataChannelUrl?: string;
  dataTrustedKeysFile?: string;
  bootstrapDataBundleDirectory?: string;
}): string {
  const loader = path.join(
    options.projectDirectory,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  const server = path.join(
    options.projectDirectory,
    "local",
    "agent",
    "server.ts",
  );
  const argumentsXml = [
    options.nodeExecutable,
    "--import",
    loader,
    server,
  ]
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  const dataBundle = defaultLocalDataBundleEnvironment(
    options.projectDirectory,
  );
  const bootstrapEnvironment = options.bootstrapDataBundleDirectory
    ? `
      <key>ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY</key>
      <string>${xml(options.bootstrapDataBundleDirectory)}</string>`
    : "";
  const signedChannelEnvironment =
    (options.dataProviderMode ?? dataBundle.providerMode) ===
    "signed-channel"
      ? `
      <key>ROSTERPILOT_DATA_CHANNEL_URL</key>
      <string>${xml(options.dataChannelUrl ?? dataBundle.channelUrl ?? "")}</string>
      <key>ROSTERPILOT_DATA_TRUSTED_KEYS_FILE</key>
      <string>${xml(options.dataTrustedKeysFile ?? dataBundle.trustedKeysFile)}</string>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LOCAL_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(options.projectDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ROSTERPILOT_KEYCHAIN_BROKER</key>
      <string>${xml(options.brokerPath)}</string>
      <key>ROSTERPILOT_LOCAL_AGENT_SOCKET</key>
      <string>${xml(options.socketPath)}</string>
      <key>ROSTERPILOT_NEW_RECRUIT_PROFILE</key>
      <string>${xml(options.profileDirectory)}</string>
      <key>ROSTERPILOT_DATA_PROVIDER_MODE</key>
      <string>${xml(options.dataProviderMode ?? dataBundle.providerMode)}</string>${signedChannelEnvironment}
${bootstrapEnvironment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(options.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.stderrPath)}</string>
  </dict>
</plist>
`;
}

async function launchctl(
  args: string[],
  allowFailure = false,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("/bin/launchctl", args, { encoding: "utf8" });
  } catch (error) {
    if (allowFailure) return { stdout: "", stderr: "" };
    throw error;
  }
}

function launchDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

// Loading and re-verifying a large locally built bundle can take well over a
// minute on first start. Lifecycle commands must wait for the same bounded
// startup window as ordinary agent clients instead of reporting a false
// failure while launchd is still initializing the healthy process.
async function waitForStatus(
  timeoutMs = 5 * 60_000,
): Promise<LocalAgentStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getLocalAgentStatus({ timeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The RosterPilot local agent did not start.");
}

export async function installLocalAgent(): Promise<LifecycleResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      installed: false,
      running: false,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      code: "UNSUPPORTED_PLATFORM",
      message: "The RosterPilot local agent requires macOS.",
    };
  }
  const staged = stagedBrokerPath();
  if (!(await exists(staged))) {
    await run(process.execPath, [
      path.join(projectRoot, "scripts", "build-new-recruit-companion.mjs"),
    ]);
  }
  const broker = installedBrokerPath();
  const brokerDirectory = path.dirname(broker);
  const logs = localAgentLogDirectory();
  const plist = launchAgentPath();
  await mkdir(brokerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plist), { recursive: true, mode: 0o700 });

  const brokerChanged =
    !(await exists(broker)) || (await digest(staged)) !== (await digest(broker));
  if (brokerChanged) {
    const temporaryBroker = `${broker}.installing`;
    await copyFile(staged, temporaryBroker);
    await chmod(temporaryBroker, 0o700);
    await rename(temporaryBroker, broker);
  }

  const dataBundle = defaultLocalDataBundleEnvironment(projectRoot);
  const bootstrapDataBundleDirectory =
    process.env.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY ??
    ((await exists(dataBundle.bootstrapDirectory))
      ? dataBundle.bootstrapDirectory
      : undefined);
  const plistContent = renderLaunchAgent({
    nodeExecutable: process.execPath,
    projectDirectory: projectRoot,
    brokerPath: broker,
    socketPath: localAgentSocketPath(),
    profileDirectory: newRecruitProfileDirectory(),
    stdoutPath: path.join(logs, "agent.stdout.log"),
    stderrPath: path.join(logs, "agent.stderr.log"),
    bootstrapDataBundleDirectory,
  });
  await writeFile(plist, plistContent, { mode: 0o600 });
  await launchctl(["bootout", launchDomain(), plist], true);
  await launchctl(["bootstrap", launchDomain(), plist]);
  await launchctl([
    "kickstart",
    "-k",
    `${launchDomain()}/${LOCAL_AGENT_LABEL}`,
  ]);
  try {
    const status = await waitForStatus();
    const assessment = assessLocalAgentInstallation(status);
    const issue = primaryAssessmentIssue(assessment);
    const credentialReady =
      status.providers.find(
        (provider) => provider.providerId === "new-recruit",
      )?.credentialState === "ready";
    return {
      ok: assessment.current,
      installed: true,
      running: true,
      installationCurrent: assessment.checkoutCurrent,
      brokerChanged,
      credentialReauthorizationRequired: brokerChanged && !credentialReady,
      launchAgentPath: plist,
      brokerPath: broker,
      socketPath: localAgentSocketPath(),
      status,
      assessment,
      nextSteps: assessmentNextSteps(assessment),
      code: issue?.code,
      message: issue?.message,
    };
  } catch (error) {
    return {
      ok: false,
      installed: true,
      running: false,
      brokerChanged,
      credentialReauthorizationRequired: brokerChanged,
      launchAgentPath: plist,
      brokerPath: broker,
      socketPath: localAgentSocketPath(),
      code:
        error instanceof LocalAgentError
          ? error.code
          : "LOCAL_AGENT_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "The RosterPilot local agent did not start.",
    };
  }
}

export async function getLocalAgentLifecycleStatus(): Promise<LifecycleResult> {
  const installed =
    (await exists(launchAgentPath())) && (await exists(installedBrokerPath()));
  try {
    const status = await getLocalAgentStatus({ timeoutMs: 2_000 });
    const assessment = assessLocalAgentInstallation(status);
    const issue = primaryAssessmentIssue(assessment);
    return {
      ok: assessment.current,
      installed,
      running: true,
      installationCurrent: assessment.checkoutCurrent,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      status,
      assessment,
      nextSteps: assessmentNextSteps(assessment),
      code: issue?.code,
      message: issue?.message,
    };
  } catch (error) {
    return {
      ok: false,
      installed,
      running: false,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      code:
        error instanceof LocalAgentError
          ? error.code
          : "LOCAL_AGENT_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "The RosterPilot local agent is unavailable.",
    };
  }
}

export async function restartLocalAgent(): Promise<LifecycleResult> {
  if (!(await exists(launchAgentPath()))) {
    return {
      ok: false,
      installed: false,
      running: false,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      code: "LOCAL_AGENT_NOT_INSTALLED",
      message: "Install the RosterPilot local agent before restarting it.",
    };
  }
  await launchctl([
    "kickstart",
    "-k",
    `${launchDomain()}/${LOCAL_AGENT_LABEL}`,
  ]);
  try {
    const status = await waitForStatus();
    const assessment = assessLocalAgentInstallation(status);
    const issue = primaryAssessmentIssue(assessment);
    return {
      ok: assessment.current,
      installed: true,
      running: true,
      installationCurrent: assessment.checkoutCurrent,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      status,
      assessment,
      nextSteps: assessmentNextSteps(assessment),
      code: issue?.code,
      message: issue?.message,
    };
  } catch (error) {
    return {
      ok: false,
      installed: true,
      running: false,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      code:
        error instanceof LocalAgentError
          ? error.code
          : "LOCAL_AGENT_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "The RosterPilot local agent did not restart.",
    };
  }
}

type EnsureCurrentDependencies = {
  status: () => Promise<LifecycleResult>;
  install: () => Promise<LifecycleResult>;
  restart: () => Promise<LifecycleResult>;
};

function requiredRepair(
  result: LifecycleResult,
): "install" | "restart" {
  if (
    !result.installed ||
    result.code === "LOCAL_AGENT_CHECKOUT_MISMATCH" ||
    result.code === "LOCAL_AGENT_PROTOCOL_MISMATCH"
  ) {
    return "install";
  }
  const requested = result.assessment?.issues.find(
    (issue) => issue.repair !== "rerun",
  )?.repair;
  return requested === "install" ? "install" : "restart";
}

/**
 * Verify the installed local agent against this checkout and repair it through
 * the same install/restart lifecycle used by the explicit agent commands.
 * The initial mismatch is retained in the response even after a successful
 * repair so callers can explain what changed.
 */
export async function ensureCurrentLocalAgent(
  overrides: Partial<EnsureCurrentDependencies> = {},
): Promise<LifecycleResult> {
  const dependencies: EnsureCurrentDependencies = {
    status: overrides.status ?? getLocalAgentLifecycleStatus,
    install: overrides.install ?? installLocalAgent,
    restart: overrides.restart ?? restartLocalAgent,
  };
  const initial = await dependencies.status();
  const initialIssues =
    initial.assessment?.issues ??
    (initial.code
      ? [
          {
            code: initial.code,
            message:
              initial.message ?? "The local agent is not ready.",
            repair: requiredRepair(initial),
            nextStep:
              'Run "npm run rosterpilot -- agent ensure-current" again after resolving the reported prerequisite.',
          } satisfies LocalAgentReadinessIssue,
        ]
      : []);
  if (initial.ok) {
    return {
      ...initial,
      initialIssues,
      repairActions: [],
      nextSteps: [],
    };
  }

  const repairActions: Array<"install" | "restart"> = [];
  const firstRepair = requiredRepair(initial);
  repairActions.push(firstRepair);
  let repaired =
    firstRepair === "install"
      ? await dependencies.install()
      : await dependencies.restart();

  if (!repaired.ok && firstRepair === "restart") {
    repairActions.push("install");
    repaired = await dependencies.install();
  }

  return {
    ...repaired,
    initialIssues,
    repairActions,
    nextSteps: repaired.ok
      ? []
      : repaired.nextSteps?.length
        ? repaired.nextSteps
        : [
            'Review "npm run doctor -- --profile tessera --refresh skip", then rerun "npm run rosterpilot -- agent ensure-current".',
          ],
    message: repaired.ok
      ? `The local agent is current after ${repairActions.join(" then ")}.`
      : repaired.message,
  };
}

export async function uninstallLocalAgent(): Promise<LifecycleResult> {
  const plist = launchAgentPath();
  await launchctl(["bootout", launchDomain(), plist], true);
  await unlink(localAgentSocketPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(localAgentSpoolDirectory(), { recursive: true, force: true });
  await rm(plist, { force: true });
  await rm(installedBrokerPath(), { force: true });
  await rmdir(path.dirname(installedBrokerPath())).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    },
  );
  await Promise.all([
    rm(path.join(localAgentLogDirectory(), "agent.stdout.log"), {
      force: true,
    }),
    rm(path.join(localAgentLogDirectory(), "agent.stderr.log"), {
      force: true,
    }),
  ]);
  await rmdir(localAgentLogDirectory()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    },
  );
  return {
    ok: true,
    installed: false,
    running: false,
    launchAgentPath: plist,
    brokerPath: installedBrokerPath(),
    socketPath: localAgentSocketPath(),
    message:
      "The local agent was removed. The Keychain credential and Chrome profile were preserved.",
  };
}
