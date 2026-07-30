import crypto from "node:crypto";

const sha256Pattern = /^[0-9a-f]{64}$/;

export function newRecruitUiIdentityFingerprint(input: {
  origin: string;
  declaredVersion: string | null;
  scriptSources: string[];
}): string {
  const origin = new URL(input.origin).origin;
  const scriptSources = [
    ...new Set(
      input.scriptSources
        .map((source) => source.trim())
        .filter(Boolean)
        .map((source) => new URL(source, origin).href),
    ),
  ].sort();
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        origin,
        declaredVersion: input.declaredVersion?.trim() || null,
        scriptSources,
      }),
    )
    .digest("hex");
}

export function safeNewRecruitUiIdentity(
  value: unknown,
): string | null {
  return typeof value === "string" && sha256Pattern.test(value)
    ? value
    : null;
}
