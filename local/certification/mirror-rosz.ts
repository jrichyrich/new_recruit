import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

function mirrorError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: "CERTIFICATION_LIVE_ROSZ_INVALID",
  });
}

function escapedXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Changes only the roster presentation name and writes a canonical ZIP.
 * Fixed entry ordering and timestamps make the mirror archive stable across
 * process and local-agent restarts.
 */
export function deterministicRenamedMirrorRosz(
  content: Uint8Array,
  rosterName: string,
): Uint8Array {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    throw mirrorError(
      "The enriched ROSZ could not be opened as a ZIP archive.",
    );
  }
  const rosterEntries = Object.entries(entries).filter(
    ([filename]) =>
      filename.toLocaleLowerCase().endsWith(".ros"),
  );
  if (rosterEntries.length !== 1) {
    throw mirrorError(
      "The enriched ROSZ must contain exactly one roster file.",
    );
  }
  const [rosterFilename, rosterContent] = rosterEntries[0];
  const xml = strFromU8(rosterContent);
  const rosterNamePattern = /(<roster\b[^>]*\bname=")[^"]*(")/;
  if (!rosterNamePattern.test(xml)) {
    throw mirrorError(
      "The enriched ROSZ roster name could not be scoped for Tessera.",
    );
  }
  const renamed = xml.replace(
    rosterNamePattern,
    `$1${escapedXmlAttribute(rosterName)}$2`,
  );
  const canonicalEntries = Object.fromEntries(
    Object.entries({
      ...entries,
      [rosterFilename]: strToU8(renamed),
    }).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return zipSync(canonicalEntries, {
    level: 6,
    mtime: new Date(1980, 0, 1),
  });
}
