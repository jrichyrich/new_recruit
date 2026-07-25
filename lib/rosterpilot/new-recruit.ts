import { normalizeName } from "@alpaca-software/40kdc-data";

import type {
  DraftUnit,
  EquipmentSelection,
  RosterDraftV1,
} from "./types";

type XmlNode = Record<string, unknown>;

type CatalogueSelection = {
  name: string;
  type: "model" | "unit" | "upgrade";
  entryId: string;
  entryGroupId?: string;
  group?: string;
};

type CatalogueCategory = {
  name: string;
  entryId: string;
  primary: boolean;
};

type CatalogueModel = CatalogueSelection & {
  type: "model";
  equipment: CatalogueSelection[];
};

type CatalogueUnit = CatalogueSelection & {
  categories: CatalogueCategory[];
  directEquipment: CatalogueSelection[];
  models: CatalogueModel[];
  warlord?: CatalogueSelection;
};

const NEW_RECRUIT_XML = {
  battleScribeVersion: "2.03",
  catalogueId: "1f19-6509-d906-ca10",
  catalogueName: "Imperium - Adeptus Custodes",
  catalogueRevision: "5",
  forceEntryId: "bb9d-299a-ed60-2d8a",
  gameSystemId: "sys-352e-adc2-7639-d610",
  gameSystemName: "Warhammer 40,000 11th Edition",
  gameSystemRevision: "6",
  pointsTypeId: "51b2-306e-1021-d207",
  detachmentPointsTypeId: "82ae-1066-5107-6ae0",
  xmlns: "http://www.battlescribe.net/schema/rosterSchema",
  sourceRepository: "BSData/wh40k-11e",
  sourceCommit: "2f0942cff5f9f8d38f52eb50d3c226aafd8a6b17",
} as const;

const CONFIGURATION_CATEGORY = {
  id: "4ac9-fd30-1e3d-b249",
  entryId: "4ac9-fd30-1e3d-b249",
  name: "Configuration",
  primary: true,
} as const;

const CONFIGURATION = {
  battleSize: {
    name: "Battle Size",
    entryId: "7380-3e40-6ed6-b7cc::564e-fbc6-5266-3ea4",
    groupId: "7380-3e40-6ed6-b7cc::b960-4789-a3a6-59cb",
    group: "Battle Size",
    choices: {
      incursion: {
        name: "1. Incursion (1000 Point limit)",
        entryId: "7380-3e40-6ed6-b7cc::d62d-db22-4893-4bc0",
      },
      "strike-force": {
        name: "2. Strike Force (2000 Point limit)",
        entryId: "7380-3e40-6ed6-b7cc::baf8-997f-e323-a090",
      },
    },
  },
  detachment: {
    name: "Detachments",
    entryId: "9d4f-c524-e432-f877::5218-339c-eb34-9ac0",
    groupId: "9d4f-c524-e432-f877::3fba-26f0-8c24-6ab4",
    group: "Detachment",
    choices: {
      "shield-host": {
        name: "Shield Host",
        entryId: "9d4f-c524-e432-f877::70eb-2978-3ad5-5901",
        detachmentPoints: 2,
      },
    },
  },
  forceDisposition: {
    name: "Force Disposition",
    entryId: "8bc8-6bfe-78bd-2480::2f69-9148-45b4-86a8",
    groupId:
      "8bc8-6bfe-78bd-2480::9c70-af87-0c32-afcf::eece-6d68-6710-7a7f",
    group: "Force Disposition",
    choices: {
      "purge-the-foe": {
        name: "Purge the Foe",
        entryId:
          "8bc8-6bfe-78bd-2480::9c70-af87-0c32-afcf::7da4-f0a6-65ec-da48",
      },
    },
  },
} as const;

