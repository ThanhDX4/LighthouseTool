import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import * as chromeLauncher from "chrome-launcher";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { assertAllowedManualUrl, sanitizeDisplayUrl } from "./access-control.js";
import { createLogger, type AppLogger } from "../observability/logger.js";
import type { ManualChromeErrorCode, ManualChromeScanSnapshot, ManualChromeSessionRecord } from "./types.js";

const sessionTtlSeconds = 45;
const sessionRenewIntervalMs = 15_000;
const scanTtlSeconds = 10 * 60;
const markerPrefix = "about:blank#manual-chrome-owner=";

export class ManualChromeError extends Error {
  constructor(
    message: string,
    readonly code: ManualChromeErrorCode,
    readonly statusCode: number
  ) {
    super(message);
  }
}

export interface ManualChromeStatus {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  profileSessionId?: string | undefined;
  remoteDebuggingUrl?: string | undefined;
  profileDir?: string | undefined;
}

export interface ManualChromeScanResponse {
  scanId: string;
  expiresAt: string;
  busy: false;
  remoteDebuggingUrl: string;
  totalOpenTabs: number;
  tabs: Array<{
    id: string;
    title: string;
    displayUrl: string;
    hasHiddenUrlParts: boolean;
    valid: true;
  }>;
  skipped: Array<{
    id: string;
    title: string;
    displayUrl: string;
    reason: string;
  }>;
}

interface ManualChromeStoreLike {
  initializeBoot(serverInstanceId: string): Promise<void>;
  getBootId(): Promise<string | null>;
  saveSession(record: ManualChromeSessionRecord, ttlSeconds: number): Promise<void>;
  getSession(): Promise<ManualChromeSessionRecord | null>;
  saveScan(snapshot: ManualChromeScanSnapshot, ttlSeconds: number): Promise<void>;
  getLock(profileSessionId: string): Promise<unknown | null>;
}

interface ManualChromeSessionDependencies {
  launchChrome(options: chromeLauncher.Options): Promise<chromeLauncher.LaunchedChrome>;
  connectBrowser(options: { browserURL: string }): Promise<Browser>;
  createId(): string;
  isPortInUse(port: number): Promise<boolean>;
}

export interface CreateManualChromeSessionManagerOptions {
  enabled: boolean;
  chromePath?: string | undefined;
  port: number;
  profileDir: string;
  startupTimeoutMs: number;
  maxTabs: number;
  allowedHosts: string[];
  store: ManualChromeStoreLike;
  dependencies?: Partial<ManualChromeSessionDependencies> | undefined;
  logger?: AppLogger | undefined;
}

