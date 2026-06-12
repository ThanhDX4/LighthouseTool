import lighthouse from "lighthouse";
import type { Page } from "puppeteer-core";
import type { AuditConfig, FormFactor } from "../types/config.js";
import { sanitizeManualErrorMessage } from "../manual-chrome/access-control.js";
import { createLogger } from "../observability/logger.js";
import { resolveLighthouseOnlyCategories, resolveMobileThrottling } from "./configs.js";

const log = createLogger("lighthouse-manual");

const DEFAULT_TIMEOUT_MS = 120_000;
const BLANK_PAGE_TIMEOUT_MS = 150_000;

const defaultDesktopViewport = {
  mobile: false,
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  disabled: false
};

export interface RunManualTabOptions {
  page: Page;
  auditUrl: string;
  formFactor: FormFactor;
  config: AuditConfig;
  allowedHosts?: string[];
  timeoutMs?: number;
}

/**
 * Runs Lighthouse against an already-connected Puppeteer page.
 *
 * Unlike runOnceLighthouse, this never launches or closes Chrome, never closes
 * the page, and never disconnects the browser. The caller owns the connection
 * for the whole job and passes the same frozen auditUrl on every run.
 *
 * Host allowlist enforcement has been removed — any URL the tab navigates to
 * during the audit is accepted. The only URL-level guard remaining is the
 * scheme check (http/https) which is enforced by `new URL(...)` and Lighthouse
 * itself.
 */
export async function runManualTabLighthouse(options: RunManualTabOptions): Promise<any> {
  const { page, auditUrl, formFactor, config } = options;

  assertAuditableUrl(auditUrl);

  // Park the tab at about:blank before invoking Lighthouse. The audited tab is
  // usually already at `auditUrl` (and may have an active service worker,
  // BFCache snapshot, or other hot state), which causes Lighthouse's trace
  // processor to throw NO_NAVSTART because Chrome short-circuits the
  // navigation and never emits a fresh `navigationStart` event. Cookies and
  // localStorage are origin-scoped and persist across this about:blank trip,
  // so the authenticated session is not lost.
  let preBlankUrl: string | undefined;
  try {
    preBlankUrl = page.url();
  } catch {
    preBlankUrl = undefined;
  }
  log.info(
    { action: "run.begin", formFactor, currentUrl: preBlankUrl, auditUrl },
    "Manual tab Lighthouse run starting"
  );

  // Reset device-metrics, CPU, and network emulation that a previous Lighthouse
  // run on this same shared page may have left behind. Lighthouse clears
  // throttling in its per-run cleanup but does NOT clear device emulation;
  // residual overrides across runs can cause Chrome to short-circuit the next
  // navigation and trigger NO_NAVSTART on the second form factor.
  await clearPageEmulation(page);

  try {
    await page.goto("about:blank", { waitUntil: "load", timeout: BLANK_PAGE_TIMEOUT_MS });
    log.debug({ action: "blankReset.ok", previousUrl: preBlankUrl }, "Parked tab at about:blank");
  } catch (error) {
    log.warn(
      { action: "blankReset.failed", err: error, previousUrl: preBlankUrl },
      "Failed to park tab at about:blank before audit — proceeding anyway"
    );
  }

  const flags: Record<string, unknown> = {
    output: "json",
    logLevel: "error",
    onlyCategories: resolveLighthouseOnlyCategories(config.categories),
    formFactor,
    maxWaitForLoad: 60_000,
    // Always preserve profile/auth state for manual sessions.
    disableStorageReset: true
  };

  if (formFactor === "desktop") {
    flags.screenEmulation = defaultDesktopViewport;
  } else {
    flags.throttlingMethod = "simulate";
    flags.throttling = resolveMobileThrottling(config);
  }

  const run = (lighthouse as any)(auditUrl, flags, undefined, page);
  const result = await withTimeout<any>(run, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (!result?.lhr) throw new Error("Lighthouse returned no LHR");
  if (result.lhr.runtimeError) {
    log.error(
      {
        action: "lighthouse.runtimeError",
        code: result.lhr.runtimeError.code,
        finalUrl: result.lhr.finalDisplayedUrl ?? result.lhr.finalUrl ?? result.lhr.requestedUrl
      },
      "Lighthouse returned a runtimeError"
    );
    throw new Error(`runtimeError: ${result.lhr.runtimeError.code ?? result.lhr.runtimeError.message}`);
  }

  return result.lhr;
}

/**
 * Reset any device-metrics, CPU, or network emulation overrides left on the
 * page by a previous Lighthouse run. Each command is best-effort — failures
 * are logged but never abort the audit, because the same overrides may simply
 * not be present (e.g. on the first run).
 */
async function clearPageEmulation(page: Page): Promise<void> {
  let cdp: { send(method: string, params?: unknown): Promise<unknown>; detach(): Promise<void> } | undefined;
  try {
    cdp = (await page.target().createCDPSession()) as unknown as typeof cdp;
  } catch (error) {
    log.warn({ action: "emulation.reset.sessionFailed", err: error }, "Could not open CDP session to clear emulation");
    return;
  }
  if (!cdp) return;

  const safeSend = async (method: string, params?: unknown) => {
    try {
      await cdp!.send(method, params);
    } catch (error) {
      log.debug({ action: "emulation.reset.cmdFailed", method, err: error }, "Emulation reset command failed");
    }
  };

  await safeSend("Emulation.clearDeviceMetricsOverride");
  await safeSend("Emulation.setCPUThrottlingRate", { rate: 1 });
  await safeSend("Emulation.setTouchEmulationEnabled", { enabled: false });
  await safeSend("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  await safeSend("Network.setBypassServiceWorker", { bypass: false });

  try {
    await cdp.detach();
  } catch {
    // ignore detach failures
  }
}

function assertAuditableUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid tab URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("LIGHTHOUSE_TIMEOUT")), timeoutMs);
    })
  ]);
}

// Re-exported so callers can reuse the same sanitizer used internally.
export { sanitizeManualErrorMessage };
