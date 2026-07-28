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
import type { LocalAgentStatus } from "./contracts";

const run = promisify(execFile);
export const LOCAL_AGENT_LABEL = "com.jasonricha.rosterpilot.agent";

type LifecycleResult = {
  ok: boolean;
  installed: boolean;
  running: boolean;
  brokerChanged?: boolean;
  credentialReauthorizationRequired?: boolean;
  launchAgentPath: string;
  brokerPath: string;
  socketPath: string;
  status?: LocalAgentStatus;
  code?: string;
  message?: string;
};

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

async function waitForStatus(timeoutMs = 5_000): Promise<LocalAgentStatus> {
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

  const plistContent = renderLaunchAgent({
    nodeExecutable: process.execPath,
    projectDirectory: projectRoot,
    brokerPath: broker,
    socketPath: localAgentSocketPath(),
    profileDirectory: newRecruitProfileDirectory(),
    stdoutPath: path.join(logs, "agent.stdout.log"),
    stderrPath: path.join(logs, "agent.stderr.log"),
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
    const credentialReady =
      status.providers.find(
        (provider) => provider.providerId === "new-recruit",
      )?.credentialState === "ready";
    return {
      ok: true,
      installed: true,
      running: true,
      brokerChanged,
      credentialReauthorizationRequired: brokerChanged && !credentialReady,
      launchAgentPath: plist,
      brokerPath: broker,
      socketPath: localAgentSocketPath(),
      status,
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
    return {
      ok: true,
      installed,
      running: true,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      status,
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
    return {
      ok: true,
      installed: true,
      running: true,
      launchAgentPath: launchAgentPath(),
      brokerPath: installedBrokerPath(),
      socketPath: localAgentSocketPath(),
      status,
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
