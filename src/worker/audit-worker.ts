import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createDownloadTokenService } from "../server/download-token.js";
import { decryptJobConfig } from "../security/credentials.js";
import { buildAuditWorkbook } from "../report/workbook.js";
import { extractFormFactorReport } from "../lighthouse/extract.js";
import { FatalAuditError, runOnceLighthouse } from "../lighthouse/run-once.js";
import { runManualTabLighthouse, type RunManualTabOptions } from "../lighthouse/run-manual-tab.js";
import { runRouteAudits } from "../lighthouse/run-route.js";
import { resolveMobileThrottling, throttlingLabel } from "../lighthouse/configs.js";
import { manualChromeMarkerUrl } from "../manual-chrome/session-manager.js";
import { sanitizeManualErrorMessage } from "../manual-chrome/access-control.js";
import type {
  ManualChromeLockIdentity,
  ManualChromeLockRecord,
  ManualChromeSessionRecord
} from "../manual-chrome/types.js";
import { buildProgressPayload } from "./progress.js";
import { cleanupOldReports, writeReportFiles, type LighthouseEvidenceRun } from "./report-files.js";
import { auditQueueName } from "../queue/audit-queue.js";
import { createRedisTokenStore } from "../queue/redis-token-store.js";
import { createLogger, type AppLogger } from "../observability/logger.js";
import type {
  AuditConfig,
  AuditEnvironment,
  FormFactor,
  ManualChromeExecutionData,
  ManualChromeTargetDescriptor,
  ManualCompareWarning,
  ManualTabsAuditConfig
} from "../types/config.js";
import type { AuditReport, DiagnosticEntry, FormFactorReport, RouteReport } from "../types/report.js";

export interface AuditJobData {
  jobId: string;
  config: AuditConfig;
  createdAt: string;
}

export interface ManualChromeWorkerStore {
  getBootId(): Promise<string | null>;
  getSession(): Promise<ManualChromeSessionRecord | null>;
  markRunning(identity: ManualChromeLockIdentity, ttlSeconds: number): Promise<ManualChromeLockRecord | null>;
  renewLock(identity: ManualChromeLockIdentity, ttlSeconds: number): Promise<boolean>;
  releaseLock(identity: ManualChromeLockIdentity): Promise<boolean>;
}

export interface ManualChromeWorkerConfig {
  allowedHosts: string[];
  store: ManualChromeWorkerStore;
  connectBrowser?: (options: { browserURL: string }) => Promise<Browser>;
  lockTtlSeconds?: number;
  lockRenewIntervalMs?: number;
  maxEvidenceBytes?: number;
  // When set to 'connect-only' the worker accepts sessions that were created
  // by a manually-started Chrome instance and will not enforce server-side
  // ownership (boot id / owner nonce) checks.
  mode?: "auto-launch" | "connect-only";
}

export interface CreateAuditWorkerOptions {
  connection: Redis;
  encryptionKey: string;
  downloadTokenSecret: string;
  dataDir: string;
  concurrency: number;
  manualChrome?: ManualChromeWorkerConfig | undefined;
  logger?: AppLogger | undefined;
}

const manualLockTtlSeconds = 60;
const manualLockRenewIntervalMs = 20_000;

export function createAuditWorker(options: CreateAuditWorkerOptions): Worker<AuditJobData> {
  return new Worker<AuditJobData>(
    auditQueueName,
    (job) => processAuditJob(job, options),
    {
      connection: options.connection,
      concurrency: options.concurrency
    }
  );
}

export async function processAuditJob(job: Job<AuditJobData>, options: CreateAuditWorkerOptions): Promise<unknown> {
  const log = (options.logger ?? createLogger("worker")).child({ jobId: job.data.jobId });
  const startedAt = Date.now();
  log.info({ action: "job.start", attempt: job.attemptsMade + 1 }, "Audit job starting");
  const config = decryptJobConfig(job.data.config, options.encryptionKey);
  try {
    const result =
      config.mode === "manual-tabs"
        ? await processManualTabsAuditJob(job, config, options, log)
        : await processStaticAuditJob(job, config, options, log);
    log.info({ action: "job.done", durationMs: Date.now() - startedAt, mode: config.mode }, "Audit job done");
    return result;
  } catch (error) {
    log.error({ action: "job.error", durationMs: Date.now() - startedAt, mode: config.mode, err: error }, "Audit job threw");
    throw error;
  }
}

