import type {
  ReliabilityJsonObject,
  ReliabilityJsonValue,
  WorkflowReliabilityErrorV1,
} from "./types";

const sensitiveKeyPattern =
  /(?:authorization|browser.?profile|browser.?storage|client.?secret|cookie|credential|keychain|licen[cs]e.?key|local.?storage|passphrase|password|private.?key|proxy.?authorization|secret|session.?storage|storage.?state|token)/i;
const inlineSecretPattern =
  /((?:authorization|cookie|credential|licen[cs]e(?:\s+key)?|passphrase|password|private\s+key|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const basicAuthUrlPattern = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const unixHomePattern = /\/Users\/[^/\s]+/g;
const windowsHomePattern = /\b[A-Za-z]:\\Users\\[^\\\s]+/g;

export type ReliabilitySanitizationOptions = {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
};

const defaults: Required<ReliabilitySanitizationOptions> = {
  maxDepth: 8,
  maxArrayLength: 128,
  maxObjectKeys: 128,
  maxStringLength: 4_096,
};

function sanitizedString(
  value: string,
  maxStringLength: number,
): string {
  const redacted = value
    .replace(bearerPattern, "Bearer [redacted]")
    .replace(inlineSecretPattern, "$1[redacted]")
    .replace(basicAuthUrlPattern, "$1[redacted]@")
    .replace(unixHomePattern, "/Users/[redacted]")
    .replace(windowsHomePattern, "C:\\Users\\[redacted]");
  return redacted.length <= maxStringLength
    ? redacted
    : `${redacted.slice(0, maxStringLength)}…[truncated]`;
}

function sanitizeValue(
  value: unknown,
  options: Required<ReliabilitySanitizationOptions>,
  depth: number,
  ancestors: Set<object>,
): ReliabilityJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return sanitizedString(value, options.maxStringLength);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return `[binary:${value.byteLength} bytes]`;
  }
  if (depth >= options.maxDepth) return "[maximum depth reached]";
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, options.maxArrayLength)
        .map((entry) =>
          sanitizeValue(entry, options, depth + 1, ancestors),
        );
      if (value.length > options.maxArrayLength) {
        output.push(`[${value.length - options.maxArrayLength} entries omitted]`);
      }
      return output;
    }
    const source = value as Record<string, unknown>;
    const entries = Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.maxObjectKeys);
    const output: ReliabilityJsonObject = {};
    for (const [key, child] of entries) {
      const cleanKey = sanitizedString(key, 256);
      output[cleanKey] = sensitiveKeyPattern.test(key)
        ? "[redacted]"
        : sanitizeValue(child, options, depth + 1, ancestors);
    }
    if (Object.keys(source).length > options.maxObjectKeys) {
      output["[omitted keys]"] =
        Object.keys(source).length - options.maxObjectKeys;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeReliabilityValue(
  value: unknown,
  requested: ReliabilitySanitizationOptions = {},
): ReliabilityJsonValue {
  const options = { ...defaults, ...requested };
  return sanitizeValue(value, options, 0, new Set());
}

export function sanitizeReliabilityAttributes(
  value: unknown,
  options: ReliabilitySanitizationOptions = {},
): ReliabilityJsonObject {
  const sanitized = sanitizeReliabilityValue(value ?? {}, options);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : { value: sanitized };
}

export function sanitizeReliabilityText(value: string): string {
  return sanitizedString(value, defaults.maxStringLength);
}

export function sanitizeReliabilityError(
  error: WorkflowReliabilityErrorV1 | null | undefined,
): WorkflowReliabilityErrorV1 | null {
  if (!error) return null;
  return {
    code: sanitizeReliabilityText(error.code).slice(0, 256),
    message: sanitizeReliabilityText(error.message),
    retryable: error.retryable,
  };
}