// Generated from BSData/wh40k-11e at NEW_RECRUIT_XML.sourceCommit. These are
// catalogue entry references, not RosterPilot selection-instance identifiers.
const CUSTODES_UNITS: Record<string, CatalogueUnit> = {
  "blade-champion": {
    name: "Blade Champion",
    type: "model",
    entryId: "473-b72d-a70b-e3aa::48b7-e713-d5b1-f11c",
    categories: [
      {
        name: "Blade Champion",
        entryId: "691e-fed6-a4b4-c66",
        primary: false,
      },
      { name: "Infantry", entryId: "cf47-a0d7-7207-29dc", primary: false },
      { name: "Character", entryId: "9cfd-1c32-585f-7d5c", primary: true },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
    ],
    directEquipment: [
      {
        name: "Vaultswords",
        type: "upgrade",
        entryId: "473-b72d-a70b-e3aa::f906-23b-58ce-a3df",
        entryGroupId: "473-b72d-a70b-e3aa::f610-42a4-d114-3181",
        group: "Wargear",
      },
    ],
    models: [],
    warlord: {
      name: "Warlord",
      type: "upgrade",
      entryId:
        "473-b72d-a70b-e3aa::a233-1cf6-8bf2-aeb8::0574-f558-2957-584f",
    },
  },
  "allarus-custodians": {
    name: "Allarus Custodians",
    type: "unit",
    entryId: "9f10-d8db-a7b3-5784::c8a6-a4c5-703e-b717",
    categories: [
      {
        name: "Allarus Custodians",
        entryId: "5386-42fc-f4d0-7d64",
        primary: false,
      },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
      {
        name: "Terminator",
        entryId: "740a-892c-8958-defa",
        primary: false,
      },
      { name: "Infantry", entryId: "cf47-a0d7-7207-29dc", primary: true },
    ],
    directEquipment: [],
    models: [
      {
        name: "Allarus Custodian (Guardian Spear)",
        type: "model",
        entryId: "9f10-d8db-a7b3-5784::b690-3f83-ec6a-401f",
        entryGroupId: "9f10-d8db-a7b3-5784::61e8-07d2-58ab-c98a",
        group: "Allarus Custodians",
        equipment: [
          {
            name: "Guardian Spear",
            type: "upgrade",
            entryId: "9f10-d8db-a7b3-5784::8a20-8c22-9f1a-bfdc",
          },
          {
            name: "Balistus grenade launcher",
            type: "upgrade",
            entryId:
              "9f10-d8db-a7b3-5784::352e-5ba4-521-cb1b::4863-f443-2b45-e18b",
          },
        ],
      },
      {
        name: "Allarus Custodian (Castellan Axe)",
        type: "model",
        entryId: "9f10-d8db-a7b3-5784::fab4-d437-6e07-eb33",
        entryGroupId: "9f10-d8db-a7b3-5784::61e8-07d2-58ab-c98a",
        group: "Allarus Custodians",
        equipment: [
          {
            name: "Castellan Axe",
            type: "upgrade",
            entryId: "9f10-d8db-a7b3-5784::94b3-ef7f-f71f-c86e",
          },
          {
            name: "Balistus grenade launcher",
            type: "upgrade",
            entryId:
              "9f10-d8db-a7b3-5784::4115-d26e-f72f-f727::4863-f443-2b45-e18b",
          },
        ],
      },
      {
        name: "Allarus Custodian (Vexilla & Misericordia)",
        type: "model",
        entryId: "9f10-d8db-a7b3-5784::cea8-14c8-fb23-d286",
        entryGroupId: "9f10-d8db-a7b3-5784::61e8-07d2-58ab-c98a",
        group: "Allarus Custodians",
        equipment: [
          {
            name: "Misericordia",
            type: "upgrade",
            entryId: "9f10-d8db-a7b3-5784::4dda-b6cf-5d1e-f003",
          },
          {
            name: "Balistus grenade launcher",
            type: "upgrade",
            entryId:
              "9f10-d8db-a7b3-5784::f306-9702-c9a-45d9::4863-f443-2b45-e18b",
          },
        ],
      },
    ],
  },
  "agamatus-custodians": {
    name: "Agamatus Custodians",
    type: "unit",
    entryId: "28a9-923b-c230-bc66::00ab-41c4-cf52-4ad2",
    categories: [
      { name: "Mounted", entryId: "14a0-40c9-2748-ae6e", primary: true },
      { name: "Fly", entryId: "c619-2086-bbcf-69c9", primary: false },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Agamatus Custodians",
        entryId: "20d4-956e-133e-153c",
        primary: false,
      },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
      { name: "Frame", entryId: "b927-8eeb-7cc3-8dec", primary: false },
    ],
    directEquipment: [],
    models: [
      {
        name: "Agamatus Custodian (Lastrum bolt cannon)",
        type: "model",
        entryId: "28a9-923b-c230-bc66::de32-bd86-91c0-6d95",
        entryGroupId: "28a9-923b-c230-bc66::3225-32dc-a9cf-d175",
        group: "Agamatus Custodians",
        equipment: [
          {
            name: "Lastrum bolt cannon",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::5a6-6596-5ea3-1140",
          },
          {
            name: "Interceptor Lance",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::8733-b3db-a4f3-9c28",
          },
        ],
      },
      {
        name: "Agamatus Custodian (Adrathic devastator)",
        type: "model",
        entryId: "28a9-923b-c230-bc66::509b-6148-c31d-45c8",
        entryGroupId: "28a9-923b-c230-bc66::3225-32dc-a9cf-d175",
        group: "Agamatus Custodians",
        equipment: [
          {
            name: "Adrathic devastator",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::8e79-eebf-91fc-472a",
          },
          {
            name: "Interceptor Lance",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::1e0e-59ef-ac1e-9737",
          },
        ],
      },
      {
        name: "Agamatus Custodian (Twin las-pulsar)",
        type: "model",
        entryId: "28a9-923b-c230-bc66::aae1-9f45-ab84-91dd",
        entryGroupId: "28a9-923b-c230-bc66::3225-32dc-a9cf-d175",
        group: "Agamatus Custodians",
        equipment: [
          {
            name: "Twin las-pulsar",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::b00-85a7-9a91-8eb8",
          },
          {
            name: "Interceptor Lance",
            type: "upgrade",
            entryId: "28a9-923b-c230-bc66::5679-7786-5bea-13d1",
          },
        ],
      },
    ],
  },
  "pallas-grav-attack": {
    name: "Pallas Grav-attack",
    type: "model",
    entryId: "7b13-004f-1fb5-97f8::06df-2fb2-8dfa-2fce",
    categories: [
      { name: "Vehicle", entryId: "dbd4-63-af05-998", primary: true },
      { name: "Fly", entryId: "c619-2086-bbcf-69c9", primary: false },
      {
        name: "Pallas Grav-attack",
        entryId: "822a-a9aa-c05f-52b3",
        primary: false,
      },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      { name: "Frame", entryId: "b927-8eeb-7cc3-8dec", primary: false },
    ],
    directEquipment: [
      {
        name: "Armoured hull",
        type: "upgrade",
        entryId: "7b13-004f-1fb5-97f8::5645-646-96f-9768",
        entryGroupId: "7b13-004f-1fb5-97f8::445a-d0a7-f252-1702",
        group: "Wargear",
      },
      {
        name: "Twin arachnus blaze cannon",
        type: "upgrade",
        entryId: "7b13-004f-1fb5-97f8::2693-63bf-611f-37fe",
        entryGroupId: "7b13-004f-1fb5-97f8::445a-d0a7-f252-1702",
        group: "Wargear",
      },
    ],
    models: [],
  },
  "custodian-guard": {
    name: "Custodian Guard",
    type: "unit",
    entryId: "d0ce-f2d3-358f-4530::91b3-2e1c-e642-d213",
    categories: [
      {
        name: "Custodian Guard",
        entryId: "c4f-4c5f-3507-e4bc",
        primary: false,
      },
      { name: "Infantry", entryId: "cf47-a0d7-7207-29dc", primary: false },
      { name: "Battleline", entryId: "e338-111e-d0c6-b687", primary: true },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
    ],
    directEquipment: [],
    models: [
      {
        name: "Custodian Guard (Guardian Spear)",
        type: "model",
        entryId: "d0ce-f2d3-358f-4530::5bbc-172f-4cb8-e6da",
        entryGroupId: "d0ce-f2d3-358f-4530::a293-9470-77c1-c8da",
        group: "4-5 Custodian Guard",
        equipment: [
          {
            name: "Guardian Spear",
            type: "upgrade",
            entryId: "d0ce-f2d3-358f-4530::e823-5718-f1b6-2702",
          },
        ],
      },
    ],
  },
  "vertus-praetors": {
    name: "Vertus Praetors",
    type: "unit",
    entryId: "6c75-afbb-c482-7e3e::918b-c9ed-7af7-74df",
    categories: [
      { name: "Fly", entryId: "c619-2086-bbcf-69c9", primary: false },
      { name: "Mounted", entryId: "14a0-40c9-2748-ae6e", primary: true },
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
      {
        name: "Vertus Praetors",
        entryId: "a3cb-da28-b5f9-d295",
        primary: false,
      },
      { name: "Frame", entryId: "b927-8eeb-7cc3-8dec", primary: false },
    ],
    directEquipment: [],
    models: [
      {
        name: "Vertus Praetor (Salvo Launcher)",
        type: "model",
        entryId: "6c75-afbb-c482-7e3e::6e14-a825-faf0-b220",
        entryGroupId: "6c75-afbb-c482-7e3e::69df-7851-7194-4fc0",
        group: "2-3 Vertus Praetors",
        equipment: [
          {
            name: "Interceptor lance",
            type: "upgrade",
            entryId: "6c75-afbb-c482-7e3e::e71e-8669-3d94-cc18",
          },
          {
            name: "Salvo launcher",
            type: "upgrade",
            entryId: "6c75-afbb-c482-7e3e::267-1ad2-6f36-20c1",
          },
        ],
      },
      {
        name: "Vertus Praetor (Hurricane Bolter)",
        type: "model",
        entryId: "6c75-afbb-c482-7e3e::5bd5-bca3-6228-ef17",
        entryGroupId: "6c75-afbb-c482-7e3e::69df-7851-7194-4fc0",
        group: "2-3 Vertus Praetors",
        equipment: [
          {
            name: "Interceptor lance",
            type: "upgrade",
            entryId: "6c75-afbb-c482-7e3e::5d80-129-8ba7-4730",
          },
          {
            name: "Vertus hurricane bolter",
            type: "upgrade",
            entryId: "6c75-afbb-c482-7e3e::5b3c-81c3-2c57-53fa",
          },
        ],
      },
    ],
  },
  "aquilon-custodians": {
    name: "Aquilon Custodians",
    type: "unit",
    entryId: "5874-5546-e4b2-4724::03bc-0141-b967-40e0",
    categories: [
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
      {
        name: "Terminator",
        entryId: "740a-892c-8958-defa",
        primary: false,
      },
      { name: "Infantry", entryId: "cf47-a0d7-7207-29dc", primary: true },
      {
        name: "Aquilon Custodians",
        entryId: "59aa-a7e1-0c60-b3ce",
        primary: false,
      },
    ],
    directEquipment: [],
    models: [
      {
        name: "Aquilon Custodian (Gauntlet & Lastrum bolter)",
        type: "model",
        entryId: "5874-5546-e4b2-4724::5165-cddb-885c-36e8",
        entryGroupId: "5874-5546-e4b2-4724::7c36-2977-4aba-fbfc",
        group: "Aquilon Custodians",
        equipment: [
          {
            name: "Solerite power gauntlet",
            type: "upgrade",
            entryId:
              "5874-5546-e4b2-4724::90d0-629b-8d48-2f0c::5ec7-5d19-a18b-25e4",
          },
          {
            name: "Lastrum storm bolter",
            type: "upgrade",
            entryId:
              "5874-5546-e4b2-4724::9cc9-89a4-e425-71a::47e0-7c05-18ba-bb02",
          },
        ],
      },
    ],
  },
  "venatari-custodians": {
    name: "Venatari Custodians",
    type: "unit",
    entryId: "15e2-1903-8d94-f574::201e-e502-a8d1-3974",
    categories: [
      { name: "Imperium", entryId: "aff3-d6a3-2a95-9dc", primary: false },
      { name: "Infantry", entryId: "cf47-a0d7-7207-29dc", primary: true },
      { name: "Fly", entryId: "c619-2086-bbcf-69c9", primary: false },
      { name: "Jump Pack", entryId: "dda2-bb0a-215e-ad9c", primary: false },
      {
        name: "Venatari Custodians",
        entryId: "0174-0ab8-d1c4-2cbd",
        primary: false,
      },
      {
        name: "Faction: Adeptus Custodes",
        entryId: "eea5-aeaf-bbf0-d5ee",
        primary: false,
      },
    ],
    directEquipment: [],
    models: [
      {
        name: "Venatari Custodian (Venatari lance)",
        type: "model",
        entryId: "15e2-1903-8d94-f574::d547-6d8a-58c7-d8d5",
        entryGroupId: "15e2-1903-8d94-f574::e46c-c154-2f14-8940",
        group: "3-6 Venatari Custodians",
        equipment: [
          {
            name: "Venatari lance",
            type: "upgrade",
            entryId: "15e2-1903-8d94-f574::1a23-1ceb-fc79-af67",
          },
        ],
      },
    ],
  },
};

