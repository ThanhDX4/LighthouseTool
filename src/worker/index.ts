import { loadRuntimeConfig } from "../config/env.js";
import { createRedisConnection } from "../queue/connection.js";
import { createAuditQueue } from "../queue/audit-queue.js";
import { createAuditWorker } from "./audit-worker.js";
import { createManualChromeStore } from "../manual-chrome/redis-store.js";
import { cleanupOldReports } from "./report-files.js";
import { createLogger } from "../observability/logger.js";

const workerLog = createLogger("worker");
workerLog.info({ action: "boot", pid: process.pid }, "Worker starting");

const config = loadRuntimeConfig();
const redis = createRedisConnection(config.redisUrl);
const queue = createAuditQueue(redis);
const worker = createAuditWorker({
  connection: redis,
  encryptionKey: config.encryptionKey,
  downloadTokenSecret: config.downloadTokenSecret,
  dataDir: config.dataDir,
  concurrency: config.workerConcurrency,
  logger: workerLog,
  manualChrome: config.manualChrome.enabled
    ? {
        allowedHosts: config.allowedHosts,
        store: createManualChromeStore(redis),
        maxEvidenceBytes: config.manualChrome.maxEvidenceBytes
      }
    : undefined
});

workerLog.info({ action: "ready", concurrency: config.workerConcurrency, manualChromeEnabled: config.manualChrome.enabled }, "Worker ready");

worker.on("active", (job) => {
  workerLog.info({ action: "job.active", jobId: job.data.jobId, mode: job.data.config.mode }, "Job picked up");
});
worker.on("failed", (job, err) => {
  workerLog.error({ action: "job.failed", jobId: job?.data?.jobId, err }, "Job failed");
});
worker.on("error", (err) => {
  workerLog.error({ action: "worker.error", err }, "Worker emitted error");
});

let completedJobs = 0;
const cleanupInterval = setInterval(() => {
  workerLog.debug({ action: "cleanup.tick" }, "Cleanup interval firing");
  void cleanupOldReports(config.dataDir);
  void queue.clean(24 * 60 * 60 * 1000, 1000, "completed");
  void queue.clean(24 * 60 * 60 * 1000, 1000, "failed");
}, 60 * 60 * 1000);

worker.on("completed", (job) => {
  completedJobs += 1;
  workerLog.info({ action: "job.completed", jobId: job.data.jobId, completedJobs }, "Job completed");
  if (completedJobs >= 50) {
    workerLog.info({ action: "recycle", completedJobs }, "Worker recycling after 50 completions");
    process.exit(0);
  }
});

const shutdown = async (signal: NodeJS.Signals) => {
  workerLog.info({ action: "shutdown", signal }, "Worker shutting down");
  clearInterval(cleanupInterval);
  await worker.close();
  await queue.close();
  redis.disconnect();
};
process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
