import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/v1/[...path]/route";
import {
  buildRoster,
  rosterExecutionFingerprint,
  type BuildRosterInput,
  type RosterDraftV1,
} from "../lib/rosterpilot";

test("HTTP roster construction matches the shared deterministic engine", async () => {
  const input: BuildRosterInput = {
    prompt:
      "Build a 1,000 point fast Custodes army with no named characters",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    preferences: ["mobility", "objective"],
    allowNamedCharacters: false,
  };
  const direct = buildRoster(input);
  assert.ok(direct.data);
  const previousToken = process.env.ROSTERPILOT_API_TOKEN;
  process.env.ROSTERPILOT_API_TOKEN = "certification-parity-token";
  let response: Response;
  try {
    response = await POST(
      new Request("http://localhost/api/v1/rosters/build", {
        method: "POST",
        headers: {
          authorization: "Bearer certification-parity-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.ROSTERPILOT_API_TOKEN;
    } else {
      process.env.ROSTERPILOT_API_TOKEN = previousToken;
    }
  }
  assert.equal(response.status, 200);
  const transported = (await response.json()) as {
    ok: boolean;
    data: RosterDraftV1;
  };
  assert.equal(transported.ok, true);
  assert.equal(
    rosterExecutionFingerprint(transported.data),
    rosterExecutionFingerprint(direct.data),
  );
});
