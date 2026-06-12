import type { AuditEnvironment, AuditMode, FormFactor, LighthouseCategory, ManualChromeCachePolicy, ManualChromeEvidenceMode } from "./config.js";

export type JobTerminalStatus = "completed" | "failed" | "partial";
export type ResultStatus = "ok" | "degraded" | "failed";
export type DiagnosticSeverity = "info" | "warning" | "error";

export type CategoryScores = Record<LighthouseCategory, number | null>;

export interface MetricScore {
  value: number | null;
  score: number | null;
}

export interface MedianMetrics {
  lcp: MetricScore;
  cls: MetricScore;
  tbt: MetricScore;
  fcp: MetricScore;
  speedIndex: MetricScore;
  tti: MetricScore;
  maxPotentialFid: MetricScore;
}

export interface RawRun {
  runIndex: number;
  lighthouseVersion?: string | undefined;
  chromeVersion?: string | undefined;
  scores: CategoryScores;
  metrics: {
    lcp?: number | null;
    cls?: number | null;
    tbt?: number | null;
    fcp?: number | null;
    speedIndex?: number | null;
    tti?: number | null;
    maxPotentialFid?: number | null;
  };
}

export interface Opportunity {
  auditId: string;
  title: string;
  savingsMs: number;
  description: string;
}

export interface FormFactorReport {
  route: string;
  formFactor: FormFactor;
  status: ResultStatus;
  runsOk: number;
  runsTotal: number;
  medianRunIndex: number | null;
  scores: CategoryScores;
  metrics: MedianMetrics;
  runs: RawRun[];
  opportunities: Opportunity[];
}

export interface RouteReport {
  route: string;
  url: string;
  environment?: AuditEnvironment | undefined;
  results: FormFactorReport[];
}

export interface DiagnosticEntry {
  timestamp: string;
  route: string;
  formFactor?: FormFactor | undefined;
  runIndex?: number | undefined;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
}

export interface AuditReport {
  jobId: string;
  mode?: AuditMode | undefined;
  cachePolicy?: ManualChromeCachePolicy | undefined;
  evidenceMode?: ManualChromeEvidenceMode | undefined;
  baseUrl: string;
  displayName: string;
  environments?: AuditEnvironment[] | undefined;
  startedAt: string;
  finishedAt: string;
  lighthouseVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  categories: LighthouseCategory[];
  formFactors: FormFactor[];
  runsPerPage: number;
  throttlingLabel: string;
  throttling: Record<string, number>;
  authSummary: string;
  routes: RouteReport[];
  diagnostics: DiagnosticEntry[];
  summary: {
    totalRoutes: number;
    totalRuns: number;
    successfulRuns: number;
    durationSec: number;
    status: JobTerminalStatus;
  };
}
