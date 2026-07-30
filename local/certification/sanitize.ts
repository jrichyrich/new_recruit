import crypto from "node:crypto";

const forbiddenKey =
  /(?:passw(?:or)?d|passphrase|secret|token|cookie|authorization|proxy.?authorization|api.?key|x.?api.?key|access.?key.?id|private.?key|client.?secret|licen[cs]e.?key|credential|browser.?storage|storage.?state|local.?storage|session.?storage|request.?headers|response.?headers|headers)/i;
const identityKey =
  /^(?:rosterName|playerName|opponentName|listUrl|remoteId|profileDirectory|sourceRoszPath|enrichedRoszPath)$/i;
const loginPage =
  /(?:<input\b[^>]*(?:type|name|autocomplete)=["']?(?:password|current-password|one-time-code)|<form\b[\s\S]{0,8000}\b(?:log[\s-]?in|sign[\s-]?in|forgot[\s-]?password)\b)/i;
const serializedPrivateMaterial =
  /(?:fixture-secret-never-return|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|playwright\/.*user.?data|(?:Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizedIdentity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    return `${url.origin}/redacted/${digest(text)}`;
  }
  return `fixture-${digest(text)}`;
}

function sanitize(value: unknown, key = ""): unknown {
  if (forbiddenKey.test(key)) return "[REDACTED]";
  if (identityKey.test(key)) return sanitizedIdentity(value);
  if (typeof value === "string") {
    if (loginPage.test(value)) {
      throw new Error(
        "CERTIFICATION_FIXTURE_LOGIN_PAGE_REJECTED: Login pages must never be recorded as connector fixtures.",
      );
    }
    return value
      .replaceAll(
        /\/Users\/[^/\s"'<>]+/g,
        "/Users/fixture",
      )
      .replaceAll(
        /(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
        "Bearer [REDACTED]",
      )
      .replaceAll(
        /(?:Basic\s+)[A-Za-z0-9+/=-]+/gi,
        "Basic [REDACTED]",
      )
      .replaceAll(
        /((?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*)[^\s,;"'<>]+/gi,
        "$1[REDACTED]",
      )
      .replaceAll(
        /\bAKIA[0-9A-Z]{16}\b/g,
        "[REDACTED_AWS_ACCESS_KEY]",
      )
      .replaceAll(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
        "[REDACTED_JWT]",
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitize(child, childKey),
    ]),
  );
}

export function sanitizeConnectorFixture(value: unknown): unknown {
  const sanitized = sanitize(value);
  const serialized = JSON.stringify(sanitized);
  if (
    serializedPrivateMaterial.test(serialized)
  ) {
    throw new Error(
      "CERTIFICATION_FIXTURE_SECRET_RETAINED: The sanitized fixture still contains private material.",
    );
  }
  return sanitized;
}

export function sanitizedFixtureSha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sanitizeConnectorFixture(value)))
    .digest("hex");
}
