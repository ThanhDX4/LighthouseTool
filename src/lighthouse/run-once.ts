import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import type { AuditConfig, BasicAuthConfig, FormFactor, FormLoginConfig } from "../types/config.js";
import { resolveLighthouseOnlyCategories, resolveMobileThrottling } from "./configs.js";

export class FatalAuditError extends Error {
  fatal = true;
}

export interface RunOnceOptions {
  url: string;
  formFactor: FormFactor;
  config: AuditConfig;
  timeoutMs?: number;
}

const defaultDesktopViewport = {
  mobile: false,
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  disabled: false
};
const chromeFlags = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];
const http2DisabledChromeFlag = "--disable-http2";
const navigationReadyState = "domcontentloaded";
const successfulLoginStabilizationDelayMs = 2000;

export async function runOnceLighthouse(options: RunOnceOptions): Promise<any> {
  const launchAttempts: string[][] = [chromeFlags];
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < launchAttempts.length; attemptIndex += 1) {
    const launchFlags = launchAttempts[attemptIndex] ?? chromeFlags;
    try {
      return await runOnceLighthouseWithChromeFlags(options, launchFlags);
    } catch (error) {
      lastError = error;
      const hasHttp2Retry = launchAttempts.some((attempt) => attempt.includes(http2DisabledChromeFlag));
      const hasHeadedRetry = launchAttempts.some((attempt) => !attempt.some((flag) => flag.startsWith("--headless")));

      if (isHttp2ProtocolError(error) && !hasHttp2Retry) {
        launchAttempts.push([...chromeFlags, http2DisabledChromeFlag]);
        continue;
      }
      if (isRecoverableLoginNavigationError(error, options.config.formLogin.enabled) && !hasHeadedRetry) {
        launchAttempts.push(headedChromeFlags());
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function runOnceLighthouseWithChromeFlags(options: RunOnceOptions, launchFlags: string[]): Promise<any> {
  const chrome = await launchChromeWithRetry(launchFlags);
  let browser: Browser | undefined;
  try {
    const extraHeaders = buildBasicAuthHeaders(options.config.basicAuth);
    let page: Page | undefined;

    if (options.config.formLogin.enabled) {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
      const pages = await browser.pages();
      page = pages[0] ?? (await browser.newPage());
      await performFormLogin(page, options.config.formLogin, extraHeaders);
    }

    const flags: Record<string, unknown> = {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: resolveLighthouseOnlyCategories(options.config.categories),
      formFactor: options.formFactor,
      extraHeaders,
      maxWaitForLoad: 60_000,
      disableStorageReset: options.config.formLogin.enabled
    };

    let lighthouseConfig: unknown;
    if (options.formFactor === "desktop") {
      flags.screenEmulation = defaultDesktopViewport;
      const desktopConfig = (await import("lighthouse/core/config/desktop-config.js")).default;
      lighthouseConfig = {
        ...desktopConfig,
        settings: {
          ...desktopConfig.settings,
          screenEmulation: defaultDesktopViewport
        }
      };
    } else {
      flags.throttlingMethod = "simulate";
      flags.throttling = resolveMobileThrottling(options.config);
    }

    const run = page
      ? (lighthouse as any)(options.url, flags, lighthouseConfig, page)
      : (lighthouse as any)(options.url, flags, lighthouseConfig);
    const result = await withTimeout<any>(run, options.timeoutMs ?? 120_000);
    if (!result?.lhr) throw new Error("Lighthouse returned no LHR");
    if (result.lhr.runtimeError) {
      throw new Error(`runtimeError: ${result.lhr.runtimeError.code ?? result.lhr.runtimeError.message}`);
    }
    return result.lhr;
  } finally {
    if (browser) await browser.disconnect();
    await chrome.kill();
  }
}

export function buildBasicAuthHeaders(basicAuth: BasicAuthConfig): Record<string, string> {
  if (!basicAuth.enabled || typeof basicAuth.password !== "string" || !basicAuth.username) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString("base64")}`
  };
}

export async function performFormLogin(
  page: Page,
  formLogin: FormLoginConfig,
  extraHeaders: Record<string, string>
): Promise<void> {
  if (!formLogin.loginUrl || typeof formLogin.password !== "string" || !formLogin.username) {
    throw new FatalAuditError("Form login failed: incomplete credentials");
  }
  try {
    if (Object.keys(extraHeaders).length > 0) await page.setExtraHTTPHeaders(extraHeaders);
    // Retry transient server errors (5xx) when opening the login page. This
    // helps when an upstream service or load balancer briefly returns 502/503.
    const maxLoginAttempts = 3;
    let loginResponse: unknown | undefined;
    for (let attempt = 1; attempt <= maxLoginAttempts; attempt += 1) {
      loginResponse = await page.goto(formLogin.loginUrl, {
        waitUntil: navigationReadyState,
        timeout: formLogin.postLogin.timeoutMs
      });

      // If the response has a numeric status and it's a 5xx, consider it
      // transient and retry (with a small backoff) before failing fatally.
      const status =
        loginResponse && typeof (loginResponse as { status?: unknown }).status === "function"
          ? (loginResponse as { status: () => unknown }).status()
          : undefined;

      if (typeof status === "number" && status >= 500 && attempt < maxLoginAttempts) {
        // small exponential backoff
        await waitForDelay(2500 * attempt);
        continue;
      }

      // Either success or non-retriable status; validate and proceed.
      assertSuccessfulNavigation(loginResponse, "Login page");
      break;
    }
    await page.waitForSelector(formLogin.usernameSelector, { timeout: formLogin.postLogin.timeoutMs });
    await page.type(formLogin.usernameSelector, formLogin.username);
    await page.waitForSelector(formLogin.passwordSelector, { timeout: formLogin.postLogin.timeoutMs });
    await page.type(formLogin.passwordSelector, formLogin.password);
    const submitResponse = waitForLoginSubmitResponse(page, formLogin);
    const wait = buildPostLoginWait(page, formLogin, submitResponse);
    const waitResults = submitResponse
      ? await Promise.all([wait, submitResponse, page.click(formLogin.submitSelector)])
      : await Promise.all([wait, page.click(formLogin.submitSelector)]);
    const postLoginResponse = waitResults[0];
    const loginSubmitResponse = submitResponse ? waitResults[1] : undefined;
    const successfulResponse = loginSubmitResponse ?? postLoginResponse;
    assertSuccessfulNavigation(successfulResponse, "Post-login navigation");
    if (successfulResponse && typeof successfulResponse === "object" && "status" in successfulResponse) {
      await waitForDelay(successfulLoginStabilizationDelayMs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FatalAuditError(`Form login failed: ${message}`);
  }
}

function buildPostLoginWait(
  page: Page,
  formLogin: FormLoginConfig,
  loginSubmitResponse?: Promise<unknown>
): Promise<unknown> {
  const waitConfig = formLogin.postLogin;
  if (waitConfig.mode === "navigation") {
    return waitForNavigationOrSubmitResponse(page, formLogin, loginSubmitResponse);
  }
  if (waitConfig.mode === "selector") {
    return page.waitForSelector(waitConfig.selector ?? "", { timeout: waitConfig.timeoutMs });
  }
  return waitForDelay(waitConfig.delayMs ?? successfulLoginStabilizationDelayMs);
}

function waitForLoginSubmitResponse(page: Page, formLogin: FormLoginConfig): Promise<unknown> | undefined {
  const waitForResponse = (page as { waitForResponse?: Page["waitForResponse"] }).waitForResponse;
  if (typeof waitForResponse !== "function") return undefined;

  return waitForResponse.call(
    page,
    (response) => isLikelyLoginSubmitResponse(response, formLogin.loginUrl),
    { timeout: formLogin.postLogin.timeoutMs }
  );
}

function waitForNavigationOrSubmitResponse(
  page: Page,
  formLogin: FormLoginConfig,
  loginSubmitResponse?: Promise<unknown>
): Promise<unknown> {
  const navigation = page.waitForNavigation({
    timeout: formLogin.postLogin.timeoutMs,
    waitUntil: navigationReadyState
  });
  if (!loginSubmitResponse) return navigation;

  return Promise.any([navigation, loginSubmitResponse]);
}

function isLikelyLoginSubmitResponse(response: unknown, loginUrl: string | undefined): boolean {
  if (!loginUrl || !response || typeof response !== "object") return false;
  const request = typeof (response as { request?: unknown }).request === "function"
    ? (response as { request: () => unknown }).request()
    : undefined;
  const method = request && typeof (request as { method?: unknown }).method === "function"
    ? String((request as { method: () => unknown }).method()).toUpperCase()
    : "";
  if (!["POST", "PUT", "PATCH"].includes(method)) return false;

  const responseUrl = typeof (response as { url?: unknown }).url === "function"
    ? String((response as { url: () => unknown }).url())
    : "";
  return hasSameOrigin(responseUrl, loginUrl);
}

function hasSameOrigin(candidate: string, reference: string): boolean {
  try {
    return new URL(candidate).origin === new URL(reference).origin;
  } catch {
    return false;
  }
}

function assertSuccessfulNavigation(response: unknown, label: string): void {
  if (!response || typeof response !== "object" || !("status" in response)) return;
  const status = typeof (response as { status?: unknown }).status === "function"
    ? (response as { status: () => unknown }).status()
    : undefined;
  if (typeof status === "number" && status >= 400) {
    throw new Error(`${label} returned HTTP ${status}`);
  }
}

function isHttp2ProtocolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_HTTP2_PROTOCOL_ERROR") || message.includes("HTTP/2 stream");
}

function isRecoverableLoginNavigationError(error: unknown, formLoginEnabled: boolean): boolean {
  if (!formLoginEnabled) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Form login failed: Navigation timeout") ||
    message.includes("Form login failed: net::ERR_TIMED_OUT") ||
    message.includes("Form login failed: net::ERR_HTTP2_PROTOCOL_ERROR")
  );
}

function headedChromeFlags(): string[] {
  return chromeFlags.filter((flag) => !flag.startsWith("--headless"));
}

async function launchChromeWithRetry(launchFlags: string[]): Promise<chromeLauncher.LaunchedChrome> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await chromeLauncher.launch({ chromeFlags: launchFlags });
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Chrome launch failed after 3 attempts: ${message}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("LIGHTHOUSE_TIMEOUT")), timeoutMs);
    })
  ]);
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