const XML_COLLECTION_NAMES: Record<string, string> = {
  categories: "category",
  costs: "cost",
  forces: "force",
  selections: "selection",
};

function deterministicId(parts: Array<string | number>): string {
  let hash = 2166136261;
  for (const character of parts.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `rp-${(hash >>> 0).toString(36)}`;
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serializeXmlNode(tag: string, node: XmlNode): string {
  const attributes: string[] = [];
  const children: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const childTag = XML_COLLECTION_NAMES[key] ?? key.replace(/s$/, "");
      children.push(
        `<${key}>${value
          .map((child) => serializeXmlNode(childTag, child as XmlNode))
          .join("")}</${key}>`,
      );
      continue;
    }
    if (typeof value === "object") {
      children.push(serializeXmlNode(key, value as XmlNode));
      continue;
    }
    attributes.push(`${key}="${escapeXml(value)}"`);
  }

  const open = attributes.length ? `<${tag} ${attributes.join(" ")}>` : `<${tag}>`;
  return children.length
    ? `${open}${children.join("")}</${tag}>`
    : `${open.slice(0, -1)} />`;
}

function selectionFromReference(
  reference: CatalogueSelection,
  id: string,
  number: number,
): XmlNode {
  return {
    id,
    name: reference.name,
    entryId: reference.entryId,
    ...(reference.entryGroupId
      ? {
          entryGroupId: reference.entryGroupId,
          group: reference.group,
          from: "group",
        }
      : { from: "entry" }),
    number,
    type: reference.type,
  };
}

