import type { FormFactor } from "../types/config.js";
import type { ResultStatus } from "../types/report.js";

export interface RunError {
  runIndex: number;
  message: string;
}

export interface SuccessfulRun<Lhr = any> {
  runIndex: number;
  lhr: Lhr;
}

export interface RunRouteAuditsInput<Lhr = any> {
  url: string;
  route: string;
  formFactor: FormFactor;
  runsTotal: number;
  runOnce: (url: string, runIndex: number) => Promise<Lhr>;
  selectMedian?: (lhrs: Lhr[]) => Lhr | Promise<Lhr>;
  isFatalError?: (error: unknown) => boolean;
  onRunComplete: (event: { runIndex: number; ok: boolean; durationMs: number; error?: string }) => Promise<void> | void;
}

export interface RunRouteAuditsResult<Lhr = any> {
  status: ResultStatus;
  lhrs: Lhr[];
  successfulRuns: SuccessfulRun<Lhr>[];
  medianLhr: Lhr | null;
  medianRunIndex: number | null;
  errors: RunError[];
}

export async function runRouteAudits<Lhr = any>(input: RunRouteAuditsInput<Lhr>): Promise<RunRouteAuditsResult<Lhr>> {
  const lhrs: Lhr[] = [];
  const successfulRuns: SuccessfulRun<Lhr>[] = [];
  const errors: RunError[] = [];

  for (let runIndex = 1; runIndex <= input.runsTotal; runIndex += 1) {
    const startedAt = Date.now();
    try {
      const lhr = await input.runOnce(input.url, runIndex);
      lhrs.push(lhr);
      successfulRuns.push({ runIndex, lhr });
      await input.onRunComplete({ runIndex, ok: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      if (input.isFatalError?.(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runIndex, message });
      await input.onRunComplete({ runIndex, ok: false, durationMs: Date.now() - startedAt, error: message });
    }
  }

  const minimumSuccessfulRuns = Math.ceil(input.runsTotal / 2);
  if (lhrs.length < minimumSuccessfulRuns) {
    return {
      status: "failed",
      lhrs,
      successfulRuns,
      medianLhr: null,
      medianRunIndex: null,
      errors
    };
  }

  const medianLhr = await (input.selectMedian ?? defaultSelectMedian)(lhrs);
  const medianArrayIndex = lhrs.findIndex((lhr) => lhr === medianLhr);

  return {
    status: lhrs.length === input.runsTotal ? "ok" : "degraded",
    lhrs,
    successfulRuns,
    medianLhr,
    medianRunIndex: medianArrayIndex >= 0 ? successfulRuns[medianArrayIndex]?.runIndex ?? null : null,
    errors
  };
}

async function defaultSelectMedian<Lhr>(lhrs: Lhr[]): Promise<Lhr> {
  const mod = await import("lighthouse/core/lib/median-run.js");
  return mod.computeMedianRun(lhrs as any[]) as Lhr;
}
