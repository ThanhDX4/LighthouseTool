import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { lookup as lookupMime } from "mime-types";
import { parseAuditRequest } from "../config/audit-config.js";
import { redactAuditConfig, type SafeAuditConfig } from "../config/safe-audit-config.js";
import { encryptJobConfig } from "../security/credentials.js";
import { evaluateManualRequestAccess } from "../manual-chrome/access-control.js";
import { ManualChromeError } from "../manual-chrome/session-manager.js";
import {
  buildManualQueuedConfig,
  newManualJobId,
  newManualOwnerToken,
  resolveManualTargets
} from "../manual-chrome/job-submission.js";
import type {
  ManualChromeLockRecord,
  ManualChromeScanSnapshot,
  ManualChromeSessionRecord
} from "../manual-chrome/types.js";
import type {
  AuditConfig,
  ManualChromeExecutionData,
  ManualTabsAuditRequest,
  ParsedAuditRequest
} from "../types/config.js";
import { createDownloadTokenService } from "./download-token.js";

export interface AuditQueueJobLike {
  id?: string | number;
  data?: {
    jobId?: string;
    config?: AuditConfig;
    createdAt?: string;
  };
  getState?(): Promise<string> | string;
}

export interface AuditQueueLike {
  add(name: string, data: unknown, options?: unknown): Promise<unknown>;
  getJobs?(types?: unknown): Promise<Array<{ id?: string | number }>>;
  getJob?(jobId: string): Promise<AuditQueueJobLike | null | undefined>;
}

export interface QueueEventsLike {
  on(event: string, listener: (payload: any) => void): QueueEventsLike;
  off?(event: string, listener: (payload: any) => void): QueueEventsLike;
  close(): Promise<void>;
}

export interface ManualChromeAppService {
  ensureSession(): Promise<unknown>;
  scanTabs(): Promise<unknown>;
  verifyOwnedSession(expected?: {
    profileSessionId?: string | undefined;
    serverInstanceId?: string | undefined;
  }): Promise<ManualChromeSessionRecord>;
}

export interface ManualChromeJobStore {
  getScan(scanId: string): Promise<ManualChromeScanSnapshot | null>;
  acquireLock(input: {
    jobId: string;
    profileSessionId: string;
    ownerToken: string;
    ttlSeconds: number;
  }): Promise<ManualChromeLockRecord | null>;
  releaseLock(identity: {
    profileSessionId: string;
    ownerToken: string;
    fencingNumber: number;
  }): Promise<boolean>;
}

export interface BuildAppOptions {
  encryptionKey: string;
  downloadTokenSecret: string;
  dataDir: string;
  queue: AuditQueueLike;
  tokenStore: Map<string, unknown> | {
    get(key: string): Promise<unknown> | unknown;
    set(key: string, value: string, ttlSeconds?: number): Promise<unknown> | unknown;
  };
  queueEventsFactory?: () => QueueEventsLike;
  staticDir?: string;
  healthCheck?: () => Promise<{ redis: boolean; chrome: boolean }>;
  allowedHosts?: string[];
  secureCookies?: boolean;
  logger?: boolean | object;
  manualChrome?: ManualChromeAppService | undefined;
  manualChromeStore?: ManualChromeJobStore | undefined;
  manualChromeMaxEvidenceFiles?: number | undefined;
}