function equipmentReference(
  equipment: EquipmentSelection,
  references: CatalogueSelection[],
  selection: DraftUnit,
): CatalogueSelection {
  const normalizedName = normalizeName(equipment.name);
  const matches = references.filter(
    (reference) => normalizeName(reference.name) === normalizedName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `New Recruit catalogue mapping for ${selection.name} equipment "${equipment.name}" is ${
        matches.length === 0 ? "missing" : "ambiguous"
      }.`,
    );
  }
  return matches[0];
}

function modelForSelection(
  mapping: CatalogueUnit,
  selection: DraftUnit,
): CatalogueModel {
  const equippedNames = new Set(
    selection.equipment
      .filter((equipment) => equipment.count > 0)
      .map((equipment) => normalizeName(equipment.name)),
  );
  const ranked = mapping.models
    .map((model) => ({
      model,
      score: model.equipment.filter((equipment) =>
        equippedNames.has(normalizeName(equipment.name)),
      ).length,
    }))
    .sort((a, b) => b.score - a.score || a.model.name.localeCompare(b.model.name));
  const best = ranked[0];
  if (!best || best.score === 0 || ranked[1]?.score === best.score) {
    throw new Error(
      `New Recruit model mapping for ${selection.name} is missing or ambiguous.`,
    );
  }
  for (const equipment of selection.equipment) {
    if (equipment.count > 0 && equipment.count !== selection.modelCount) {
      throw new Error(
        `New Recruit export does not yet support mixed ${selection.name} model loadouts.`,
      );
    }
    equipmentReference(equipment, best.model.equipment, selection);
  }
  return best.model;
}

