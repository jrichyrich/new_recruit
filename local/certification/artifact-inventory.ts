import type {
  CertificationArtifactDescriptor,
} from "../../lib/rosterpilot/certification";

export function deduplicateCertificationArtifacts(
  artifacts: readonly CertificationArtifactDescriptor[],
): CertificationArtifactDescriptor[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const identity = JSON.stringify([
      artifact.kind,
      artifact.path,
      artifact.sha256,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