const csrfCookieName = "lh_csrf";
const postJobsRate = new Map<string, { count: number; resetAt: number }>();
const legacyCategories: AuditConfig["categories"] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
  "pwa"
];
const lighthouseEvidenceCsp = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      {
        redact: [
          "req.body.basicAuth.password",
          "req.body.formLogin.password",
          "job.data.credentials.*",
          "job.data.config.basicAuth.password",
          "job.data.config.formLogin.password"
        ]
      }
  });
  const tokenService = createDownloadTokenService({
    secret: options.downloadTokenSecret,
    store: options.tokenStore
  });

  app.get("/healthz", async (_request, reply) => {
    const status = options.healthCheck ? await options.healthCheck() : { redis: true, chrome: true };
    const ok = status.redis && status.chrome;
    return reply.code(ok ? 200 : 503).send({ ok, ...status, manualChrome: Boolean(options.manualChrome) });
  });

  app.get("/csrf-token", async (_request, reply) => {
    const csrfToken = randomUUID();
    const secure = options.secureCookies ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${csrfCookieName}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; HttpOnly${secure}`
    );
    return { csrfToken };
  });

  app.get("/jobs", async (request, reply) => {
    if (options.staticDir && request.headers.accept?.includes("text/html")) {
      return serveStaticIndex(options.staticDir, reply);
    }
    return { jobs: await listPersistedJobs(options.dataDir) };
  });

  app.post("/jobs", async (request, reply) => {
   
    if (!verifyCsrf(request.headers.cookie, request.headers["x-csrf-token"])) {
      return reply.code(403).send({ error: "Invalid CSRF token" });
    }

    let config;
    try {
      config = parseAuditRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid audit request"
      });
    }
    if (isManualTabsRequest(config)) {
      return handleManualJobSubmission(request, reply, options, config);
    }

    const jobId = randomUUID();
    await enqueueAuditJob(options.queue, jobId, encryptJobConfig(config, options.encryptionKey));
    request.log.info(
      {
        action: "jobs.enqueued",
        jobId,
        mode: config.mode,
        baseUrl: config.baseUrl,
        paths: config.paths.length,
        formFactors: config.formFactors.length,
        runsPerPage: config.runsPerPage
      },
      "Static audit job enqueued"
    );

    return reply.code(202).send(await buildJobAcceptedResponse(options.queue, jobId));
  });

  app.post("/manual-chrome/session", async (request, reply) => {
    request.log.info({ action: "manual.session.request" }, "Manual Chrome session requested");
    return handleManualChromeRequest(request, reply, options, async (service) => service.ensureSession());
  });

  app.post("/manual-chrome/tabs/scan", async (request, reply) => {
    request.log.info({ action: "manual.scan.request" }, "Manual Chrome scan requested");
    return handleManualChromeRequest(request, reply, options, async (service) => service.scanTabs());
  });

  app.get("/jobs/:id/detail", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isSafePathSegment(id)) {
      return reply.code(404).send({ error: "Job not found" });
    }

    const persisted = await buildPersistedJobDetail(options, tokenService, id);
    if (persisted) return persisted;

    const queued = await buildQueuedJobDetail(options.queue, id);
    if (queued) return queued;

    return reply.code(404).send({ error: "Job not found" });
  });

  app.get("/jobs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("queued", { jobId: id, queuePosition: await getQueuePosition(options.queue, id) });

    const queueEvents = options.queueEventsFactory?.();
    if (!queueEvents) {
      reply.raw.end();
      return reply;
    }

    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      queueEvents.off?.("progress", onProgress);
      queueEvents.off?.("completed", onCompleted);
      queueEvents.off?.("failed", onFailed);
      void queueEvents.close();
    };
    const finish = () => {
      cleanup();
      reply.raw.end();
    };
    const onProgress = ({ jobId, data }: any) => {
      if (jobId !== id) return;
      const eventName = data?.eventName ?? (data?.phase === "started" ? "started" : "progress");
      send(eventName, data);
    };
    const onCompleted = ({ jobId, returnvalue }: any) => {
      if (jobId !== id) return;
      send("done", returnvalue);
      finish();
    };
    const onFailed = ({ jobId, failedReason }: any) => {
      if (jobId !== id) return;
      send("failed", { error: failedReason });
      finish();
    };

    queueEvents.on("progress", onProgress);
    queueEvents.on("completed", onCompleted);
    queueEvents.on("failed", onFailed);
    request.raw.on("close", cleanup);

    return reply;
  });

  app.get("/jobs/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.code(401).send({ error: "Download token is required" });
    }
    const reportPath = resolve(options.dataDir, "jobs", id, "report.xlsx");
    if (!reportPath.startsWith(resolve(options.dataDir)) || !existsSync(reportPath)) {
      return reply.code(404).send({ error: "Report not found" });
    }
    try {
      await tokenService.consume(id, token);
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "Invalid token" });
    }

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="${await buildDownloadFilename(options.dataDir, id)}"`);
    request.log.info({ action: "report.download", jobId: id }, "Audit report downloaded");
    return reply.send(createReadStream(reportPath));
  });

  app.get("/jobs/:id/evidence/:fileName", async (request, reply) => {
    const { id, fileName } = request.params as { id: string; fileName: string };
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.code(401).send({ error: "Download token is required" });
    }
    if (!isSafePathSegment(id) || !isSafeHtmlFileName(fileName)) {
      return reply.code(404).send({ error: "Evidence report not found" });
    }

    try {
      await tokenService.verify(id, token);
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "Invalid token" });
    }

    const jobsRoot = resolve(options.dataDir, "jobs");
    const evidenceRoot = resolve(jobsRoot, id, "evidence");
    const reportPath = resolve(evidenceRoot, fileName);
      if (!isPathInside(jobsRoot, evidenceRoot) || !isPathInside(evidenceRoot, reportPath) || !existsSync(reportPath)) {
        // Try compatibility fallbacks for legacy filenames that were generated
        // from full URLs and may contain encoded path segments (e.g. "-2F" sequences)
        // or were double-encoded. Attempt a few deterministic transforms and
        // look for an existing file in the evidence folder before returning 404.
        try {
          const candidates = new Set<string>();

          // 1) try decodeURIComponent (may throw on invalid sequences)
          try {
            candidates.add(decodeURIComponent(fileName));
          } catch (err) {
            // ignore
          }

          // 2) replace common encoded slash token "-2F" used by previous sanitizer
          candidates.add(fileName.replace(/-2F/g, "-"));

          // 3) collapse repeated hyphens which sometimes resulted from sanitization
          candidates.add(fileName.replace(/--+/g, "-"));

          // 4) strip any leading './' or '/' segments
          candidates.add(fileName.replace(/^\.\//, ""));

          // For each candidate, check if a file with that name exists in evidenceRoot
          let foundPath: string | undefined;
          for (const candidate of candidates) {
            const candidatePath = resolve(evidenceRoot, candidate);
            if (isPathInside(evidenceRoot, candidatePath) && existsSync(candidatePath)) {
              foundPath = candidatePath;
              break;
            }
          }

          if (foundPath) {
            // serve the found file
            reply.header("Content-Type", "text/html; charset=utf-8");
            reply.header("Content-Disposition", `inline; filename="${sanitizeFilenamePart(foundPath)}"`);
            reply.header("Content-Security-Policy", lighthouseEvidenceCsp);
            return reply.send(createReadStream(foundPath));
          }
        } catch (err) {
          // ignore errors from fallback logic and fall through to 404
        }

        return reply.code(404).send({ error: "Evidence report not found" });
      }

    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Content-Disposition", `inline; filename="${sanitizeFilenamePart(fileName)}"`);
    reply.header("Content-Security-Policy", lighthouseEvidenceCsp);
    return reply.send(createReadStream(reportPath));
  });

  // Some dev setups or Service Worker libraries request /mockServiceWorker.js; if the
  // file isn't present in the built static bundle return a tiny noop JS instead of 404
  // so the UI doesn't show an error in the console.
  if (options.staticDir) {
    app.get("/mockServiceWorker.js", async (_request, reply) => {
      const mswPath = resolve(options.staticDir ?? "", "mockServiceWorker.js");
      if (existsSync(mswPath)) {
        reply.type("application/javascript");
        return reply.send(createReadStream(mswPath));
      }
      reply.type("application/javascript");
      return reply.send("// mock service worker placeholder\n");
    });
  }

  if (options.staticDir) {
    app.get("/*", async (request, reply) => {
      const staticRoot = resolve(options.staticDir ?? "");
      const requestPath = decodeURIComponent(new URL(request.url, "http://local").pathname);
      const requestedFile = requestPath === "/" || !extname(requestPath)
        ? join(staticRoot, "index.html")
        : resolve(staticRoot, `.${requestPath}`);
      if (!requestedFile.startsWith(staticRoot)) {
        return reply.code(404).send({ error: "Not found" });
      }
      if (existsSync(requestedFile)) {
        reply.type(lookupMime(requestedFile) || "application/octet-stream");
        return reply.send(createReadStream(requestedFile));
      }
      return reply.code(404).send({ error: "UI bundle not found" });
    });
  }

  return app;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function handleManualChromeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BuildAppOptions,
  action: (service: ManualChromeAppService) => Promise<unknown>
): Promise<unknown> {
  reply.header("Cache-Control", "no-store");

  

  const access = evaluateManualRequestAccess({
    remoteAddress: request.socket.remoteAddress ?? undefined,
    host: singleHeader(request.headers.host),
    origin: singleHeader(request.headers.origin),
    referer: singleHeader(request.headers.referer),
    forwardedFor: singleHeader(request.headers["x-forwarded-for"]),
    forwardedHost: singleHeader(request.headers["x-forwarded-host"])
  });
  if (!access.allowed) {
    return reply.code(403).send({ error: access.error, code: access.code });
  }

  if (!verifyCsrf(request.headers.cookie, request.headers["x-csrf-token"])) {
    return reply.code(403).send({ error: "Invalid CSRF token" });
  }

  const service = options.manualChrome;
  if (!service) {
    return reply.code(403).send({ error: "Manual Chrome is disabled", code: "MANUAL_CHROME_DISABLED" });
  }

  try {
    return await action(service);
  } catch (error) {
    if (error instanceof ManualChromeError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    throw error;
  }
}

const manualLockTtlSeconds = 60;

async function handleManualJobSubmission(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BuildAppOptions,
  parsed: ManualTabsAuditRequest
): Promise<unknown> {
  reply.header("Cache-Control", "no-store");

  const access = evaluateManualRequestAccess({
    remoteAddress: request.socket.remoteAddress ?? undefined,
    host: singleHeader(request.headers.host),
    origin: singleHeader(request.headers.origin),
    referer: singleHeader(request.headers.referer),
    forwardedFor: singleHeader(request.headers["x-forwarded-for"]),
    forwardedHost: singleHeader(request.headers["x-forwarded-host"])
  });
  if (!access.allowed) {
    return reply.code(403).send({ error: access.error, code: access.code });
  }

  const service = options.manualChrome;
  const store = options.manualChromeStore;
  if (!service || !store) {
    return reply.code(403).send({ error: "Manual Chrome is disabled", code: "MANUAL_CHROME_DISABLED" });
  }

  const allowedHosts = options.allowedHosts ?? [];

  try {
    const snapshot = await store.getScan(parsed.manualChrome.scanId);
    if (!snapshot) {
      return reply.code(400).send({ error: "Manual Chrome scan is unknown or expired" });
    }

    const session = await service.verifyOwnedSession({
      profileSessionId: snapshot.profileSessionId,
      serverInstanceId: snapshot.serverInstanceId
    });
    // if (
    //   session.profileSessionId !== snapshot.profileSessionId ||
    //   session.serverInstanceId !== snapshot.serverInstanceId
    // ) {
    //   return reply
    //     .code(503)
    //     .send({ error: "Manual Chrome profile is not owned by this server", code: "MANUAL_CHROME_UNOWNED" });
    // }

    const resolved = resolveManualTargets({
      snapshot,
      session,
      targetIds: parsed.manualChrome.targetIds,
      allowedHosts,
      compare: parsed.manualChrome.compare
    });
    if ("code" in resolved) {
      return reply.code(400).send({ error: resolved.message });
    }

    const maxEvidenceFiles = options.manualChromeMaxEvidenceFiles;
    if (
      parsed.manualChrome.evidenceMode === "html" &&
      typeof maxEvidenceFiles === "number" &&
      resolved.targets.length > maxEvidenceFiles
    ) {
      return reply.code(400).send({ error: "Selected tabs exceed the evidence file limit" });
    }

    const jobId = newManualJobId();
    const ownerToken = newManualOwnerToken();
    const lock = await store.acquireLock({
      jobId,
      profileSessionId: session.profileSessionId,
      ownerToken,
      ttlSeconds: manualLockTtlSeconds
    });
    if (!lock) {
      return reply.code(409).send({ error: "Manual Chrome profile is busy", code: "MANUAL_CHROME_BUSY" });
    }

    const execution: ManualChromeExecutionData = {
      profileSessionId: session.profileSessionId,
      ownerToken,
      fencingNumber: lock.fencingNumber,
      targets: resolved.targets,
      compareWarnings: resolved.warnings
    };
    const queuedConfig = buildManualQueuedConfig(parsed, resolved.baseUrl, resolved.targets, execution);

    try {
      await enqueueAuditJob(options.queue, jobId, encryptJobConfig(queuedConfig, options.encryptionKey));
    } catch (enqueueError) {
      await store.releaseLock({
        profileSessionId: session.profileSessionId,
        ownerToken,
        fencingNumber: lock.fencingNumber
      });
      request.log.error(
        { action: "manual.enqueueFailed", jobId, err: enqueueError },
        "Manual Chrome job could not be enqueued"
      );
      return reply.code(503).send({ error: "Manual Chrome job could not be enqueued" });
    }
    request.log.info(
      {
        action: "manual.enqueued",
        jobId,
        targets: resolved.targets.length,
        formFactors: parsed.formFactors.length,
        runsPerPage: parsed.runsPerPage
      },
      "Manual Chrome audit job enqueued"
    );

    return reply.code(202).send(await buildJobAcceptedResponse(options.queue, jobId));
  } catch (error) {
    if (error instanceof ManualChromeError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    throw error;
  }
}

/** Encrypt-and-enqueue a job under the shared queue retention policy. */
async function enqueueAuditJob(queue: AuditQueueLike, jobId: string, encryptedConfig: AuditConfig): Promise<void> {
  await queue.add(
    "run-audit",
    { jobId, config: encryptedConfig, createdAt: new Date().toISOString() },
    { jobId, removeOnComplete: { age: 60 }, removeOnFail: { age: 24 * 60 * 60 } }
  );
}

/** The shared 202 envelope returned by both static and manual job submission. */
async function buildJobAcceptedResponse(
  queue: AuditQueueLike,
  jobId: string
): Promise<{ jobId: string; eventsUrl: string; downloadUrl: string; queuePosition: number }> {
  return {
    jobId,
    eventsUrl: `/jobs/${jobId}/events`,
    downloadUrl: `/jobs/${jobId}/download`,
    queuePosition: await getQueuePosition(queue, jobId)
  };
}

async function serveStaticIndex(staticDir: string, reply: FastifyReply) {
  const indexPath = resolve(staticDir, "index.html");
  if (!existsSync(indexPath)) {
    return reply.code(404).send({ error: "UI bundle not found" });
  }
  reply.type(lookupMime(indexPath) || "text/html");
  return reply.send(createReadStream(indexPath));
}

async function listPersistedJobs(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const jobsRoot = resolve(dataDir, "jobs");
  let entries;
  try {
    entries = await readdir(jobsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
      .map((entry) => readPersistedJobSummary(jobsRoot, entry.name))
  );

  return jobs
    .filter((job): job is Record<string, unknown> => Boolean(job))
    .sort((left, right) => jobSortTimestamp(right) - jobSortTimestamp(left));
}

async function readPersistedJobSummary(jobsRoot: string, jobId: string): Promise<Record<string, unknown> | null> {
  const metaPath = resolve(jobsRoot, jobId, "meta.json");
  if (!isPathInside(jobsRoot, metaPath)) return null;

  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(parsed)) return null;
  const meta = parsed as JobMeta;

  const summary = buildSafeJobSummary(meta.summary);
  const baseUrl = stringValue(meta.baseUrl);
  return {
    jobId,
    detailUrl: `/jobs/${jobId}`,
    status: jobStatusValue(meta.status) ?? jobStatusValue(summary?.status) ?? "completed",
    baseUrl,
    displayName:
      stringValue(meta.displayName) ??
      stringValue(meta.config?.displayName) ??
      (baseUrl ? hostnameOrFallback(baseUrl) : jobId),
    startedAt: stringValue(meta.startedAt),
    finishedAt: stringValue(meta.finishedAt),
    summary
  };
}

function buildSafeJobSummary(summary: JobMeta["summary"]): Record<string, unknown> | undefined {
  if (!isRecord(summary)) return undefined;
  return {
    totalRoutes: numberValue(summary.totalRoutes),
    totalRuns: numberValue(summary.totalRuns),
    successfulRuns: numberValue(summary.successfulRuns),
    durationSec: numberValue(summary.durationSec),
    status: jobStatusValue(summary.status)
  };
}

function jobStatusValue(value: unknown): string | undefined {
  const status = stringValue(value);
  return status === "completed" || status === "partial" || status === "failed" ? status : undefined;
}

function jobSortTimestamp(job: Record<string, unknown>): number {
  const value = stringValue(job.finishedAt) ?? stringValue(job.startedAt);
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function buildDownloadFilename(dataDir: string, jobId: string): Promise<string> {
  try {
    const raw = await readFile(resolve(dataDir, "jobs", jobId, "meta.json"), "utf8");
    const meta = JSON.parse(raw) as { baseUrl?: string; finishedAt?: string };
    const host = meta.baseUrl ? new URL(meta.baseUrl).hostname : jobId;
    const finishedAt = meta.finishedAt ? new Date(meta.finishedAt) : new Date();
    return `lighthouse-${sanitizeFilenamePart(host)}-${formatTimestamp(finishedAt)}.xlsx`;
  } catch {
    return `lighthouse-${sanitizeFilenamePart(jobId)}.xlsx`;
  }
}

async function buildPersistedJobDetail(
  options: BuildAppOptions,
  tokenService: ReturnType<typeof createDownloadTokenService>,
  jobId: string
): Promise<Record<string, unknown> | null> {
  const jobsRoot = resolve(options.dataDir, "jobs");
  const jobRoot = resolve(jobsRoot, jobId);
  const metaPath = resolve(jobRoot, "meta.json");
  if (!isPathInside(jobsRoot, jobRoot) || !isPathInside(jobRoot, metaPath)) {
    return null;
  }

  let meta: JobMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as JobMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const reportPath = resolve(jobRoot, "report.xlsx");
  const htmlReports = buildHtmlReportLinks(jobId, meta.evidence?.htmlReports);
  const evidenceIndex = buildEvidenceIndexLink(jobId, meta.evidence?.indexHtmlReport);
  return {
    jobId,
    eventsUrl: `/jobs/${jobId}/events`,
    downloadUrl: `/jobs/${jobId}/download`,
    downloadToken: existsSync(reportPath) ? await tokenService.issue(jobId) : undefined,
    queuePosition: await getQueuePosition(options.queue, jobId),
    status: meta.status ?? meta.summary?.status ?? "completed",
    baseUrl: meta.baseUrl,
    displayName: meta.displayName,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    summary: meta.summary,
    config: meta.config ? redactAuditConfig(meta.config) : deriveLegacyAuditConfig(meta),
    htmlReports,
    evidenceIndex
  };
}

async function buildQueuedJobDetail(queue: AuditQueueLike, jobId: string): Promise<Record<string, unknown> | null> {
  const queuedJob = await queue.getJob?.(jobId);
  if (!queuedJob) return null;
  const state = await queuedJob.getState?.();

  return {
    jobId,
    eventsUrl: `/jobs/${jobId}/events`,
    downloadUrl: `/jobs/${jobId}/download`,
    queuePosition: await getQueuePosition(queue, jobId),
    status: mapQueueState(state),
    createdAt: queuedJob.data?.createdAt,
    config: queuedJob.data?.config ? redactAuditConfig(queuedJob.data.config) : undefined,
    htmlReports: []
  };
}

interface JobMeta {
  baseUrl?: string;
  displayName?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  summary?: {
    status?: string;
    [key: string]: unknown;
  };
  config?: AuditConfig;
  evidence?: {
    htmlReports?: unknown;
    indexHtmlReport?: unknown;
  };
}

function buildHtmlReportLinks(jobId: string, reports: unknown): Array<Record<string, unknown>> {
  return htmlReportRecords(reports).flatMap((report) => {
    const fileName = stringValue(report.fileName);
    if (!fileName || !isSafeHtmlFileName(fileName)) {
      return [];
    }
    return [
      {
        ...report,
        downloadUrl: `/jobs/${jobId}/evidence/${encodeURIComponent(fileName)}`
      }
    ];
  });
}

function buildEvidenceIndexLink(jobId: string, report: unknown): Record<string, unknown> | undefined {
  if (!isRecord(report)) return undefined;
  const fileName = stringValue(report.fileName);
  if (!fileName || !isSafeHtmlFileName(fileName)) return undefined;
  return {
    ...report,
    downloadUrl: `/jobs/${jobId}/evidence/${encodeURIComponent(fileName)}`
  };
}

function deriveLegacyAuditConfig(meta: JobMeta): SafeAuditConfig | undefined {
  if (!meta.baseUrl) return undefined;
  const reports = htmlReportRecords(meta.evidence?.htmlReports);
  const paths = uniqueStrings(reports.map((report) => stringValue(report.route)).filter((route) => route?.startsWith("/")));
  const formFactors = uniqueStrings(
    reports
      .map((report) => stringValue(report.formFactor))
      .filter((formFactor) => formFactor === "desktop" || formFactor === "mobile")
  ) as AuditConfig["formFactors"];

  return {
    baseUrl: meta.baseUrl,
    displayName: meta.displayName ?? hostnameOrFallback(meta.baseUrl),
    paths: paths.length ? paths : ["/"],
    formFactors: formFactors.length ? formFactors : ["desktop", "mobile"],
    categories: [...legacyCategories],
    runsPerPage: inferLegacyRunsPerPage(reports, meta.summary, paths.length || 1, formFactors.length || 2),
    throttling: { preset: "slow-4g" },
    basicAuth: { enabled: false },
    formLogin: {
      enabled: false,
      usernameSelector: "input[name=\"email\"]",
      passwordSelector: "input[name=\"password\"]",
      submitSelector: "button[type=\"submit\"]",
      postLogin: { mode: "navigation", timeoutMs: 30_000 }
    }
  };
}

function htmlReportRecords(reports: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(reports)) return [];
  return reports.filter(isRecord);
}

function inferLegacyRunsPerPage(
  reports: Array<Record<string, unknown>>,
  summary: JobMeta["summary"],
  routeCount: number,
  formFactorCount: number
): number {
  const maxRunIndex = Math.max(0, ...reports.map((report) => numberValue(report.runIndex) ?? 0));
  if (maxRunIndex > 0) return maxRunIndex;
  if (typeof summary?.totalRuns === "number") {
    return Math.max(1, Math.round(summary.totalRuns / Math.max(1, routeCount * formFactorCount)));
  }
  return 1;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hostnameOrFallback(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function mapQueueState(state: string | undefined): string {
  if (state === "active") return "running";
  if (state === "waiting" || state === "delayed" || state === "prioritized" || state === "paused") return "queued";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "queued";
}

// Distinguishes a freshly parsed ManualTabsAuditRequest from an already-resolved
// ManualTabsAuditConfig. Both share `mode: "manual-tabs"`, but only the request
// carries `manualChrome.scanId` (the queued config replaces it with `execution`).
function isManualTabsRequest(config: ParsedAuditRequest): config is ManualTabsAuditRequest {
  return config.mode === "manual-tabs" && "scanId" in config.manualChrome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function isSafePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function isSafeHtmlFileName(value: string): boolean {
  return isSafePathSegment(value) && value.endsWith(".html");
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

function verifyCsrf(cookieHeader: string | undefined, headerValue: string | string[] | undefined): boolean {
  const csrfHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!csrfHeader) return false;
  const cookies = parseCookies(cookieHeader);
  return cookies[csrfCookieName] === csrfHeader;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, decodeURIComponent(rest.join("="))];
    })
  );
}

function verifyRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = postJobsRate.get(ip);
  if (!current || current.resetAt <= now) {
    postJobsRate.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (current.count >= 10) return false;
  postJobsRate.set(ip, { ...current, count: current.count + 1 });
  return true;
}

async function getQueuePosition(queue: AuditQueueLike, jobId: string): Promise<number> {
  if (!queue.getJobs) return 0;
  const waiting = await queue.getJobs(["waiting", "delayed"]);
  const index = waiting.findIndex((job) => String(job.id) === jobId);
  return index < 0 ? 0 : index;
}