function rosterUnitSelection(selection: DraftUnit): XmlNode {
  const mapping = CUSTODES_UNITS[selection.unitId];
  if (!mapping) {
    throw new Error(
      `New Recruit catalogue mapping is unavailable for ${selection.name} (${selection.unitId}).`,
    );
  }
  if (selection.enhancementId) {
    throw new Error(
      `New Recruit enhancement mapping is unavailable for ${selection.enhancementName ?? selection.enhancementId}.`,
    );
  }

  const children: XmlNode[] = [];
  if (selection.isWarlord) {
    if (!mapping.warlord) {
      throw new Error(
        `New Recruit Warlord mapping is unavailable for ${selection.name}.`,
      );
    }
    children.push(
      selectionFromReference(
        mapping.warlord,
        deterministicId([selection.selectionId, "warlord"]),
        1,
      ),
    );
  }

  if (mapping.models.length > 0) {
    const model = modelForSelection(mapping, selection);
    const modelChildren = selection.equipment
      .filter((equipment) => equipment.count > 0)
      .map((equipment) =>
        selectionFromReference(
          equipmentReference(equipment, model.equipment, selection),
          deterministicId([
            selection.selectionId,
            "equipment",
            equipment.itemId,
          ]),
          equipment.count,
        ),
      );
    children.push({
      ...selectionFromReference(
        model,
        deterministicId([selection.selectionId, "model", model.entryId]),
        selection.modelCount,
      ),
      selections: modelChildren,
    });
  } else {
    children.push(
      ...selection.equipment
        .filter((equipment) => equipment.count > 0)
        .map((equipment) =>
          selectionFromReference(
            equipmentReference(
              equipment,
              mapping.directEquipment,
              selection,
            ),
            deterministicId([
              selection.selectionId,
              "equipment",
              equipment.itemId,
            ]),
            equipment.count,
          ),
        ),
    );
  }

  return {
    id: deterministicId([selection.selectionId, "new-recruit"]),
    name: mapping.name,
    entryId: mapping.entryId,
    number: 1,
    type: mapping.type,
    from: "entry",
    costs: [
      {
        name: "pts",
        typeId: NEW_RECRUIT_XML.pointsTypeId,
        value: selection.points,
      },
    ],
    categories: mapping.categories.map((category) => ({
      id: category.entryId,
      entryId: category.entryId,
      name: category.name,
      primary: category.primary,
    })),
    selections: children,
  };
}

