# Source and chart notes

Audience: general player/stakeholder. Delivery: one self-contained interactive HTML report.

Evidence is limited to the completed, receipt-bound Tessera Website baseline and Venatari exact reports plus their revision comparison. Both operations use the same locally verified RosterPilot bundle and exact World Eaters roster.

Chart map:

- Custodes damage and kills: matrix heat map; attacker by target; filtered by roster, phase, and volume metric; blue sequential palette; supports target-assignment coaching.
- Custodes wipe pressure: matrix heat map; attacker by target; filtered by roster, phase, and probability metric; blue sequential palette; supports removal-versus-softening decisions.
- World Eaters damage and kills: matrix heat map; attacker by target; same filters; supports defensive allocation.
- World Eaters wipe pressure: matrix heat map; attacker by target; same filters; supports threat screening.

Validation checks:

- Exact report SHA-256 values must match their adjacent receipts.
- Receipt and report run IDs must agree.
- Both operations must be complete and share one bundle ID.
- The revision report must bind the exact baseline and revised runs.
- All four heat-map datasets and eight aggregate metrics must be present.

Interpretation limitation: baseline aggregates contain 40 cells and revised aggregates contain 24 because the player roster changes from five units to three. This is a directional roster-level comparison, not a matched unit-for-unit experiment or game win probability.
