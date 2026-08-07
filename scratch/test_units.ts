import { searchUnits } from "../lib/rosterpilot/index.ts";

const aeldariUnits = searchUnits({ factionId: "aeldari" });
console.log("Aeldari unit IDs:");
console.log(aeldariUnits.data?.map(u => u.id).filter(id => !id.startsWith("gilded")));