function configurationSelections(draft: RosterDraftV1): XmlNode[] {
  const battleSize =
    CONFIGURATION.battleSize.choices[draft.battleSize as "incursion" | "strike-force"];
  if (!battleSize) {
    throw new Error(`New Recruit battle-size mapping is unavailable for ${draft.battleSize}.`);
  }
  const detachment =
    CONFIGURATION.detachment.choices[
      draft.detachmentId as keyof typeof CONFIGURATION.detachment.choices
    ];
  if (!detachment) {
    throw new Error(
      `New Recruit detachment mapping is unavailable for ${draft.detachmentName}.`,
    );
  }
  const disposition =
    CONFIGURATION.forceDisposition.choices[
      draft.forceDispositionId as keyof typeof CONFIGURATION.forceDisposition.choices
    ];
  if (!disposition) {
    throw new Error(
      `New Recruit force-disposition mapping is unavailable for ${draft.forceDispositionName}.`,
    );
  }

  return [
    {
      id: deterministicId([draft.id, "battle-size"]),
      name: CONFIGURATION.battleSize.name,
      entryId: CONFIGURATION.battleSize.entryId,
      number: 1,
      type: "upgrade",
      from: "entry",
      categories: [CONFIGURATION_CATEGORY],
      selections: [
        {
          id: deterministicId([draft.id, "battle-size", draft.battleSize]),
          name: battleSize.name,
          entryId: battleSize.entryId,
          entryGroupId: CONFIGURATION.battleSize.groupId,
          group: CONFIGURATION.battleSize.group,
          number: 1,
          type: "upgrade",
          from: "group",
          costs: [
            { name: "pts", typeId: NEW_RECRUIT_XML.pointsTypeId, value: 0 },
          ],
        },
      ],
    },
    {
      id: deterministicId([draft.id, "detachment"]),
      name: CONFIGURATION.detachment.name,
      entryId: CONFIGURATION.detachment.entryId,
      number: 1,
      type: "upgrade",
      from: "entry",
      categories: [CONFIGURATION_CATEGORY],
      selections: [
        {
          id: deterministicId([draft.id, "detachment", draft.detachmentId]),
          name: detachment.name,
          entryId: detachment.entryId,
          entryGroupId: CONFIGURATION.detachment.groupId,
          group: CONFIGURATION.detachment.group,
          number: 1,
          type: "upgrade",
          from: "group",
          costs: [
            {
              name: "Detachment Points",
              typeId: NEW_RECRUIT_XML.detachmentPointsTypeId,
              value: detachment.detachmentPoints,
            },
          ],
        },
      ],
    },
    {
      id: deterministicId([draft.id, "force-disposition"]),
      name: CONFIGURATION.forceDisposition.name,
      entryId: CONFIGURATION.forceDisposition.entryId,
      number: 1,
      type: "upgrade",
      from: "entry",
      categories: [CONFIGURATION_CATEGORY],
      selections: [
        {
          id: deterministicId([
            draft.id,
            "force-disposition",
            draft.forceDispositionId,
          ]),
          name: disposition.name,
          entryId: disposition.entryId,
          entryGroupId: CONFIGURATION.forceDisposition.groupId,
          group: CONFIGURATION.forceDisposition.group,
          number: 1,
          type: "upgrade",
          from: "group",
        },
      ],
    },
  ];
}

