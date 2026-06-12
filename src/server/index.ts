import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "../config/env.js";
import { createRedisConnection } from "../queue/connection.js";
import { createAuditQueue, createAuditQueueEvents } from "../queue/audit-queue.js";
import { createRedisTokenStore } from "../queue/redis-token-store.js";
import { createManualChromeStore } from "../manual-chrome/redis-store.js";
import { createManualChromeSessionManager } from "../manual-chrome/session-manager.js";
import { createLogger, loggerOptionsForFastify } from "../observability/logger.js";

const serverLog = createLogger("server");
serverLog.info({ action: "boot", pid: process.pid }, "Server starting");

const config = loadRuntimeConfig();
const redis = createRedisConnection(config.redisUrl);
const queue = createAuditQueue(redis);

const manualChromeStore = config.manualChrome.enabled ? createManualChromeStore(redis) : undefined;
const manualChrome = config.manualChrome.enabled
  ? createManualChromeSessionManager({
      enabled: true,
      chromePath: config.chromePath,
      port: config.manualChrome.port,
      profileDir: config.manualChrome.profileDir,
      startupTimeoutMs: config.manualChrome.startupTimeoutMs,
      maxTabs: config.manualChrome.maxTabs,
      allowedHosts: config.allowedHosts,
      store: manualChromeStore!,
      logger: createLogger("manual-chrome")
    })
  : undefined;
if (manualChrome) {
  await manualChrome.initialize();
}

const app = await buildApp({
  encryptionKey: config.encryptionKey,
  downloadTokenSecret: config.downloadTokenSecret,
  dataDir: config.dataDir,
  staticDir: resolve(config.staticDir),
  queue,
  tokenStore: createRedisTokenStore(redis),
  queueEventsFactory: () => createAuditQueueEvents(redis),
  allowedHosts: config.allowedHosts,
  secureCookies: config.nodeEnv === "production",
  manualChrome,
  manualChromeStore,
  manualChromeMaxEvidenceFiles: config.manualChrome.maxEvidenceFiles,
  healthCheck: async () => ({
    redis: (await redis.ping()) === "PONG",
    chrome: config.chromePath ? existsSync(config.chromePath) : false
  }),
  logger: loggerOptionsForFastify()
});

const shutdown = async (signal: NodeJS.Signals) => {
  serverLog.info({ action: "shutdown", signal }, "Server shutting down");
  await app.close();
  if (manualChrome) {
    await manualChrome.shutdown();
  }
  await queue.close();
  redis.disconnect();
};
process.on("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

await app.listen({ port: config.port, host: config.host });
serverLog.info({ action: "listening", port: config.port, host: config.host }, "Server listening");

if (manualChrome && config.manualChrome.autoOpen) {
  try {
    const status = await manualChrome.ensureSession();
    app.log.info(
      { remoteDebuggingUrl: status.remoteDebuggingUrl, profileDir: status.profileDir },
      "Manual Chrome auto-opened"
    );
  } catch (error) {
    app.log.error({ err: error }, "Manual Chrome auto-open failed");
  }
}
