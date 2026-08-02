import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRosterWorkflowIntent,
} from "../lib/rosterpilot/workflow-intent";

test("workflow intent does not authorize delivery from a question", () => {
  const result = resolveRosterWorkflowIntent({
    prompt: "Can you upload a Custodes roster to New Recruit?",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.intent, "build");
  assert.equal(result.data?.deliveryAuthorized, false);
  assert.equal(result.data?.detectedFromPrompt.question, true);
});

test("workflow intent does not mistake a file handoff for delivery", () => {
  const result = resolveRosterWorkflowIntent({
    prompt: "Send me a .rosz file for New Recruit.",
  });

  assert.equal(result.data?.intent, "prepare-new-recruit");
  assert.equal(result.data?.deliveryAuthorized, false);
});

test("structured delivery intent cannot override a capability question", () => {
  const result = resolveRosterWorkflowIntent({
    intent: "deliver-new-recruit",
    prompt: "Can you upload this roster to New Recruit?",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "WORKFLOW_DELIVERY_QUESTION_CONFLICT",
  );
});

test("workflow intent authorizes an explicit New Recruit delivery", () => {
  const result = resolveRosterWorkflowIntent({
    prompt:
      "Build me a 1,000 point Custodes army and upload it to New Recruit.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.intent, "deliver-new-recruit");
  assert.equal(result.data?.artifactRequirement, "new-recruit-rosz");
  assert.equal(result.data?.deliveryAuthorized, true);
});

test("workflow intent defaults optimization to guided approval", () => {
  const guided = resolveRosterWorkflowIntent({
    prompt: "Build 2,000 points of Death Guard and Tessera optimize it.",
  });
  const analysis = resolveRosterWorkflowIntent({
    prompt:
      "Math-hammer this Space Marines roster, recommendations only and do not apply changes.",
  });

  assert.equal(guided.data?.intent, "optimize");
  assert.equal(guided.data?.optimizerMode, "guided");
  assert.equal(
    guided.data?.artifactRequirement,
    "tessera-profile-rich",
  );
  assert.equal(analysis.data?.intent, "analyze");
  assert.equal(analysis.data?.optimizerMode, null);
  assert.equal(analysis.data?.artifactRequirement, "none");
});

test("workflow intent requires an explicit change verb for optimization", () => {
  for (const prompt of [
    "Test this roster in Tessera.",
    "Math-hammer this roster.",
    "Run a stress test against Aeldari.",
    "Run a paired test for these armies.",
  ]) {
    const result = resolveRosterWorkflowIntent({ prompt });
    assert.equal(result.data?.intent, "analyze", prompt);
    assert.equal(result.data?.optimizerMode, null, prompt);
  }
  const optimize = resolveRosterWorkflowIntent({
    prompt:
      "Analyze and improve this roster, recommendations only and do not apply changes.",
  });
  assert.equal(optimize.data?.intent, "optimize");
  assert.equal(optimize.data?.optimizerMode, "recommend-only");
});

test("optimization defers requested delivery until winner approval", () => {
  const result = resolveRosterWorkflowIntent({
    prompt:
      "Tessera optimize a 1,000 point Custodes army, then upload the winner to New Recruit.",
  });

  assert.equal(result.data?.intent, "optimize");
  assert.equal(result.data?.deliveryAuthorized, false);
  assert.equal(
    result.data?.postOptimizationDeliveryRequested,
    true,
  );
  assert.equal(result.data?.deliveryTarget, "new-recruit");
});

test("recommend-only cannot promise a paired winner delivery", () => {
  const result = resolveRosterWorkflowIntent({
    prompt:
      "Tessera optimize Custodes, recommendations only, then upload the winner to New Recruit.",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "WORKFLOW_RECOMMEND_ONLY_DELIVERY_CONFLICT",
  );
});

test("workflow intent rejects structured and prompt conflicts", () => {
  const result = resolveRosterWorkflowIntent({
    intent: "prepare-new-recruit",
    prompt: "Tessera optimize this Aeldari roster.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.code, "WORKFLOW_INTENT_CONFLICT");
});

test("workflow intent supports concise, full, and disabled coaching", () => {
  assert.equal(
    resolveRosterWorkflowIntent({ prompt: "Build Custodes." }).data
      ?.coachingMode,
    "concise",
  );
  assert.equal(
    resolveRosterWorkflowIntent({
      prompt: "Build Custodes with a detailed coaching breakdown.",
    }).data?.coachingMode,
    "full",
  );
  assert.equal(
    resolveRosterWorkflowIntent({
      prompt: "Build Custodes without coaching.",
    }).data?.coachingMode,
    "none",
  );
});
