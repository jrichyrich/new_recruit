import {
  allocateStandardDamage,
  type ModelWoundState,
} from "./local/tessera/game-loop-simulator";

console.log("=========================================================================");
console.log("        MATHHAMMER PROBABILITY & EXPECTED VALUE ANALYSIS                 ");
console.log("             ADEPTUS CUSTODES VS WORLD EATERS (1,000 PTS)                 ");
console.log("=========================================================================\n");

interface WeaponProfile {
  name: string;
  attacks: number;
  bsWs: number; // e.g. 2 for 2+
  strength: number;
  ap: number; // e.g. 3 for AP -3
  damage: number;
  lethalHits?: boolean;
  devastatingWounds?: boolean;
  rerollWounds?: boolean;
}

interface DefenderProfile {
  name: string;
  toughness: number;
  save: number; // e.g. 2 for 2+
  invulnSave?: number; // e.g. 4 for 4++
  woundsPerModel: number;
  modelCount: number;
}

function calculateMathhammer(weapon: WeaponProfile, defender: DefenderProfile) {
  // 1. Expected Hits
  const hitProb = (7 - weapon.bsWs) / 6;
  const expectedHits = weapon.attacks * hitProb;

  // 2. Expected Wounds
  let woundRollNeeded = 4;
  if (weapon.strength >= defender.toughness * 2) woundRollNeeded = 2;
  else if (weapon.strength > defender.toughness) woundRollNeeded = 3;
  else if (weapon.strength === defender.toughness) woundRollNeeded = 4;
  else if (weapon.strength <= defender.toughness / 2) woundRollNeeded = 6;
  else woundRollNeeded = 5;

  let woundProb = (7 - woundRollNeeded) / 6;
  if (weapon.rerollWounds) {
    woundProb = woundProb + (1 - woundProb) * woundProb;
  }

  const expectedWounds = expectedHits * woundProb;

  // 3. Expected Unsaved Wounds (Armor/Invuln Save)
  let effectiveSave = defender.save + weapon.ap;
  if (defender.invulnSave) {
    effectiveSave = Math.min(effectiveSave, defender.invulnSave);
  }
  let failSaveProb = (effectiveSave - 1) / 6;
  failSaveProb = Math.min(1.0, Math.max(0.0, failSaveProb));

  const expectedUnsaved = expectedWounds * failSaveProb;
  const expectedDamageTotal = expectedUnsaved * weapon.damage;

  // Simulate exact model allocation
  const defenderModels: ModelWoundState[] = Array.from({ length: defender.modelCount }, (_, i) => ({
    modelIndex: i,
    currentWounds: defender.woundsPerModel,
    maxWounds: defender.woundsPerModel,
  }));

  const roundUnsaved = Math.round(expectedUnsaved);
  const alloc = allocateStandardDamage(defenderModels, weapon.damage, roundUnsaved);

  return {
    expectedHits: Math.round(expectedHits * 10) / 10,
    expectedWounds: Math.round(expectedWounds * 10) / 10,
    expectedUnsaved: Math.round(expectedUnsaved * 10) / 10,
    expectedDamageTotal: Math.round(expectedDamageTotal * 10) / 10,
    modelsKilled: alloc.modelsDestroyed,
    damageWasted: alloc.damageWasted,
  };
}

// MATCHUP 1: Custodes Blade Champion (Victus) vs World Eaters Lord on Juggernaut
const bladeChampVictus: WeaponProfile = {
  name: "Blade Champion (Victus Stance)",
  attacks: 6,
  bsWs: 2,
  strength: 7,
  ap: 3,
  damage: 3,
};
const lordOnJuggernaut: DefenderProfile = {
  name: "Lord on Juggernaut",
  toughness: 6,
  save: 2,
  invulnSave: 4,
  woundsPerModel: 7,
  modelCount: 1,
};

// MATCHUP 2: 6 Allarus Custodians vs World Eaters Khorne Lord of Skulls
const allarusSpears: WeaponProfile = {
  name: "6 Allarus Custodians (Melee Spears)",
  attacks: 30,
  bsWs: 2,
  strength: 7,
  ap: 2,
  damage: 2,
  rerollWounds: true,
};
const lordOfSkulls: DefenderProfile = {
  name: "Khorne Lord of Skulls",
  toughness: 11,
  save: 2,
  invulnSave: 5,
  woundsPerModel: 18,
  modelCount: 1,
};

// MATCHUP 3: Khorne Lord of Skulls (Cleaver) vs 6 Allarus Custodians
const lordOfSkullsCleaver: WeaponProfile = {
  name: "Lord of Skulls (Great Cleaver Strike)",
  attacks: 6,
  bsWs: 2,
  strength: 16,
  ap: 4,
  damage: 6,
};
const allarusDefend: DefenderProfile = {
  name: "Allarus Custodians Squad",
  toughness: 7,
  save: 2,
  invulnSave: 4,
  woundsPerModel: 6,
  modelCount: 6,
};

// MATCHUP 4: Eightbound vs Custodian Guard
const eightboundWeapons: WeaponProfile = {
  name: "3 Eightbound (Lacerators)",
  attacks: 18,
  bsWs: 3,
  strength: 9,
  ap: 2,
  damage: 2,
};
const custodesGuard: DefenderProfile = {
  name: "5 Custodian Guard Squad",
  toughness: 6,
  save: 2,
  invulnSave: 4,
  woundsPerModel: 3,
  modelCount: 5,
};

console.log("MATCHUP 1: " + bladeChampVictus.name + " ---> " + lordOnJuggernaut.name);
const res1 = calculateMathhammer(bladeChampVictus, lordOnJuggernaut);
console.log(`Hits: ${res1.expectedHits} | Wounds: ${res1.expectedWounds} | Unsaved: ${res1.expectedUnsaved} | Raw Dmg: ${res1.expectedDamageTotal} | Models Killed: ${res1.modelsKilled}\n`);

console.log("MATCHUP 2: " + allarusSpears.name + " ---> " + lordOfSkulls.name);
const res2 = calculateMathhammer(allarusSpears, lordOfSkulls);
console.log(`Hits: ${res2.expectedHits} | Wounds: ${res2.expectedWounds} | Unsaved: ${res2.expectedUnsaved} | Raw Dmg: ${res2.expectedDamageTotal} | Models Killed: ${res2.modelsKilled}\n`);

console.log("MATCHUP 3: " + lordOfSkullsCleaver.name + " ---> " + allarusDefend.name);
const res3 = calculateMathhammer(lordOfSkullsCleaver, allarusDefend);
console.log(`Hits: ${res3.expectedHits} | Wounds: ${res3.expectedWounds} | Unsaved: ${res3.expectedUnsaved} | Raw Dmg: ${res3.expectedDamageTotal} | Models Killed: ${res3.modelsKilled} | Dmg Wasted: ${res3.damageWasted}\n`);

console.log("MATCHUP 4: " + eightboundWeapons.name + " ---> " + custodesGuard.name);
const res4 = calculateMathhammer(eightboundWeapons, custodesGuard);
console.log(`Hits: ${res4.expectedHits} | Wounds: ${res4.expectedWounds} | Unsaved: ${res4.expectedUnsaved} | Raw Dmg: ${res4.expectedDamageTotal} | Models Killed: ${res4.modelsKilled}\n`);

console.log("=========================================================================\n");