export function newRecruitRos(draft: RosterDraftV1): string {
  const roster: XmlNode = {
    id: deterministicId([draft.id, "roster"]),
    name: draft.name,
    battleScribeVersion: NEW_RECRUIT_XML.battleScribeVersion,
    generatedBy: "RosterPilot",
    gameSystemId: NEW_RECRUIT_XML.gameSystemId,
    gameSystemName: NEW_RECRUIT_XML.gameSystemName,
    gameSystemRevision: NEW_RECRUIT_XML.gameSystemRevision,
    xmlns: NEW_RECRUIT_XML.xmlns,
    costs: [
      {
        name: "pts",
        typeId: NEW_RECRUIT_XML.pointsTypeId,
        value: draft.totalPoints,
      },
    ],
    forces: [
      {
        id: deterministicId([draft.id, "force"]),
        name: "Army Roster",
        entryId: NEW_RECRUIT_XML.forceEntryId,
        catalogueId: NEW_RECRUIT_XML.catalogueId,
        catalogueRevision: NEW_RECRUIT_XML.catalogueRevision,
        catalogueName: NEW_RECRUIT_XML.catalogueName,
        selections: [
          ...configurationSelections(draft),
          ...draft.units.map(rosterUnitSelection),
        ],
      },
    ],
  };

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode("roster", roster)}`;
}
