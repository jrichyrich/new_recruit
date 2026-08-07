import { listDataConflicts } from "../lib/rosterpilot/index.ts";

const custodesConflicts = listDataConflicts({ factionId: "adeptus-custodes" });
console.log("Custodes conflicts total:", custodesConflicts.total);
console.log("Custodes conflict items:", custodesConflicts.items.map(c => ({ entityId: c.entityId, entityName: c.entityName, message: c.message })));

const aeldariConflicts = listDataConflicts({ factionId: "aeldari" });
console.log("\nAeldari conflicts total:", aeldariConflicts.total);
console.log("Aeldari conflict items:", aeldariConflicts.items.map(c => ({ entityId: c.entityId, entityName: c.entityName, message: c.message })));
