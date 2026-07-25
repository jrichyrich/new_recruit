import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const [sourceBase, outputDirectory] = process.argv.slice(2);

if (!sourceBase || !outputDirectory) {
  throw new Error(
    "Usage: sanitize-new-recruit-fixtures <source-without-extension> <output-directory>",
  );
}

function stripCopyrightedXml(xml: string): string {
  return xml
    .replace(/<rules>[\s\S]*?<\/rules>/g, "")
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
}

function stripCopyrightedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCopyrightedJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["rules", "profiles", "description", "comment", "notes"].includes(key),
      )
      .map(([key, child]) => [key, stripCopyrightedJson(child)]),
  );
}

const sourceRos = `${sourceBase}.ros`;
const sourceRosz = `${sourceBase}.rosz`;
const sourceJson = `${sourceBase}.json`;
const filename = "golden-boys";

const [xml, archive, json] = await Promise.all([
  readFile(sourceRos, "utf8"),
  readFile(sourceRosz),
  readFile(sourceJson, "utf8"),
]);
const archiveEntries = unzipSync(archive);
const archivedRosName = Object.keys(archiveEntries).find((name) =>
  name.toLowerCase().endsWith(".ros"),
);
if (!archivedRosName) throw new Error("The .rosz fixture contains no .ros file.");

const sanitizedXml = stripCopyrightedXml(xml);
const sanitizedArchivedXml = stripCopyrightedXml(
  strFromU8(archiveEntries[archivedRosName]),
);
if (sanitizedXml !== sanitizedArchivedXml) {
  throw new Error("The source .ros and .rosz payloads do not match.");
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, `${filename}.ros`), sanitizedXml),
  writeFile(
    path.join(outputDirectory, `${filename}.rosz`),
    zipSync({ [`${filename}.ros`]: strToU8(sanitizedXml) }, { level: 6 }),
  ),
  writeFile(
    path.join(outputDirectory, `${filename}.json`),
    `${JSON.stringify(stripCopyrightedJson(JSON.parse(json)), null, 2)}\n`,
  ),
]);

console.log(`Sanitized New Recruit fixtures written to ${outputDirectory}`);