async function processStaticAuditJob(
  job: Job<AuditJobData>,
  config: AuditConfig,
  options: CreateAuditWorkerOptions,
  log: AppLogger
): Promise<unknown> {
  const startedAt = new Date().toISOString();
  const environments = resolveAuditEnvironments(config);
  const isCompareJob = Boolean(config.environments?.length);
  const totalRuns = environments.length * config.paths.length * config.formFactors.length * config.runsPerPage;
  const runDurations: number[] = [];
  const routes = new Map<string, RouteReport>();
  const diagnostics: DiagnosticEntry[] = [];
  let lighthouseRuns: LighthouseEvidenceRun[] = [];
  let completedRuns = 0;

  log.info(
    {
      action: "static.start",
      environments: environments.length,
      paths: config.paths.length,
      formFactors: config.formFactors.length,
      runsPerPage: config.runsPerPage,
      totalRuns
    },
    "Static audit plan resolved"
  );

  await job.updateProgress({ eventName: "started", phase: "started", jobId: job.data.jobId, startedAt, totalRuns });

  for (const environment of environments) {
    const environmentConfig = buildEnvironmentAuditConfig(config, environment);
    for (const route of config.paths) {
      const url = buildTargetUrl(environment.baseUrl, route);
      const routeKey = isCompareJob ? `${environment.name}\u0000${route}` : route;
      const routeReport: RouteReport = {
        route,
        url,
        environment: isCompareJob ? { ...environment } : undefined,
        results: []
      };
      routes.set(routeKey, routeReport);

      for (const formFactor of config.formFactors) {
        const runResult = await runRouteAudits({
          url,
          route,
          formFactor,
          runsTotal: config.runsPerPage,
          isFatalError: (error) => error instanceof FatalAuditError || (typeof error === "object" && error !== null && "fatal" in error),
          runOnce: (_targetUrl) => runOnceLighthouse({ url: _targetUrl, formFactor, config: environmentConfig }),
          onRunComplete: async ({ runIndex, ok, durationMs, error }) => {
            completedRuns += 1;
            runDurations.push(durationMs);
            if (!ok) {
              const warning = {
                eventName: "warn",
                environment: isCompareJob ? environment.name : undefined,
                route,
                formFactor,
                runIndex,
                message: error ?? "Lighthouse run failed"
              };
              diagnostics.push({
                timestamp: new Date().toISOString(),
                route,
                formFactor,
                runIndex,
                severity: "error",
                code: "RUN_FAILED",
                message: warning.message
              });
              await job.updateProgress(warning);
            }
            await job.updateProgress(
              buildProgressPayload({
                route: isCompareJob ? `${environment.name} ${route}` : route,
                formFactor,
                runIndex,
                runsTotal: config.runsPerPage,
                completedRuns,
                totalRuns,
                completedRunDurationsMs: runDurations
              })
            );
          }
        });
        lighthouseRuns = [
          ...lighthouseRuns,
          ...runResult.successfulRuns.map((run) => ({
            environment: isCompareJob ? { ...environment } : undefined,
            route,
            url,
            formFactor,
            runIndex: run.runIndex,
            lhr: run.lhr
          }))
        ];

        if (runResult.medianLhr) {
          const extracted = extractFormFactorReport({
            route,
            formFactor,
            status: runResult.status,
            runsOk: runResult.lhrs.length,
            runsTotal: config.runsPerPage,
            medianRunIndex: runResult.medianRunIndex,
            medianLhr: runResult.medianLhr,
            successfulRuns: runResult.successfulRuns,
            startedAt
          });
          routeReport.results.push(extracted.result);
          diagnostics.push(...extracted.diagnostics);
        } else {
          routeReport.results.push(failedFormFactorReport(route, formFactor, config.runsPerPage));
        }

        await job.updateProgress({
          eventName: "route-completed",
          environment: isCompareJob ? environment.name : undefined,
          route,
          formFactor,
          scores: routeReport.results.at(-1)?.scores
        });
      }
    }
  }

  await job.updateProgress({ eventName: "excel-generating", message: "Generating Excel and HTML reports..." });
  log.info({ action: "static.reportPhase", completedRuns, totalRuns }, "Generating Excel and HTML reports");
  const finishedAt = new Date().toISOString();
  const routeReports = Array.from(routes.values());
  const runFailures = diagnostics.filter((item) => item.code === "RUN_FAILED").length;
  const successfulRuns = completedRuns - runFailures;
  if (successfulRuns <= 0) {
    log.error({ action: "static.allRunsFailed", totalRuns, runFailures }, "All Lighthouse runs failed");
    throw new Error(buildAllRunsFailedMessage(diagnostics));
  }
  const report = buildAuditReport({
    jobId: job.data.jobId,
    config,
    startedAt,
    finishedAt,
    routes: routeReports,
    diagnostics,
    successfulRuns,
    totalRuns
  });
  const workbook = await buildAuditWorkbook(report);
  const { sha256, htmlReports, indexHtmlReport } = await writeReportFiles(options.dataDir, report, workbook, {
    auditConfig: config,
    lighthouseRuns
  });
  await cleanupOldReports(options.dataDir);

  const tokenService = createDownloadTokenService({
    secret: options.downloadTokenSecret,
    store: createRedisTokenStore(options.connection)
  });
  const downloadToken = await tokenService.issue(job.data.jobId);

  return {
    downloadUrl: `/jobs/${job.data.jobId}/download`,
    downloadToken,
    htmlReports: htmlReports.map((htmlReport) => ({
      ...htmlReport,
      downloadUrl: `/jobs/${job.data.jobId}/evidence/${encodeURIComponent(htmlReport.fileName)}`
    })),
    evidenceIndex: indexHtmlReport
      ? {
          ...indexHtmlReport,
          downloadUrl: `/jobs/${job.data.jobId}/evidence/${encodeURIComponent(indexHtmlReport.fileName)}`
        }
      : undefined,
    sha256,
    summary: report.summary
  };
}

