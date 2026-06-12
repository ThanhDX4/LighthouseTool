import { existsSync } from "node:fs";

export interface RuntimeConfig {
  nodeEnv: string;
  port: number;
  host: string;
  redisUrl: string;
  encryptionKey: string;
  downloadTokenSecret: string;
  dataDir: string;
  staticDir: string;
  chromePath?: string | undefined;
  workerConcurrency: number;
  allowInsecureDevSecrets: boolean;
  allowedHosts: string[];
  autoOpenBrowser: boolean;
  manualChrome: ManualChromeRuntimeConfig;
}

export interface ManualChromeRuntimeConfig {
  enabled: boolean;
  autoOpen: boolean;
  mode: "auto-launch" | "connect-only";
  port: number;
  profileDir: string;
  startupTimeoutMs: number;
  maxTabs: number;
  maxEvidenceFiles: number;
  maxEvidenceBytes: number;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const allowInsecureDevSecrets = env.ALLOW_INSECURE_DEV_SECRETS === "true" || env.NODE_ENV !== "production";
  const encryptionKey = env.ENCRYPTION_KEY ?? (allowInsecureDevSecrets ? devSecret("encryption") : "");
  const downloadTokenSecret = env.DOWNLOAD_TOKEN_SECRET ?? (allowInsecureDevSecrets ? devSecret("download") : "");

  if (!encryptionKey) throw new Error("ENCRYPTION_KEY is required");
  if (!downloadTokenSecret) throw new Error("DOWNLOAD_TOKEN_SECRET is required");

  const workerConcurrency = Number.parseInt(env.WORKER_CONCURRENCY ?? "1", 10);
  if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 2) {
    throw new Error("WORKER_CONCURRENCY must be 1 or 2");
  }
  const allowedHosts = parseCsv(env.ALLOWED_HOSTS);
  const manualChrome = {
    enabled: env.MANUAL_CHROME_ENABLED === "true",
    autoOpen: env.MANUAL_CHROME_AUTO_OPEN === "true" || true,
    mode: (env.MANUAL_CHROME_MODE?.trim() || "auto-launch") as "auto-launch" | "connect-only",
    port: parseIntegerSetting(env, "MANUAL_CHROME_PORT", 9222, 1024, 65_535),
    profileDir: env.MANUAL_CHROME_PROFILE_DIR?.trim() || ".lh-audit/chrome-profile",
    startupTimeoutMs: parseIntegerSetting(env, "MANUAL_CHROME_STARTUP_TIMEOUT_MS", 60_000, 1_000, 120_000),
    maxTabs: parseIntegerSetting(env, "MANUAL_CHROME_MAX_TABS", 20, 1, 100),
    maxEvidenceFiles: parseIntegerSetting(env, "MANUAL_CHROME_MAX_EVIDENCE_FILES", 100, 1, 1_000),
    maxEvidenceBytes: parseIntegerSetting(
      env,
      "MANUAL_CHROME_MAX_EVIDENCE_BYTES",
      50 * 1024 * 1024,
      1024,
      1024 * 1024 * 1024
    )
  } satisfies ManualChromeRuntimeConfig;

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    host: env.HOST ?? "0.0.0.0",
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    encryptionKey,
    downloadTokenSecret,
    dataDir: env.DATA_DIR ?? (env.NODE_ENV === "production" ? "/var/lib/lh-audit" : ".lh-audit"),
    staticDir: env.STATIC_DIR ?? "web/dist",
    chromePath: findChromePath(env),
    workerConcurrency,
    allowInsecureDevSecrets,
    allowedHosts,
    autoOpenBrowser: env.SERVER_AUTO_OPEN_BROWSER === "true",
    manualChrome
  };
}

function devSecret(label: string): string {
  return Buffer.from(`dev-only-${label}-secret`.padEnd(32, label[0] ?? "x").slice(0, 32)).toString("base64");
}

function findChromePath(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseIntegerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue.trim() === "") return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
