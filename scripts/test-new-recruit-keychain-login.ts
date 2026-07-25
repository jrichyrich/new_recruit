import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BrokerCredentials } from "../local/new-recruit/contracts";
import {
  NewRecruitAutomationError,
  runNewRecruitAuthenticationCheck,
} from "../local/new-recruit/browser";

const brokerPath = path.resolve(
  "native",
  ".build",
  "rosterpilot-keychain",
);

async function retrieveCredentials(): Promise<BrokerCredentials> {
  const payload = await new Promise<string>((resolve, reject) => {
    const child = spawn(brokerPath, ["retrieve"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", () => {
      const text = Buffer.concat(stdout).toString("utf8");
      if (text) resolve(text);
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
  const parsed = JSON.parse(payload) as {
    ok: boolean;
    username?: string;
    password?: string;
    code?: string;
    message?: string;
  };
  if (!parsed.ok || !parsed.username || !parsed.password) {
    throw new NewRecruitAutomationError(
      parsed.code ?? "KEYCHAIN_READ_FAILED",
      parsed.message ?? "The Keychain broker did not return a credential.",
    );
  }
  return {
    username: parsed.username,
    password: parsed.password,
  };
}

const temporaryProfile = await mkdtemp(
  path.join(os.tmpdir(), "rosterpilot-auth-check-"),
);
try {
  const result = await runNewRecruitAuthenticationCheck(temporaryProfile, {
    getCredentials: retrieveCredentials,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
} finally {
  await rm(temporaryProfile, { recursive: true, force: true });
}