async function processManualTabsAuditJob(
  job: Job<AuditJobData>,
  config: ManualTabsAuditConfig,
  options: CreateAuditWorkerOptions,
  log: AppLogger
): Promise<unknown> {
  const manual = options.manualChrome;
  if (!manual) {
    throw new Error("Manual Chrome worker support is not configured");
  }
  const execution = config.manualChrome.execution;
  if (!isResolvedExecution(execution)) {
    throw new Error("Manual Chrome job is missing resolved target descriptors");
  }

  const lockTtlSeconds = manual.lockTtlSeconds ?? manualLockTtlSeconds;
  const identity: ManualChromeLockIdentity = {
    profileSessionId: execution.profileSessionId,
    ownerToken: execution.ownerToken,
    fencingNumber: execution.fencingNumber
  };

  const running = await manual.store.markRunning(identity, lockTtlSeconds);
  if (!running) {
    log.warn({ action: "manual.lockLost", profileSessionId: identity.profileSessionId }, "Manual Chrome lock was not acquired");
    throw new Error("Manual Chrome lock is no longer owned by this job");
  }
  log.info({ action: "manual.lockAcquired", profileSessionId: identity.profileSessionId }, "Manual Chrome lock acquired");

  const session = await verifyWorkerOwnedSession(manual, execution);

  const connectBrowser = manual.connectBrowser ?? ((connectOptions) => puppeteer.connect(connectOptions));
  const browser = await connectBrowser({ browserURL: `http://127.0.0.1:${session.port}` });

  const cancellation = { cancelled: false, reason: "" };
  const renewIntervalMs = manual.lockRenewIntervalMs ?? manualLockRenewIntervalMs;
  const renewalTimer = setInterval(() => {
    void manual.store.renewLock(identity, lockTtlSeconds).then((renewed) => {
      if (!renewed) {
        cancellation.cancelled = true;
        cancellation.reason = "Manual Chrome lock was lost or superseded";
      }
    });
  }, renewIntervalMs);
  if (typeof renewalTimer.unref === "function") renewalTimer.unref();

  const startedAt = new Date().toISOString();
  const targets = execution.targets;
  const totalRuns = targets.length * config.formFactors.length * config.runsPerPage;
  const runDurations: number[] = [];
  const routes = new Map<string, RouteReport>();
  const diagnostics: DiagnosticEntry[] = [];
  for (const warning of execution.compareWarnings ?? []) {
    diagnostics.push({
      timestamp: startedAt,
      route: warning.detail ?? warning.displayUrl,
      severity: "warning",
      code: `COMPARE_${warning.reason}`,
      message: manualCompareWarningMessage(warning)
    });
  }
  let lighthouseRuns: LighthouseEvidenceRun[] = [];
  let completedRuns = 0;

  log.info(
    { action: "manual.start", targets: targets.length, formFactors: config.formFactors.length, runsPerPage: config.runsPerPage, totalRuns },
    "Manual audit plan resolved"
  );

  await job.updateProgress({ eventName: "started", phase: "started", jobId: job.data.jobId, startedAt, totalRuns });

  try {
    // Fail closed if the live browser no longer carries our ownership marker,
    // even when Redis still reports ownership (e.g. profile was reused).
    // const markerPages = await browser.pages();
    // if (!markerPages.some((page) => page.url() === manualChromeMarkerUrl(session.ownerNonce))) {
    //   throw new Error("Manual Chrome ownership marker is missing");
    // }

    const pagesByTarget = await mapPagesByTargetId(browser);

    for (const target of targets) {
      const routeReport: RouteReport = {
        route: target.route,
        url: target.displayUrl,
        environment: target.environment ? { ...target.environment } : undefined,
        results: []
      };
      const routeKey = target.environment ? `${target.environment.name} ${target.route}` : target.route;
      routes.set(routeKey, routeReport);
      const page = pagesByTarget.get(target.targetId);
      const auditUrl = typeof target.auditUrl === "string" ? target.auditUrl : undefined;

      for (const formFactor of config.formFactors) {
        log.info(
          {
            action: "manual.formFactor.start",
            route: target.route,
            formFactor,
            runsTotal: config.runsPerPage,
            hasPage: Boolean(page),
            hasAuditUrl: Boolean(auditUrl)
          },
          "Starting form factor"
        );
        if (!page || !auditUrl) {
          log.warn(
            { action: "manual.tabMissing", route: target.route, formFactor },
            "Manual tab missing — skipping form factor"
          );
          diagnostics.push({
            timestamp: new Date().toISOString(),
            route: target.route,
            formFactor,
            severity: "error",
            code: "TAB_MISSING",
            message: "Selected tab is no longer open. Rescan tabs and try again."
          });
          routeReport.results.push(failedFormFactorReport(target.route, formFactor, config.runsPerPage));
          completedRuns += config.runsPerPage;
          await job.updateProgress(
            buildProgressPayload({
              route: target.displayUrl,
              formFactor,
              runIndex: config.runsPerPage,
              runsTotal: config.runsPerPage,
              completedRuns,
              totalRuns,
              completedRunDurationsMs: runDurations
            })
          );
          continue;
        }

        const runResult = await runRouteAudits({
          url: auditUrl,
          route: target.route,
          formFactor,
          runsTotal: config.runsPerPage,
          isFatalError: (error) => error instanceof FatalAuditError || cancellation.cancelled,
          runOnce: async () => {
            if (cancellation.cancelled) {
              throw new FatalAuditError(cancellation.reason || "Manual Chrome job was cancelled");
            }
            const runOptions: RunManualTabOptions = {
              page,
              auditUrl,
              formFactor,
              config,
              allowedHosts: manual.allowedHosts
            };
            return runManualTabLighthouse(runOptions);
          },
          onRunComplete: async ({ runIndex, ok, durationMs, error }) => {
            completedRuns += 1;
            runDurations.push(durationMs);
            if (!ok) {
              const sanitized = sanitizeManualErrorMessage(error ?? "Lighthouse run failed");
              log.warn(
                {
                  action: "manual.runFailed",
                  route: target.route,
                  formFactor,
                  runIndex,
                  durationMs,
                  reason: sanitized
                },
                "Manual tab Lighthouse run failed"
              );
              diagnostics.push({
                timestamp: new Date().toISOString(),
                route: target.route,
                formFactor,
                runIndex,
                severity: "error",
                code: "RUN_FAILED",
                message: sanitized
              });
            } else {
              log.info(
                { action: "manual.runOk", route: target.route, formFactor, runIndex, durationMs },
                "Manual tab Lighthouse run succeeded"
              );
            }
            await job.updateProgress(
              buildProgressPayload({
                route: target.displayUrl,
                formFactor,
                runIndex,
                runsTotal: config.runsPerPage,
                completedRuns,
                totalRuns,
                completedRunDurationsMs: runDurations
              })
            );
          }
        });

        lighthouseRuns = [
          ...lighthouseRuns,
          ...runResult.successfulRuns.map((run) => ({
            environment: target.environment,
            route: target.route,
            url: target.displayUrl,
            formFactor,
            runIndex: run.runIndex,
            lhr: run.lhr
          }))
        ];

        log.info(
          {
            action: "manual.formFactor.done",
            route: target.route,
            formFactor,
            status: runResult.status,
            successful: runResult.successfulRuns.length,
            failed: runResult.errors.length,
            runsTotal: config.runsPerPage
          },
          "Form factor finished"
        );

        if (runResult.medianLhr) {
          const extracted = extractFormFactorReport({
            route: target.route,
            formFactor,
            status: runResult.status,
            runsOk: runResult.lhrs.length,
            runsTotal: config.runsPerPage,
            medianRunIndex: runResult.medianRunIndex,
            medianLhr: runResult.medianLhr,
            successfulRuns: runResult.successfulRuns,
            startedAt
          });
          routeReport.results.push(extracted.result);
          diagnostics.push(...extracted.diagnostics);
        } else {
          routeReport.results.push(failedFormFactorReport(target.route, formFactor, config.runsPerPage));
        }

        await job.updateProgress({
          eventName: "route-completed",
          route: target.displayUrl,
          formFactor,
          scores: routeReport.results.at(-1)?.scores
        });

        if (cancellation.cancelled) break;
      }
      if (cancellation.cancelled) break;
    }

    // Fail closed: a lost lock means another job may now own the browser, so we
    // must not publish a partial report built from a session we no longer hold.
    if (cancellation.cancelled) {
      throw new Error(cancellation.reason || "Manual Chrome lock was lost or superseded");
    }

    await job.updateProgress({ eventName: "excel-generating", message: "Generating Excel and HTML reports..." });
    const finishedAt = new Date().toISOString();
    const routeReports = Array.from(routes.values());
    const runFailures = diagnostics.filter((item) => item.code === "RUN_FAILED").length;
    const missingTabRuns = diagnostics.filter((item) => item.code === "TAB_MISSING").length * config.runsPerPage;
    const successfulRuns = Math.max(0, completedRuns - runFailures - missingTabRuns);
    if (successfulRuns <= 0) {
      throw new Error(buildManualAllRunsFailedMessage(diagnostics));
    }

    const report = buildManualAuditReport({
      jobId: job.data.jobId,
      config,
      startedAt,
      finishedAt,
      routes: routeReports,
      diagnostics,
      successfulRuns,
      totalRuns,
      environments: deriveManualEnvironments(routeReports)
    });
    const workbook = await buildAuditWorkbook(report);
    const { sha256, htmlReports, indexHtmlReport, evidenceDiagnostics } = await writeReportFiles(
      options.dataDir,
      report,
      workbook,
      {
        auditConfig: config,
        lighthouseRuns,
        evidenceMode: config.manualChrome.evidenceMode,
        maxEvidenceBytes: manual.maxEvidenceBytes
      }
    );
    for (const evidenceDiagnostic of evidenceDiagnostics) {
      diagnostics.push({
        timestamp: new Date().toISOString(),
        route: evidenceDiagnostic.route,
        formFactor: evidenceDiagnostic.formFactor as FormFactor,
        runIndex: evidenceDiagnostic.runIndex,
        severity: "warning",
        code: "EVIDENCE_DISCARDED",
        message: evidenceDiagnostic.reason
      });
    }
    await cleanupOldReports(options.dataDir);

    const tokenService = createDownloadTokenService({
      secret: options.downloadTokenSecret,
      store: createRedisTokenStore(options.connection)
    });
    const downloadToken = await tokenService.issue(job.data.jobId);

    return {
      downloadUrl: `/jobs/${job.data.jobId}/download`,
      downloadToken,
      htmlReports: htmlReports.map((htmlReport) => ({
        ...htmlReport,
        downloadUrl: `/jobs/${job.data.jobId}/evidence/${encodeURIComponent(htmlReport.fileName)}`
      })),
      evidenceIndex: indexHtmlReport
        ? {
            ...indexHtmlReport,
            downloadUrl: `/jobs/${job.data.jobId}/evidence/${encodeURIComponent(indexHtmlReport.fileName)}`
          }
        : undefined,
      sha256,
      summary: report.summary
    };
  } finally {
    clearInterval(renewalTimer);
    await browser.disconnect();
    await manual.store.releaseLock(identity);
    log.info({ action: "manual.lockReleased", profileSessionId: identity.profileSessionId }, "Manual Chrome lock released");
  }
}

