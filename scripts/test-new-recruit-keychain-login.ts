import { spawn } from "node:child_process";
import path from "node:path";

const brokerPath = path.resolve(
  "native",
  ".build",
  "rosterpilot-keychain",
);

async function assertCredentialReleaseDisabled(
  provider: "new-recruit" | "tessera",
): Promise<void> {
  const payload = await new Promise<string>((resolve, reject) => {
    const child = spawn(brokerPath, ["retrieve", provider], {
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
    configured?: boolean;
    code?: string;
    message?: string;
    username?: unknown;
    password?: unknown;
    licenseKey?: unknown;
  };
  if (
    parsed.ok ||
    parsed.code !== "CREDENTIAL_RELEASE_DISABLED" ||
    "username" in parsed ||
    "password" in parsed ||
    "licenseKey" in parsed
  ) {
    throw new Error(
      `The ${provider} broker did not fail closed without secret fields: ${payload}`,
    );
  }
}

await Promise.all([
  assertCredentialReleaseDisabled("new-recruit"),
  assertCredentialReleaseDisabled("tessera"),
]);
process.stdout.write(
  `${JSON.stringify({ ok: true, credentialRelease: "disabled" }, null, 2)}\n`,
);
