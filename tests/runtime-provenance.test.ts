import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  newRecruitCatalogue,
} from "../lib/rosterpilot";
import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  LOCAL_AGENT_VERSION,
} from "../local/agent/contracts";
import {
  getRuntimeProvenance,
} from "../local/runtime-provenance";

test("runtime provenance records observable platform, agent, MCP, and data identities", () => {
  const runtime = getRuntimeProvenance();

  assert.equal(
    runtime.localAgentExpectedProtocolVersion,
    LOCAL_AGENT_PROTOCOL_VERSION,
  );
  assert.equal(
    runtime.localAgentExpectedVersion,
    LOCAL_AGENT_VERSION,
  );
  assert.match(runtime.mcpBuildId ?? "", /^[0-9a-f]{20}$/);
  assert.deepEqual(runtime.runtimeProcessIdentity, {
    pid: process.pid,
    executable: process.execPath,
  });
  assert.equal(
    runtime.dataReleaseId,
    newRecruitCatalogue.releaseId,
  );
  assert.equal(
    runtime.dataFreshnessCheckedAt,
    newRecruitCatalogue.sources.official.checkedAt,
  );
  assert.equal(
    runtime.dataGeneratedAt,
    newRecruitCatalogue.generatedAt,
  );

  if (process.platform === "darwin") {
    const observedMacOsVersion = execFileSync(
      "/usr/bin/sw_vers",
      ["-productVersion"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(runtime.macOsVersion, observedMacOsVersion);
  } else {
    assert.equal(runtime.macOsVersion, null);
  }

  if (runtime.localAgentProcessIdentity) {
    assert.equal(
      runtime.localAgentProcessIdentity.label,
      "com.jasonricha.rosterpilot.agent",
    );
    if (runtime.localAgentProcessIdentity.pid !== null) {
      assert.ok(runtime.localAgentProcessIdentity.pid > 0);
    }
  }
});