export function createManualChromeSessionManager(options: CreateManualChromeSessionManagerOptions) {
  const dependencies: ManualChromeSessionDependencies = {
    launchChrome: options.dependencies?.launchChrome ?? ((launchOptions) => chromeLauncher.launch(launchOptions)),
    connectBrowser: options.dependencies?.connectBrowser ?? ((connectOptions) => puppeteer.connect(connectOptions)),
    createId: options.dependencies?.createId ?? randomUUID,
    isPortInUse: options.dependencies?.isPortInUse ?? probeLocalPort
  };
  const log = options.logger ?? createLogger("manual-chrome");
  let bootId = "";
  let launched: chromeLauncher.LaunchedChrome | null = null;
  let startPromise: Promise<ManualChromeStatus> | null = null;
  let renewalTimer: NodeJS.Timeout | null = null;

  async function initialize(): Promise<void> {
    bootId = dependencies.createId();
    await options.store.initializeBoot(bootId);
    log.info({ action: "initialize", bootId, port: options.port, profileDir: options.profileDir }, "Manual Chrome initialized");
  }

  async function ensureSession(): Promise<ManualChromeStatus> {
    assertEnabled();
    if (startPromise) {
      throw new ManualChromeError("Manual Chrome is starting", "MANUAL_CHROME_STARTING", 409);
    }

    startPromise = ensureSessionInner();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function ensureSessionInner(): Promise<ManualChromeStatus> {
    const existing = await options.store.getSession();
    if (existing && launched && isProcessAlive(launched) && existing.serverInstanceId === bootId) {
      await verifyOwnedSession({
        profileSessionId: existing.profileSessionId,
        serverInstanceId: existing.serverInstanceId
      });
      return statusFor(existing);
    }

    return startSession();
  }

  async function startSession(): Promise<ManualChromeStatus> {
    const profileSessionId = dependencies.createId();
    const ownerNonce = dependencies.createId();
    let chrome: chromeLauncher.LaunchedChrome;
    log.info({ action: "startSession.begin", profileSessionId, port: options.port }, "Launching manual Chrome");

    if (await dependencies.isPortInUse(options.port)) {
      log.warn({ action: "startSession.portInUse", port: options.port }, "Manual Chrome port already in use");
      throw new ManualChromeError(
        "Manual Chrome debugging port is already in use",
        "MANUAL_CHROME_PORT_IN_USE",
        409
      );
    }

    const launchOptions: chromeLauncher.Options = {
      port: options.port,
      userDataDir: options.profileDir,
      handleSIGINT: false,
      logLevel: "silent",
      startingUrl: "about:blank",
      chromeFlags: [
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    };
    if (options.chromePath) {
      launchOptions.chromePath = options.chromePath;
    }
    try {
      chrome = await withTimeout(dependencies.launchChrome(launchOptions), options.startupTimeoutMs);
    } catch (error) {
      log.error({ action: "startSession.launchFailed", err: error, port: options.port }, "Manual Chrome launch failed");
      throw mapLaunchError(error);
    }

    const browser = await connect(chrome.port);
    try {
      const existingPages = await browser.pages();
      const markerPage = existingPages.find((page) => page.url() === "about:blank") ?? (await browser.newPage());
      await markerPage.goto(markerUrl(ownerNonce));
    } finally {
      await browser.disconnect();
    }

    launched = chrome;
    const record = buildSessionRecord({
      profileSessionId,
      ownerNonce,
      serverInstanceId: bootId,
      port: chrome.port,
      profileDir: options.profileDir,
      processId: chrome.pid
    });
    await options.store.saveSession(record, sessionTtlSeconds);
    startRenewal(record);
    log.info(
      {
        action: "startSession.ready",
        profileSessionId,
        port: chrome.port,
        chromePid: chrome.pid
      },
      "Manual Chrome ready"
    );
    return statusFor(record);
  }

  async function verifyOwnedSession(expected?: {
    profileSessionId: string;
    serverInstanceId: string;
  }): Promise<ManualChromeSessionRecord> {
    assertEnabled();
    const connection = await connectOwnedSession(expected);
    try {
      return connection.session;
    } finally {
      await connection.browser.disconnect();
    }
  }

  async function connectOwnedSession(expected?: {
    profileSessionId: string;
    serverInstanceId: string;
  }): Promise<{ session: ManualChromeSessionRecord; browser: Browser }> {
    const currentBootId = await options.store.getBootId();
    const session = await options.store.getSession();
    if (
      !currentBootId ||
      !session ||
      session.serverInstanceId !== currentBootId ||
      session.serverInstanceId !== bootId ||
      (expected &&
        (expected.profileSessionId !== session.profileSessionId || expected.serverInstanceId !== session.serverInstanceId))
    ) {
      log.warn(
        {
          action: "connectOwnedSession.unowned",
          hasSession: Boolean(session),
          bootMatches: session?.serverInstanceId === currentBootId
        },
        "Manual Chrome ownership check failed"
      );
      throw new ManualChromeError("Manual Chrome profile is not owned by this server", "MANUAL_CHROME_UNOWNED", 503);
    }

    const browser = await connect(session.port);
    const pages = await browser.pages();
    if (!pages.some((page) => page.url() === markerUrl(session.ownerNonce))) {
      await browser.disconnect();
      log.warn(
        { action: "connectOwnedSession.markerMissing", profileSessionId: session.profileSessionId },
        "Manual Chrome ownership marker missing"
      );
      throw new ManualChromeError("Manual Chrome ownership marker is missing", "MANUAL_CHROME_UNOWNED", 503);
    }
    return { session, browser };
  }

  async function scanTabs(): Promise<ManualChromeScanResponse> {
    assertEnabled();
    const connection = await connectOwnedSession();
    try {
      if (await options.store.getLock(connection.session.profileSessionId)) {
        throw new ManualChromeError("Manual Chrome profile is busy", "MANUAL_CHROME_BUSY", 409);
      }
      const pages = await connection.browser.pages();
      const visiblePages = pages.filter((page) => !page.url().startsWith(markerPrefix));
      const candidates = visiblePages.slice(0, options.maxTabs);
      const snapshotTabs: ManualChromeScanSnapshot["tabs"] = [];

      for (const page of candidates) {
        const rawUrl = page.url();
        const id = await pageTargetId(page);
        const title = await safeTitle(page);
        try {
          const allowedUrl = assertAllowedManualUrl(rawUrl, options.allowedHosts);
          const sanitized = sanitizeDisplayUrl(allowedUrl.toString());
          snapshotTabs.push({
            id,
            title,
            rawUrl,
            displayUrl: sanitized.displayUrl,
            hasHiddenUrlParts: sanitized.hasHiddenUrlParts,
            valid: true,
            redirectHosts: [allowedUrl.hostname.toLowerCase()]
          });
        } catch (error) {
          snapshotTabs.push({
            id,
            title,
            rawUrl,
            displayUrl: safeSkippedDisplayUrl(rawUrl),
            hasHiddenUrlParts: hasHiddenParts(rawUrl),
            valid: false,
            redirectHosts: [],
            reason: error instanceof Error ? error.message : "Unsupported tab"
          });
        }
      }

      const scanId = dependencies.createId();
      const expiresAt = new Date(Date.now() + scanTtlSeconds * 1000).toISOString();
      const snapshot: ManualChromeScanSnapshot = {
        scanId,
        profileSessionId: connection.session.profileSessionId,
        serverInstanceId: connection.session.serverInstanceId,
        expiresAt,
        tabs: snapshotTabs.map((tab) => ({ ...tab, redirectHosts: [...tab.redirectHosts] }))
      };
      await options.store.saveScan(snapshot, scanTtlSeconds);
      log.info(
        {
          action: "scanTabs",
          scanId,
          totalOpenTabs: visiblePages.length,
          validTabs: snapshotTabs.filter((tab) => tab.valid).length,
          skippedTabs: snapshotTabs.filter((tab) => !tab.valid).length
        },
        "Manual Chrome scan completed"
      );

      return {
        scanId,
        expiresAt,
        busy: false,
        remoteDebuggingUrl: debuggingUrl(connection.session.port),
        totalOpenTabs: visiblePages.length,
        tabs: snapshotTabs
          .filter((tab) => tab.valid)
          .map((tab) => ({
            id: tab.id,
            title: tab.title,
            displayUrl: tab.displayUrl,
            hasHiddenUrlParts: tab.hasHiddenUrlParts,
            valid: true as const
          })),
        skipped: snapshotTabs
          .filter((tab) => !tab.valid)
          .map((tab) => ({
            id: tab.id,
            title: tab.title,
            displayUrl: tab.displayUrl,
            reason: tab.reason ?? "Unsupported tab"
          }))
      };
    } finally {
      await connection.browser.disconnect();
    }
  }

  async function shutdown(): Promise<void> {
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = null;
    log.info({ action: "shutdown" }, "Manual Chrome session manager shut down");
  }

  function startRenewal(record: ManualChromeSessionRecord): void {
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = setInterval(() => {
      if (!launched || !isProcessAlive(launched)) {
        if (renewalTimer) clearInterval(renewalTimer);
        renewalTimer = null;
        return;
      }
      const renewed = { ...record, expiresAt: expiresAt(sessionTtlSeconds) };
      void options.store.saveSession(renewed, sessionTtlSeconds);
    }, sessionRenewIntervalMs);
    renewalTimer.unref();
  }

  function assertEnabled(): void {
    if (!options.enabled) {
      throw new ManualChromeError("Manual Chrome is disabled", "MANUAL_CHROME_DISABLED", 403);
    }
    if (!bootId) {
      throw new ManualChromeError("Manual Chrome service is not initialized", "MANUAL_CHROME_UNAVAILABLE", 503);
    }
  }

  function connect(port: number): Promise<Browser> {
    return dependencies.connectBrowser({ browserURL: debuggingUrl(port) });
  }

  return {
    initialize,
    ensureSession,
    scanTabs,
    verifyOwnedSession,
    shutdown
  };
}

export interface ManualChromeRunConnection {
  browser: Browser;
  session: ManualChromeSessionRecord;
  resolvePageByTargetId(targetId: string): Promise<Page | null>;
}

interface ManualChromeRunStoreLike {
  getBootId(): Promise<string | null>;
  getSession(): Promise<ManualChromeSessionRecord | null>;
}

export interface ConnectManualChromeForRunOptions {
  store: ManualChromeRunStoreLike;
  expected: { profileSessionId: string; serverInstanceId: string };
  connectBrowser?: (options: { browserURL: string }) => Promise<Browser>;
}

/**
 * Worker-side connection helper. Verifies ownership against Redis (boot id,
 * session, expected profile/instance) and the live ownership marker, then
 * returns a CONNECTED browser. Unlike verifyOwnedSession this does NOT
 * disconnect — the caller (worker) owns the connection for the whole job and
 * must call browser.disconnect() in its finally. Never closes Chrome.
 */
export async function connectManualChromeForRun(
  options: ConnectManualChromeForRunOptions
): Promise<ManualChromeRunConnection> {
  const connectBrowser = options.connectBrowser ?? ((connectOptions) => puppeteer.connect(connectOptions));
  const currentBootId = await options.store.getBootId();
  const session = await options.store.getSession();
  if (
    !currentBootId ||
    !session ||
    session.serverInstanceId !== currentBootId ||
    session.serverInstanceId !== options.expected.serverInstanceId ||
    session.profileSessionId !== options.expected.profileSessionId
  ) {
    throw new ManualChromeError("Manual Chrome profile is not owned by this server", "MANUAL_CHROME_UNOWNED", 503);
  }

  const browser = await connectBrowser({ browserURL: debuggingUrl(session.port) });
  const pages = await browser.pages();
  if (!pages.some((page) => page.url() === markerUrl(session.ownerNonce))) {
    await browser.disconnect();
    throw new ManualChromeError("Manual Chrome ownership marker is missing", "MANUAL_CHROME_UNOWNED", 503);
  }

  return {
    browser,
    session,
    async resolvePageByTargetId(targetId: string): Promise<Page | null> {
      const livePages = await browser.pages();
      for (const page of livePages) {
        if (page.url().startsWith(markerPrefix)) continue;
        let pageTarget: string | undefined;
        try {
          pageTarget = await pageTargetId(page);
        } catch {
          continue;
        }
        if (pageTarget === targetId) return page;
      }
      return null;
    }
  };
}

function buildSessionRecord(input: Omit<ManualChromeSessionRecord, "startedAt" | "expiresAt">): ManualChromeSessionRecord {
  return {
    ...input,
    startedAt: new Date().toISOString(),
    expiresAt: expiresAt(sessionTtlSeconds)
  };
}

function statusFor(record: ManualChromeSessionRecord): ManualChromeStatus {
  return {
    enabled: true,
    running: true,
    busy: false,
    profileSessionId: record.profileSessionId,
    remoteDebuggingUrl: debuggingUrl(record.port),
    profileDir: record.profileDir
  };
}

async function pageTargetId(page: Page): Promise<string> {
  const session = await page.target().createCDPSession();
  try {
    const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    if (!result.targetInfo?.targetId) throw new Error("Chrome target ID is unavailable");
    return result.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return (await page.title()).slice(0, 200);
  } catch {
    return "Untitled tab";
  }
}

function safeSkippedDisplayUrl(rawUrl: string): string {
  try {
    return sanitizeDisplayUrl(rawUrl).displayUrl;
  } catch {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//...`;
    } catch {
      return "unsupported://...";
    }
  }
}

function hasHiddenParts(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return Boolean(url.search || url.hash || url.username || url.password);
  } catch {
    return false;
  }
}

