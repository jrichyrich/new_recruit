import type {
  DataBundleOfficialAuthorityStatus,
  VerifiedAcceptedDataBundleManifestV1,
} from "./data-bundle";

let activeManifest: VerifiedAcceptedDataBundleManifestV1 | null = null;
let activeOfficialAuthority: DataBundleOfficialAuthorityStatus | null = null;

/**
 * Process-local identity of the atomically activated runtime data snapshot.
 * The catalogue and Dataset bindings live in their respective modules; this
 * context supplies the exact signed bundle and scoped compatibility hashes.
 */
export function getActiveDataBundleManifest():
  | VerifiedAcceptedDataBundleManifestV1
  | null {
  return activeManifest;
}

export function setActiveDataBundleManifest(
  manifest: VerifiedAcceptedDataBundleManifestV1,
  officialAuthority?: DataBundleOfficialAuthorityStatus,
): void {
  activeManifest = manifest;
  activeOfficialAuthority = officialAuthority
    ? structuredClone(officialAuthority)
    : null;
}

export function getActiveOfficialAuthority():
  | DataBundleOfficialAuthorityStatus
  | null {
  return activeOfficialAuthority
    ? structuredClone(activeOfficialAuthority)
    : null;
}

export function clearActiveDataBundleManifestForTests(): void {
  activeManifest = null;
  activeOfficialAuthority = null;
}
