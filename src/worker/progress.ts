import type { FormFactor } from "../types/config.js";

export interface ProgressInput {
  route: string;
  formFactor: FormFactor;
  runIndex: number;
  runsTotal: number;
  completedRuns: number;
  totalRuns: number;
  completedRunDurationsMs: number[];
}

export interface ProgressPayload {
  percent: number;
  phase: "lighthouse-run";
  message: string;
  currentRoute: string;
  formFactor: FormFactor;
  runIndex: number;
  runsTotal: number;
  completedRuns: number;
  totalRuns: number;
  etaSeconds: number;
}

export function buildProgressPayload(input: ProgressInput): ProgressPayload {
  const averageDurationMs = input.completedRunDurationsMs.length
    ? input.completedRunDurationsMs.reduce((sum, duration) => sum + duration, 0) / input.completedRunDurationsMs.length
    : 0;
  const remainingRuns = Math.max(0, input.totalRuns - input.completedRuns);

  return {
    percent: Math.round((input.completedRuns / input.totalRuns) * 100),
    phase: "lighthouse-run",
    message: `Running Lighthouse ${input.runIndex}/${input.runsTotal} on ${input.route} (${input.formFactor})`,
    currentRoute: input.route,
    formFactor: input.formFactor,
    runIndex: input.runIndex,
    runsTotal: input.runsTotal,
    completedRuns: input.completedRuns,
    totalRuns: input.totalRuns,
    etaSeconds: Math.round((averageDurationMs * remainingRuns) / 1000)
  };
}
