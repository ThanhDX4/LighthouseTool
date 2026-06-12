import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { mkdirSync } from "node:fs";
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
  mode: "auto-launch" | "connect-only";
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

    // Ensure the profile directory exists before passing to chrome-launcher.
    // chrome-launcher will try to write chrome-out.log to this location,
    // so we must create it recursively if it doesn't exist.
    try {
      mkdirSync(options.profileDir, { recursive: true });
    } catch (error) {
      // Only throw if error is not EEXIST (which means it was already created).
      // Other errors (permission denied, etc.) will bubble up.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code !== "EEXIST"
      ) {
        throw error;
      }
    }

    // In "connect-only" mode, try to connect to existing Chrome without launching.
    if (options.mode === "connect-only") {
      log.info(
        { action: "startSession.connectOnly", port: options.port },
        "Attempting to connect to existing Chrome (connect-only mode)"
      );
      try {
        const portInUse = await dependencies.isPortInUse(options.port);
        if (!portInUse) {
          throw new ManualChromeError(
            "Chrome is not running on the specified debugging port. Please start Chrome manually with --remote-debugging-port=9222",
            "MANUAL_CHROME_UNAVAILABLE",
            503
          );
        }
        // Port is in use, assume Chrome is running there. Connect to it.
        const browser = await connect(options.port);
        const pages = await browser.pages();
        await browser.disconnect();
        if (pages.length === 0) {
          throw new ManualChromeError(
            "Chrome is running but has no pages open. Please open at least one tab.",
            "MANUAL_CHROME_UNAVAILABLE",
            503
          );
        }
        log.info(
          { action: "startSession.connectedToExisting", port: options.port, pageCount: pages.length },
          "Successfully connected to existing Chrome"
        );
        // Return a minimal session record for connect-only mode
        const profileSessionId = dependencies.createId();
        const ownerNonce = dependencies.createId();
        const record = buildSessionRecord({
          profileSessionId,
          ownerNonce,
          serverInstanceId: bootId,
          port: options.port,
          profileDir: options.profileDir,
          processId: 0 // No process ID in connect-only mode
        });
        await options.store.saveSession(record, sessionTtlSeconds);
        startRenewal(record);
        log.info(
          {
            action: "startSession.ready",
            profileSessionId,
            port: options.port,
            mode: "connect-only"
          },
          "Manual Chrome ready (connect-only)"
        );
        return statusFor(record);
      } catch (error) {
        log.error(
          { action: "startSession.connectFailed", err: error, port: options.port },
          "Manual Chrome connection failed"
        );
        throw mapLaunchError(error);
      }
    }

    // "auto-launch" mode: launch Chrome normally (existing logic)
    const launchOptions: chromeLauncher.Options = {
      port: options.port,
      userDataDir: options.profileDir,
      handleSIGINT: false,
      logLevel: "silent",
      startingUrl: "about:blank",
      chromeFlags: [
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        // Performance optimizations to speed up launch time
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-extensions-with-background-pages",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-service-autorun",
        "--no-default-browser-check"
      ]
    };
    if (options.chromePath) {
      launchOptions.chromePath = options.chromePath;
    }
    try {
      const launchStartMs = Date.now();
      log.info(
        { action: "startSession.launchBegin", timeout: options.startupTimeoutMs, profileDir: options.profileDir },
        "Launching Chrome with launcher"
      );
      chrome = await withTimeout(dependencies.launchChrome(launchOptions), options.startupTimeoutMs);
      const launchDurationMs = Date.now() - launchStartMs;
      log.info(
        { action: "startSession.launchComplete", durationMs: launchDurationMs, port: chrome.port, pid: chrome.pid },
        "Chrome launched successfully"
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(
        { action: "startSession.launchFailed", err: error, port: options.port, errorMsg },
        "Manual Chrome launch failed"
      );
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
    profileSessionId?: string | undefined;
    serverInstanceId?: string | undefined;
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
    profileSessionId?: string | undefined;
    serverInstanceId?: string | undefined;
  }): Promise<{ session: ManualChromeSessionRecord; browser: Browser }> {
    // In connect-only mode, we don't enforce ownership - just connect to any Chrome
    // This allows multiple server instances and users to share the same Chrome instance
    const session = await options.store.getSession();
    if (!session) {
      log.warn(
        { action: "connectOwnedSession.noSession" },
        "No session found in store, creating new one"
      );
      // Create a minimal session if none exists and persist it so workers
      // that check immediately after claiming the lock can read it.
      const profileSessionId = randomUUID();
      const ownerNonce = randomUUID();
      const now = new Date().toISOString();
      const newSession: ManualChromeSessionRecord = {
        profileSessionId,
        ownerNonce,
        serverInstanceId: bootId,
        port: options.port,
        profileDir: options.profileDir,
        processId: 0,
        startedAt: now,
        expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000).toISOString()
      };
      // Persist and start renewal
      await options.store.saveSession(newSession, sessionTtlSeconds);
      startRenewal(newSession);
      return { session: newSession, browser: await connect(options.port) };
    }

    // Connect to Chrome on the stored port
    const browser = await connect(session.port);
    const pages = await browser.pages();
    if (pages.length === 0) {
      await browser.disconnect();
      log.warn(
        { action: "connectOwnedSession.noPages", profileSessionId: session.profileSessionId },
        "Chrome has no pages open"
      );
      throw new ManualChromeError(
        "Chrome is running but has no pages open. Please open at least one tab.",
        "MANUAL_CHROME_UNAVAILABLE",
        503
      );
    }
    
    log.info(
      { action: "connectOwnedSession.connected", profileSessionId: session.profileSessionId, pageCount: pages.length },
      "Connected to Chrome instance"
    );
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
  // When true, skip server-side ownership and marker checks and just connect
  // to the Chrome instance advertised in the session record. This enables
  // connect-only workflows where Chrome is started by the user and not owned
  // by a single server instance.
  skipOwnershipChecks?: boolean;
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
  // If the caller requested ownership checks to be skipped, only require a
  // valid session record and proceed to connect. Otherwise, enforce the
  // historical ownership semantics to detect stolen or mismatched sessions.
  if (!options.skipOwnershipChecks) {
    if (
      !currentBootId ||
      !session ||
      session.serverInstanceId !== currentBootId ||
      session.serverInstanceId !== options.expected.serverInstanceId ||
      session.profileSessionId !== options.expected.profileSessionId
    ) {
      throw new ManualChromeError("Manual Chrome profile is not owned by this server", "MANUAL_CHROME_UNOWNED", 503);
    }
  } else {
    if (!session) {
      throw new ManualChromeError("Manual Chrome session is not available", "MANUAL_CHROME_UNAVAILABLE", 503);
    }
  }

  const browser = await connectBrowser({ browserURL: debuggingUrl(session.port) });
  try {
    const pages = await browser.pages();
    if (!options.skipOwnershipChecks) {
      // When not skipping, assert the live ownership marker exists in the
      // connected browser to ensure this server still 'owns' the profile.
      if (!session.ownerNonce) {
        await browser.disconnect();
        throw new ManualChromeError("Manual Chrome ownership marker is missing", "MANUAL_CHROME_UNOWNED", 503);
      }
      if (!pages.some((page) => page.url() === markerUrl(session.ownerNonce!))) {
        await browser.disconnect();
        throw new ManualChromeError("Manual Chrome ownership marker is missing", "MANUAL_CHROME_UNOWNED", 503);
      }
    }
  } catch (err) {
    // Ensure browser is disconnected on unexpected errors during checks.
    try {
      await browser.disconnect();
    } catch {}
    throw err;
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
