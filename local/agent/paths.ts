import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function rosterPilotSupportDirectory(): string {
  return (
    process.env.ROSTERPILOT_SUPPORT_DIRECTORY ??
    path.join(os.homedir(), "Library", "Application Support", "RosterPilot")
  );
}

export function installedBrokerPath(): string {
  return (
    process.env.ROSTERPILOT_KEYCHAIN_BROKER ??
    path.join(
      rosterPilotSupportDirectory(),
      "bin",
      "rosterpilot-keychain",
    )
  );
}

export function stagedBrokerPath(): string {
  return path.join(
    projectRoot,
    "native",
    ".build",
    "rosterpilot-keychain",
  );
}

export function localAgentSocketPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return (
    process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET ??
    path.join("/private/tmp", `rosterpilot-agent-${uid}.sock`)
  );
}

export function localAgentSpoolDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return (
    process.env.ROSTERPILOT_LOCAL_AGENT_SPOOL ??
    path.join("/private/tmp", `rosterpilot-agent-${uid}`)
  );
}

export function newRecruitProfileDirectory(): string {
  return (
    process.env.ROSTERPILOT_NEW_RECRUIT_PROFILE ??
    path.join(rosterPilotSupportDirectory(), "NewRecruitChrome")
  );
}

export function launchAgentPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.jasonricha.rosterpilot.agent.plist",
  );
}

export function localAgentLogDirectory(): string {
  return path.join(rosterPilotSupportDirectory(), "logs");
}
