import crypto from "node:crypto";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import type { LocalTesseraEngineUnit } from "./local-engine-input";

export type LocalTesseraAttachmentBinding = {
  leaderSelectionId: string;
  bodyguardSelectionId: string;
  supportingSelectionIds?: readonly string[];
  supportSelectionIds?: readonly string[];
};

export type LocalTesseraAttachedMember = LocalTesseraEngineUnit & {
  memberId: string;
  attachmentRole: "leader" | "support";
};

export type LocalTesseraCombatFormation = LocalTesseraEngineUnit & {
  formationId: string;
  attachmentPlanId: string;
  bodyguardSelectionId: string;
  leaderSelectionId: string | null;
  supportSelectionIds: string[];
  memberSelectionIds: string[];
  totalModels: number;
  totalPoints: number | null;
  attached: LocalTesseraAttachedMember[];
};

export class LocalTesseraFormationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalTesseraFormationError";
    this.code = code;
  }
}

function supportIds(binding: LocalTesseraAttachmentBinding): string[] {
  const first = binding.supportingSelectionIds ?? [];
  const second = binding.supportSelectionIds ?? [];
  if (first.length > 0 && second.length > 0) {
    throw new LocalTesseraFormationError(
      "TESSERA_ATTACHMENT_SUPPORT_SHAPE_AMBIGUOUS",
      "An attachment binding cannot declare both supportingSelectionIds and supportSelectionIds.",
    );
  }
  return [...(first.length > 0 ? first : second)].sort();
}

function formationDigest(input: {
  rosterFingerprint: string;
  attachmentPlanId: string;
  bodyguardSelectionId: string;
  leaderSelectionId: string;
  supportSelectionIds: readonly string[];
}): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ schemaVersion: 1, ...input }))
    .digest("hex");
}

function totalPoints(
  members: readonly LocalTesseraEngineUnit[],
): number | null {
  if (members.some((member) => member.points === undefined)) return null;
  return members.reduce((sum, member) => sum + (member.points ?? 0), 0);
}

function standaloneFormation(
  unit: LocalTesseraEngineUnit,
  attachmentPlanId: string,
): LocalTesseraCombatFormation {
  return {
    ...unit,
    formationId: unit.instanceId,
    attachmentPlanId,
    bodyguardSelectionId: unit.selectionId,
    leaderSelectionId: null,
    supportSelectionIds: [],
    memberSelectionIds: [unit.selectionId],
    totalModels: unit.models,
    totalPoints: unit.points ?? null,
    attached: [],
  };
}

/**
 * Composes one exact, roster-owned attachment plan into Tessera's native
 * `attached` shape. Bindings owned entirely by the other roster are ignored;
 * a partially owned binding is rejected instead of guessing ownership.
 */