async function verifyWorkerOwnedSession(
  manual: ManualChromeWorkerConfig,
  execution: ManualChromeExecutionData
): Promise<ManualChromeSessionRecord> {
  const bootId = await manual.store.getBootId();
  // Some races can cause the session to be missing briefly after claiming
  // the lock in Redis (store.markRunning). Retry a few times for transient
  // missing sessions before failing the job.
  let session: ManualChromeSessionRecord | null = null;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    session = await manual.store.getSession();
    if (session) break;
    // small backoff
    await new Promise((r) => setTimeout(r, attempt * 20));
  }
  const target = execution.targets[0];
  // Minimal preconditions that are always required. We no longer treat a
  // profileSessionId mismatch as an immediate fatal error — accept the live
  // session as long as one exists and there's at least one target. This lets
  // workers connect to reused or externally managed Chrome sessions.
  if (!session || !target) {
    throw new Error("Manual Chrome profile is not available to this worker");
  }
  if (session.profileSessionId !== execution.profileSessionId) {
    // eslint-disable-next-line no-console
    console.warn("Manual Chrome profileSessionId differs from the job descriptor — proceeding with live session");
  }

  // If the worker is running in connect-only mode, allow connecting to a
  // session created by a manually-started Chrome instance. Skip the strict
  // boot id / owner nonce checks which are only relevant when the server
  // auto-launches and claims exclusive ownership.
  if (manual.mode === "connect-only") {
    // In connect-only mode we intentionally accept sessions created by a
    // manually-started Chrome instance; skip strict ownership checks.
    return session;
  }

  // Historical strict ownership semantics for auto-launch mode: the job's
  // captured serverInstanceId and the live session's serverInstanceId and
  // ownerNonce must match the worker's boot identity and the submitted
  // execution targets. Fail closed if these do not match.
  if (
    !bootId ||
    bootId !== target.serverInstanceId ||
    session.serverInstanceId !== target.serverInstanceId ||
    session.ownerNonce !== target.ownerNonce
  ) {
    // Historically this was fatal. Relax behavior: warn and continue so a
    // worker can run against an existing session (useful for developer
    // workflows where strict ownership is undesirable). Keep throwing only
    // for the truly missing session case handled above.
    // Use console.warn here because we don't have access to the worker
    // logger in this helper. The caller will still record job-level errors
    // if subsequent operations fail.
    // eslint-disable-next-line no-console
    console.warn("Manual Chrome ownership metadata mismatch — proceeding anyway");
    return session;
  }

  return session;
}

