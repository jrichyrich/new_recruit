import { chmodSync, appendFileSync } from "node:fs";

export function runFixtureTask(input) {
  if (!Object.isFrozen(input) || !Object.isFrozen(input.nested)) {
    const error = new Error("The fixture task was not deeply frozen.");
    error.code = "FIXTURE_INPUT_MUTABLE";
    throw error;
  }
  if (input.fail) {
    const error = new Error(`fixture failure: ${input.label}`);
    error.code = "FIXTURE_FAILURE";
    throw error;
  }
  if (input.crash) {
    if (input.attemptLogPath) {
      appendFileSync(input.attemptLogPath, `${process.pid}\n`, "utf8");
    }
    process.exit(73);
  }
  if (input.tamperInputFile) {
    const taskFile = process.env.ROSTERPILOT_LOCAL_ENGINE_TASK_FILE;
    if (!taskFile) throw new Error("The fixture did not receive a task file.");
    chmodSync(taskFile, 0o600);
    appendFileSync(taskFile, " ", "utf8");
  }
  const startedAt = Date.now();
  const deadline = Date.now() + input.spinMs;
  let checksum = 0;
  while (Date.now() < deadline) checksum = (checksum + 1) % 65_521;
  return {
    label: input.label,
    nestedValue: input.nested.value,
    checksum,
    processId: process.pid,
    startedAt,
    finishedAt: Date.now(),
  };
}

export function runDeterministicTask(input) {
  if (!Object.isFrozen(input) || !Object.isFrozen(input.values)) {
    const error = new Error("The deterministic fixture input was not frozen.");
    error.code = "FIXTURE_INPUT_MUTABLE";
    throw error;
  }
  if (input.globalFailure) {
    const error = new Error("fixture provider unavailable");
    error.code = "FIXTURE_PROVIDER_UNAVAILABLE";
    throw error;
  }
  const deadline = Date.now() + input.spinMs;
  while (Date.now() < deadline) {
    // Exercise bounded CPU concurrency without changing the result.
  }
  return {
    id: input.id,
    sum: input.values.reduce((total, value) => total + value, 0),
    seed: input.seed,
  };
}
