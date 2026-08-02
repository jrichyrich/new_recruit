declare module "tessera-engine" {
  export function runSimulation(
    attacker: unknown,
    defender: unknown,
    options?: Record<string, unknown>,
  ): unknown;
}
