import assert from "node:assert/strict";
import test from "node:test";

import type {
  CertificationArtifactDescriptor,
} from "../lib/rosterpilot/certification";
import {
  deduplicateCertificationArtifacts,
} from "../local/certification/artifact-inventory";

test("certification artifact inventory keeps one exact descriptor while preserving case evidence", () => {
  const browserEvidence: CertificationArtifactDescriptor = {
    kind: "browser-fixture-evidence",
    path: "artifacts/canonical/browser-fixture-evidence.json",
    sha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const artifacts = [
    browserEvidence,
    ...Array.from({ length: 28 }, () => ({
      ...browserEvidence,
    })),
    {
      ...browserEvidence,
      sha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    {
      kind: "manifest" as const,
      path: "certification-manifest.json",
      sha256:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  ];

  assert.deepEqual(
    deduplicateCertificationArtifacts(artifacts),
    [
      browserEvidence,
      {
        ...browserEvidence,
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        kind: "manifest",
        path: "certification-manifest.json",
        sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
  );
  assert.equal(
    artifacts.filter(
      (artifact) =>
        artifact.kind === "browser-fixture-evidence",
    ).length,
    30,
    "the source case-level descriptors remain untouched",
  );
});
