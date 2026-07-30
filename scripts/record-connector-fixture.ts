import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import {
  sanitizeConnectorFixture,
  sanitizedFixtureSha256,
} from "../local/certification/sanitize";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  throw new Error(
    "Usage: record-connector-fixture <source.json> <destination.json>",
  );
}

const input = JSON.parse(await readFile(path.resolve(source), "utf8"));
const sanitized = sanitizeConnectorFixture(input);
const fixture = {
  schemaVersion: 1,
  fixtureKind: "sanitized-connector-recording",
  recordedAt: new Date().toISOString(),
  contentSha256: sanitizedFixtureSha256(input),
  payload: sanitized,
};
const target = path.resolve(destination);
await mkdir(path.dirname(target), { recursive: true });
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(
  temporary,
  `${JSON.stringify(fixture, null, 2)}\n`,
  {
    flag: "wx",
    mode: 0o600,
  },
);
await rename(temporary, target);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    destination: target,
    contentSha256: fixture.contentSha256,
  })}\n`,
);
