import assert from "node:assert/strict";
import test from "node:test";

import { buildRoster } from "../lib/rosterpilot/engine";
import {
  findFactionMentions,
  resolveExactFactionReference,
  resolveFactionIntent,
} from "../lib/rosterpilot/faction-intent";

test("resolves only canonical faction references and reviewed aliases", () => {
  assert.equal(
    resolveExactFactionReference("Death Guard")?.factionId,
    "death-guard",
  );
  assert.equal(
    resolveExactFactionReference("Golden Boys")?.factionId,
    "adeptus-custodes",
  );
  assert.equal(
    resolveExactFactionReference("Sisters of Battle")?.factionId,
    "adepta-sororitas",
  );
  assert.equal(resolveExactFactionReference("Death Gourd"), null);
});

test("keeps fuzzy and voice-like matches as suggestions", () => {
  const typo = resolveFactionIntent({
    prompt: "Build a 1000 point Death Gourd army.",
  });
  assert.equal(typo.status, "unsupported");
  assert.equal(typo.code, "FACTION_UNSUPPORTED");
  assert.equal(typo.suggestions[0]?.factionId, "death-guard");

  const voice = resolveFactionIntent({
    prompt: "Build a 1000 point Coto del Darri army.",
  });
  assert.equal(voice.status, "unsupported");
  assert.ok(
    voice.suggestions.some((candidate) => candidate.factionId === "aeldari"),
  );

  const unknown = resolveFactionIntent({
    prompt: "Build a 1000 point Zerg army.",
  });
  assert.equal(unknown.status, "unsupported");
  assert.equal(unknown.code, "FACTION_UNSUPPORTED");
  assert.deepEqual(unknown.suggestions, []);
});

test("distinguishes player and opponent language", () => {
  const prompt =
    "Build a 1000 point Aeldari army to battle an unknown Adeptus Custodes list.";
  assert.deepEqual(
    findFactionMentions(prompt).map((mention) => [
      mention.factionId,
      mention.role,
    ]),
    [
      ["aeldari", "player"],
      ["adeptus-custodes", "opponent"],
    ],
  );
  const resolved = resolveFactionIntent({ prompt });
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(resolved.factionId, "aeldari");
  assert.deepEqual(resolved.opponentFactionIds, ["adeptus-custodes"]);

  const reverse = resolveFactionIntent({
    prompt: "Counter Aeldari with Death Guard.",
  });
  assert.equal(reverse.status, "resolved");
  if (reverse.status !== "resolved") return;
  assert.equal(reverse.factionId, "death-guard");
  assert.deepEqual(reverse.opponentFactionIds, ["aeldari"]);

  for (const [naturalPrompt, player, opponent] of [
    [
      "Aeldari counter to Custodes",
      "aeldari",
      "adeptus-custodes",
    ],
    [
      "Custodes for fighting Aeldari",
      "adeptus-custodes",
      "aeldari",
    ],
    [
      "Build a Custodes army for fighting Aeldari",
      "adeptus-custodes",
      "aeldari",
    ],
  ] as const) {
    const natural = resolveFactionIntent({ prompt: naturalPrompt });
    assert.equal(natural.status, "resolved", naturalPrompt);
    if (natural.status !== "resolved") continue;
    assert.equal(natural.factionId, player, naturalPrompt);
    assert.deepEqual(
      natural.opponentFactionIds,
      [opponent],
      naturalPrompt,
    );
  }
});

test("fails closed for missing, ambiguous, and conflicting factions", () => {
  const missing = resolveFactionIntent({
    prompt: "Build me a 1000 point army.",
  });
  assert.equal(missing.status, "missing");
  assert.equal(missing.code, "FACTION_REQUIRED");
  assert.equal(
    resolveFactionIntent({
      prompt: "Build me a fast balanced 1000 point army.",
    }).status,
    "missing",
  );

  const ambiguous = resolveFactionIntent({
    prompt: "Build an Aeldari and Custodes army.",
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.code, "AMBIGUOUS_PLAYER_FACTION");

  const conflict = resolveFactionIntent({
    prompt: "Build Custodes against Aeldari.",
    playerFaction: "aeldari",
  });
  assert.equal(conflict.status, "ambiguous");
  assert.equal(conflict.code, "FACTION_CONFLICT");
});

test("builds never fall back to Custodes when faction intent is absent or fuzzy", () => {
  const missing = buildRoster({ pointsLimit: 1000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.data, null);
  assert.deepEqual(
    missing.violations.map((violation) => violation.code),
    ["FACTION_REQUIRED"],
  );

  const fuzzy = buildRoster({
    prompt: "Build a 1000 point Death Gourd army.",
  });
  assert.equal(fuzzy.ok, false);
  assert.equal(fuzzy.data, null);
  assert.deepEqual(
    fuzzy.violations.map((violation) => violation.code),
    ["FACTION_UNSUPPORTED"],
  );
  assert.match(fuzzy.violations[0].message, /Death Guard \(death-guard\)/);
});

test("builds a clear player faction and records its inferred opponent", () => {
  const built = buildRoster({
    prompt:
      "Build a 1000 point Death Guard army against an unknown Orks list.",
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(built.data?.factionId, "death-guard");
  assert.equal(built.data?.constraints.opponentFactionId, "orks");

  const conflict = buildRoster({
    prompt: "Build Custodes against Aeldari.",
    playerFaction: "aeldari",
    pointsLimit: 1000,
  });
  assert.equal(conflict.ok, false);
  assert.deepEqual(
    conflict.violations.map((violation) => violation.code),
    ["FACTION_CONFLICT"],
  );
});