export function composeSelectedLocalTesseraFormations(input: {
  rosterFingerprint: string;
  attachmentPlanId: string;
  units: readonly LocalTesseraEngineUnit[];
  bindings: readonly LocalTesseraAttachmentBinding[];
}): LocalTesseraCombatFormation[] {
  const unitsBySelectionId = new Map<string, LocalTesseraEngineUnit>();
  for (const unit of input.units) {
    if (unitsBySelectionId.has(unit.selectionId)) {
      throw new LocalTesseraFormationError(
        "TESSERA_ATTACHMENT_SELECTION_DUPLICATE",
        `Selection ${unit.selectionId} occurs more than once in the local roster input.`,
      );
    }
    unitsBySelectionId.set(unit.selectionId, unit);
  }

  const ownedBindings: Array<{
    binding: LocalTesseraAttachmentBinding;
    supportSelectionIds: string[];
  }> = [];
  for (const binding of input.bindings) {
    const supports = supportIds(binding);
    const memberIds = [
      binding.bodyguardSelectionId,
      binding.leaderSelectionId,
      ...supports,
    ];
    if (new Set(memberIds).size !== memberIds.length) {
      throw new LocalTesseraFormationError(
        "TESSERA_ATTACHMENT_MEMBER_COLLISION",
        "An attachment binding repeats its bodyguard, Leader, or Support selection.",
      );
    }
    const ownedCount = memberIds.filter((id) =>
      unitsBySelectionId.has(id),
    ).length;
    if (ownedCount === 0) continue;
    if (ownedCount !== memberIds.length) {
      throw new LocalTesseraFormationError(
        "TESSERA_ATTACHMENT_CROSS_ROSTER_BINDING",
        `Attachment binding ${binding.leaderSelectionId}->${binding.bodyguardSelectionId} is only partially owned by this roster.`,
      );
    }
    ownedBindings.push({ binding, supportSelectionIds: supports });
  }

  const bindingByBodyguard = new Map<
    string,
    (typeof ownedBindings)[number]
  >();
  const boundMemberIds = new Set<string>();
  for (const owned of ownedBindings) {
    const memberIds = [
      owned.binding.bodyguardSelectionId,
      owned.binding.leaderSelectionId,
      ...owned.supportSelectionIds,
    ];
    for (const memberId of memberIds) {
      if (boundMemberIds.has(memberId)) {
        throw new LocalTesseraFormationError(
          "TESSERA_ATTACHMENT_MEMBER_REUSED",
          `Selection ${memberId} belongs to more than one attachment formation.`,
        );
      }
      boundMemberIds.add(memberId);
    }
    bindingByBodyguard.set(
      owned.binding.bodyguardSelectionId,
      owned,
    );
  }

  const formations: LocalTesseraCombatFormation[] = [];
  for (const unit of input.units) {
    const owned = bindingByBodyguard.get(unit.selectionId);
    if (!owned) {
      if (!boundMemberIds.has(unit.selectionId)) {
        formations.push(
          standaloneFormation(unit, input.attachmentPlanId),
        );
      }
      continue;
    }

    const leader = unitsBySelectionId.get(
      owned.binding.leaderSelectionId,
    );
    const supports = owned.supportSelectionIds.map((selectionId) =>
      unitsBySelectionId.get(selectionId),
    );
    if (!leader || supports.some((support) => !support)) {
      throw new LocalTesseraFormationError(
        "TESSERA_ATTACHMENT_MEMBER_MISSING",
        `Attachment binding ${owned.binding.leaderSelectionId}->${owned.binding.bodyguardSelectionId} references a missing local unit.`,
      );
    }

    const attached: LocalTesseraAttachedMember[] = [
      {
        ...leader,
        memberId: leader.selectionId,
        attachmentRole: "leader",
      },
      ...supports.map((support) => ({
        ...support!,
        memberId: support!.selectionId,
        attachmentRole: "support" as const,
      })),
    ];
    const members = [unit, ...attached];
    const points = totalPoints(members);
    const formationId = formationDigest({
      rosterFingerprint: input.rosterFingerprint,
      attachmentPlanId: input.attachmentPlanId,
      bodyguardSelectionId: unit.selectionId,
      leaderSelectionId: leader.selectionId,
      supportSelectionIds: owned.supportSelectionIds,
    });
    const label = [unit.label, ...attached.map((member) => member.label)]
      .join(" + ");
    formations.push({
      ...unit,
      name: label,
      label,
      instanceId: formationId,
      points: points ?? undefined,
      formationId,
      attachmentPlanId: input.attachmentPlanId,
      bodyguardSelectionId: unit.selectionId,
      leaderSelectionId: leader.selectionId,
      supportSelectionIds: [...owned.supportSelectionIds],
      memberSelectionIds: members.map((member) => member.selectionId),
      totalModels: members.reduce(
        (sum, member) => sum + member.models,
        0,
      ),
      totalPoints: points,
      attached,
    });
  }

  return formations;
}

export function localTesseraFormationModelTotal(
  unit: LocalTesseraEngineUnit | LocalTesseraCombatFormation,
): number {
  const candidate = unit as Partial<LocalTesseraCombatFormation>;
  if (
    typeof candidate.totalModels === "number" &&
    Number.isInteger(candidate.totalModels) &&
    candidate.totalModels > 0
  ) {
    return candidate.totalModels;
  }
  return unit.models;
}