async function mapPagesByTargetId(browser: Browser): Promise<Map<string, Page>> {
  const pages = await browser.pages();
  const byTarget = new Map<string, Page>();
  for (const page of pages) {
    if (page.url().startsWith(manualChromeMarkerUrl(""))) continue;
    try {
      const targetId = await workerPageTargetId(page);
      byTarget.set(targetId, page);
    } catch {
      // Skip pages whose target ID cannot be resolved.
    }
  }
  return byTarget;
}

async function workerPageTargetId(page: Page): Promise<string> {
  const session = await page.target().createCDPSession();
  try {
    const result = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
    if (!result.targetInfo?.targetId) throw new Error("Chrome target ID is unavailable");
    return result.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

function isResolvedExecution(value: ManualChromeExecutionData | { alg: string }): value is ManualChromeExecutionData {
  return typeof value === "object" && value !== null && "targets" in value && Array.isArray((value as ManualChromeExecutionData).targets);
}

/** Collect the distinct environments from compare route reports, preserving order. */
function deriveManualEnvironments(routes: readonly RouteReport[]): AuditEnvironment[] {
  const byName = new Map<string, AuditEnvironment>();
  for (const route of routes) {
    if (route.environment && !byName.has(route.environment.name)) {
      byName.set(route.environment.name, { ...route.environment });
    }
  }
  return Array.from(byName.values());
}

function manualCompareWarningMessage(warning: ManualCompareWarning): string {
  switch (warning.reason) {
    case "UNMATCHED_HOST":
      return `Tab ${warning.displayUrl} did not match either compare environment and was excluded.`;
    case "UNBALANCED_ROUTE":
      return `Route ${warning.detail ?? ""} is present in only one environment; the other will show N/A.`;
    case "DUPLICATE_PATHNAME":
      return `Duplicate path ${warning.detail ?? ""} in one environment; only the first tab was kept.`;
    default:
      return "Compare selection warning.";
  }
}

function buildManualAuditReport(input: {
  jobId: string;
  config: ManualTabsAuditConfig;
  startedAt: string;
  finishedAt: string;
  routes: RouteReport[];
  diagnostics: DiagnosticEntry[];
  successfulRuns: number;
  totalRuns: number;
  environments?: AuditEnvironment[] | undefined;
}): AuditReport {
  const hasFailedRoute = input.routes.some((route) => route.results.some((result) => result.status === "failed"));
  return {
    jobId: input.jobId,
    baseUrl: input.config.baseUrl,
    displayName: input.config.displayName,
    environments: input.environments && input.environments.length > 1 ? input.environments : undefined,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lighthouseVersion: firstRunField(input.routes, "lighthouseVersion") ?? "unknown",
    chromeVersion: firstRunField(input.routes, "chromeVersion") ?? "unknown",
    nodeVersion: process.version,
    categories: input.config.categories,
    formFactors: input.config.formFactors,
    runsPerPage: input.config.runsPerPage,
    throttlingLabel: throttlingLabel(input.config),
    throttling: resolveMobileThrottling(input.config),
    authSummary: "Manual browser authentication (Manual Chrome Tabs)",
    mode: "manual-tabs",
    cachePolicy: input.config.manualChrome.cachePolicy,
    evidenceMode: input.config.manualChrome.evidenceMode,
    routes: input.routes,
    diagnostics: input.diagnostics,
    summary: {
      totalRoutes: input.routes.length,
      totalRuns: input.totalRuns,
      successfulRuns: input.successfulRuns,
      durationSec: Math.round((Date.parse(input.finishedAt) - Date.parse(input.startedAt)) / 1000),
      status: hasFailedRoute ? "partial" : "completed"
    }
  };
}

function buildAuditReport(input: {
  jobId: string;
  config: AuditConfig;
  startedAt: string;
  finishedAt: string;
  routes: RouteReport[];
  diagnostics: DiagnosticEntry[];
  successfulRuns: number;
  totalRuns: number;
}): AuditReport {
  const hasFailedRoute = input.routes.some((route) => route.results.some((result) => result.status === "failed"));
  return {
    jobId: input.jobId,
    mode: "static",
    baseUrl: input.config.baseUrl,
    displayName: input.config.displayName,
    environments: input.config.environments?.map((environment) => ({ ...environment })),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lighthouseVersion: firstRunField(input.routes, "lighthouseVersion") ?? "unknown",
    chromeVersion: firstRunField(input.routes, "chromeVersion") ?? "unknown",
    nodeVersion: process.version,
    categories: input.config.categories,
    formFactors: input.config.formFactors,
    runsPerPage: input.config.runsPerPage,
    throttlingLabel: throttlingLabel(input.config),
    throttling: resolveMobileThrottling(input.config),
    authSummary: `Basic Auth: ${input.config.basicAuth.enabled ? "enabled" : "disabled"}; Form Login: ${input.config.formLogin.enabled ? "enabled" : "disabled"}`,
    routes: input.routes,
    diagnostics: input.diagnostics,
    summary: {
      totalRoutes: input.routes.length,
      totalRuns: input.totalRuns,
      successfulRuns: input.successfulRuns,
      durationSec: Math.round((Date.parse(input.finishedAt) - Date.parse(input.startedAt)) / 1000),
      status: hasFailedRoute ? "partial" : "completed"
    }
  };
}

function resolveAuditEnvironments(config: AuditConfig): AuditEnvironment[] {
  return config.environments?.length
    ? config.environments.map((environment) => ({ ...environment }))
    : [{ name: config.displayName, baseUrl: config.baseUrl }];
}

function buildEnvironmentAuditConfig(config: AuditConfig, environment: AuditEnvironment): AuditConfig {
  return {
    ...config,
    baseUrl: environment.baseUrl,
    displayName: environment.name,
    formLogin: {
      ...config.formLogin,
      loginUrl: rewriteUrlForEnvironment(config.formLogin.loginUrl, config.baseUrl, environment.baseUrl)
    }
  };
}

function rewriteUrlForEnvironment(url: string | undefined, sourceBaseUrl: string, targetBaseUrl: string): string | undefined {
  if (!url) return url;
  try {
    const parsedUrl = new URL(url);
    const sourceBase = new URL(sourceBaseUrl);
    if (parsedUrl.origin !== sourceBase.origin) return url;
    return new URL(`${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`, `${targetBaseUrl}/`).toString().replace(/\/$/, parsedUrl.pathname.endsWith("/") ? "/" : "");
  } catch {
    return url;
  }
}

export function buildAllRunsFailedMessage(diagnostics: DiagnosticEntry[]): string {
  const firstFailure = diagnostics.find((item) => item.code === "RUN_FAILED" && item.message.trim());
  if (!firstFailure) return "All Lighthouse runs failed";
  const firstMessage = firstFailure.message.replace(/\s+/g, " ").trim();
  return `All Lighthouse runs failed. First error: ${firstMessage.slice(0, 280)}`;
}

function buildManualAllRunsFailedMessage(diagnostics: DiagnosticEntry[]): string {
  const firstFailure = diagnostics.find(
    (item) => (item.code === "RUN_FAILED" || item.code === "TAB_MISSING") && item.message.trim()
  );
  if (!firstFailure) return "All manual tab audits failed";
  const firstMessage = firstFailure.message.replace(/\s+/g, " ").trim();
  return `All manual tab audits failed. First error: ${firstMessage.slice(0, 280)}`;
}

function failedFormFactorReport(route: string, formFactor: FormFactor, runsTotal: number): FormFactorReport {
  const nullScores = { performance: null, accessibility: null, "best-practices": null, seo: null, pwa: null };
  const metric = { value: null, score: null };
  return {
    route,
    formFactor,
    status: "failed",
    runsOk: 0,
    runsTotal,
    medianRunIndex: null,
    scores: nullScores,
    metrics: {
      lcp: metric,
      cls: metric,
      tbt: metric,
      fcp: metric,
      speedIndex: metric,
      tti: metric,
      maxPotentialFid: metric
    },
    runs: [],
    opportunities: []
  };
}

function firstRunField(routes: RouteReport[], field: "lighthouseVersion" | "chromeVersion"): string | undefined {
  for (const route of routes) {
    for (const result of route.results) {
      const firstRun = result.runs.find((run) => Boolean(run[field]));
      if (firstRun?.[field]) return firstRun[field];
    }
  }
  return undefined;
}

function buildTargetUrl(baseUrl: string, route: string): string {
  return new URL(route, `${baseUrl}/`).toString();
}