function markerUrl(ownerNonce: string): string {
  return manualChromeMarkerUrl(ownerNonce);
}

export function manualChromeMarkerUrl(ownerNonce: string): string {
  return `${markerPrefix}${encodeURIComponent(ownerNonce)}`;
}

function debuggingUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function expiresAt(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function isProcessAlive(chrome: chromeLauncher.LaunchedChrome): boolean {
  return chrome.process.exitCode === null && !chrome.process.killed;
}

function mapLaunchError(error: unknown): ManualChromeError {
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|port.+in use|strict mode/i.test(message)) {
    return new ManualChromeError("Manual Chrome debugging port is already in use", "MANUAL_CHROME_PORT_IN_USE", 409);
  }
  if (message === "MANUAL_CHROME_START_TIMEOUT") {
    return new ManualChromeError("Manual Chrome did not start in time", "MANUAL_CHROME_START_TIMEOUT", 503);
  }
  const mapped = new ManualChromeError(
    `Manual Chrome could not be started: ${message}`,
    "MANUAL_CHROME_UNAVAILABLE",
    503
  );
  if (error instanceof Error) {
    (mapped as { cause?: unknown }).cause = error;
  }
  return mapped;
}

function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    let settled = false;
    const finalize = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => finalize(true));
    socket.once("error", () => finalize(false));
    socket.setTimeout(500, () => finalize(false));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MANUAL_CHROME_START_TIMEOUT")), timeoutMs);
      timer.unref();
    })
  ]);
}
