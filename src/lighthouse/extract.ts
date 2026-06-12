import type { FormFactor, LighthouseCategory } from "../types/config.js";
import type { CategoryScores, DiagnosticEntry, FormFactorReport, MedianMetrics, Opportunity, RawRun, ResultStatus } from "../types/report.js";
import type { SuccessfulRun } from "./run-route.js";

const categoryIds: LighthouseCategory[] = ["performance", "accessibility", "best-practices", "seo", "pwa"];

const auditMetricMap = {
  lcp: "largest-contentful-paint",
  cls: "cumulative-layout-shift",
  tbt: "total-blocking-time",
  fcp: "first-contentful-paint",
  speedIndex: "speed-index",
  tti: "interactive",
  maxPotentialFid: "max-potential-fid"
} as const;

export interface ExtractFormFactorReportInput {
  route: string;
  formFactor: FormFactor;
  status: ResultStatus;
  runsOk: number;
  runsTotal: number;
  medianRunIndex: number | null;
  medianLhr: any;
  successfulRuns: SuccessfulRun[];
  startedAt: string;
}

export function extractFormFactorReport(input: ExtractFormFactorReportInput): {
  result: FormFactorReport;
  diagnostics: DiagnosticEntry[];
} {
  const result: FormFactorReport = {
    route: input.route,
    formFactor: input.formFactor,
    status: input.status,
    runsOk: input.runsOk,
    runsTotal: input.runsTotal,
    medianRunIndex: input.medianRunIndex,
    scores: extractScores(input.medianLhr),
    metrics: extractMedianMetrics(input.medianLhr),
    runs: input.successfulRuns.map((run) => extractRawRun(run.lhr, run.runIndex)),
    opportunities: extractOpportunities(input.medianLhr)
  };

  return {
    result,
    diagnostics: extractDiagnostics(input)
  };
}

export function extractScores(lhr: any): CategoryScores {
  return Object.fromEntries(
    categoryIds.map((category) => [category, scoreToPercent(lhr?.categories?.[category]?.score)])
  ) as CategoryScores;
}

function extractMedianMetrics(lhr: any): MedianMetrics {
  return {
    lcp: metricScore(lhr, auditMetricMap.lcp),
    cls: metricScore(lhr, auditMetricMap.cls),
    tbt: metricScore(lhr, auditMetricMap.tbt),
    fcp: metricScore(lhr, auditMetricMap.fcp),
    speedIndex: metricScore(lhr, auditMetricMap.speedIndex),
    tti: metricScore(lhr, auditMetricMap.tti),
    maxPotentialFid: metricScore(lhr, auditMetricMap.maxPotentialFid)
  };
}

function extractRawRun(lhr: any, runIndex: number): RawRun {
  return {
    runIndex,
    lighthouseVersion: typeof lhr?.lighthouseVersion === "string" ? lhr.lighthouseVersion : undefined,
    chromeVersion: extractChromeVersion(lhr),
    scores: extractScores(lhr),
    metrics: {
      lcp: numberOrNull(lhr?.audits?.[auditMetricMap.lcp]?.numericValue),
      cls: numberOrNull(lhr?.audits?.[auditMetricMap.cls]?.numericValue),
      tbt: numberOrNull(lhr?.audits?.[auditMetricMap.tbt]?.numericValue),
      fcp: numberOrNull(lhr?.audits?.[auditMetricMap.fcp]?.numericValue),
      speedIndex: numberOrNull(lhr?.audits?.[auditMetricMap.speedIndex]?.numericValue),
      tti: numberOrNull(lhr?.audits?.[auditMetricMap.tti]?.numericValue),
      maxPotentialFid: numberOrNull(lhr?.audits?.[auditMetricMap.maxPotentialFid]?.numericValue)
    }
  };
}

function extractChromeVersion(lhr: any): string | undefined {
  const userAgent = String(lhr?.environment?.hostUserAgent ?? lhr?.userAgent ?? "");
  const match = userAgent.match(/(?:Chrome|Chromium)\/([0-9.]+)/);
  return match?.[1];
}

function extractOpportunities(lhr: any): Opportunity[] {
  const audits = Object.entries(lhr?.audits ?? {});
  return audits
    .map(([auditId, audit]) => {
      const item = audit as any;
      return {
        auditId,
        title: String(item.title ?? auditId),
        savingsMs: numberOrNull(item.details?.overallSavingsMs) ?? 0,
        description: String(item.description ?? "")
      };
    })
    .filter((item) => item.savingsMs > 0)
    .sort((left, right) => right.savingsMs - left.savingsMs)
    .slice(0, 10);
}

function extractDiagnostics(input: ExtractFormFactorReportInput): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  const runtimeError = input.medianLhr?.runtimeError;
  if (runtimeError) {
    diagnostics.push({
      timestamp: input.startedAt,
      route: input.route,
      formFactor: input.formFactor,
      runIndex: input.medianRunIndex ?? undefined,
      severity: "error",
      code: String(runtimeError.code ?? "RUNTIME_ERROR"),
      message: String(runtimeError.message ?? runtimeError.code ?? "Lighthouse runtime error")
    });
  }

  for (const warning of input.medianLhr?.runWarnings ?? []) {
    diagnostics.push({
      timestamp: input.startedAt,
      route: input.route,
      formFactor: input.formFactor,
      runIndex: input.medianRunIndex ?? undefined,
      severity: "warning",
      code: "RUN_WARNING",
      message: String(warning)
    });
  }

  return diagnostics;
}

function metricScore(lhr: any, auditId: string) {
  const audit = lhr?.audits?.[auditId];
  return {
    value: numberOrNull(audit?.numericValue),
    score: scoreToPercent(audit?.score)
  };
}

function scoreToPercent(score: unknown): number | null {
  return typeof score === "number" ? Math.round(score * 100) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
