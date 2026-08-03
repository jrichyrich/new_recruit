import { TimingSpanV1Schema, type TimingSpanV1 } from "./types";

export type CreateTimingSpanV1Input = {
  spanKind: TimingSpanV1["spanKind"];
  name: TimingSpanV1["name"];
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  clock?: TimingSpanV1["clock"];
};

export function createTimingSpanV1(
  input: CreateTimingSpanV1Input,
): TimingSpanV1 {
  const endedAt = input.endedAt ?? null;
  const durationMs =
    input.durationMs !== undefined
      ? input.durationMs
      : endedAt === null
        ? null
        : Math.max(0, Date.parse(endedAt) - Date.parse(input.startedAt));
  return TimingSpanV1Schema.parse({
    schemaVersion: 1,
    spanKind: input.spanKind,
    name: input.name,
    startedAt: input.startedAt,
    endedAt,
    durationMs,
    clock: input.clock ?? "wall-clock",
  });
}

export function completedTimingDuration(
  span: TimingSpanV1,
): number | null {
  return span.endedAt === null ? null : span.durationMs;
}
