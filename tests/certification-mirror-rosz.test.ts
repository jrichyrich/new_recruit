import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import {
  deterministicRenamedMirrorRosz,
} from "../local/certification/mirror-rosz";

test("certification mirror ROSZ bytes remain stable across ZIP timestamp boundaries", async () => {
  const source = zipSync(
    {
      "metadata.txt": strToU8("preserve me"),
      "army.ros": strToU8(
        '<?xml version="1.0"?><roster id="fixture" name="Player"><forces /></roster>',
      ),
    },
    { mtime: new Date(2026, 6, 30, 10, 30, 0) },
  );
  const first = deterministicRenamedMirrorRosz(
    source,
    'Mirror & "Opponent"',
  );
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const second = deterministicRenamedMirrorRosz(
    source,
    'Mirror & "Opponent"',
  );
  assert.deepEqual(second, first);
  assert.equal(
    crypto.createHash("sha256").update(second).digest("hex"),
    crypto.createHash("sha256").update(first).digest("hex"),
  );
  const entries = unzipSync(first);
  assert.equal(strFromU8(entries["metadata.txt"]), "preserve me");
  assert.match(
    strFromU8(entries["army.ros"]),
    /name="Mirror &amp; &quot;Opponent&quot;"/,
  );
});

test("certification mirror ROSZ rejects an ambiguous roster archive", () => {
  const source = zipSync({
    "one.ros": strToU8('<roster name="One" />'),
    "two.ros": strToU8('<roster name="Two" />'),
  });
  assert.throws(
    () => deterministicRenamedMirrorRosz(source, "Mirror"),
    (error: Error & { code?: string }) =>
      error.code === "CERTIFICATION_LIVE_ROSZ_INVALID" &&
      /exactly one roster/i.test(error.message),
  );
});
