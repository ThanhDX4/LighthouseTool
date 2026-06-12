import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import type { AuditConfig } from "../src/types/config.js";

const lighthouseMock = vi.fn();

vi.mock("lighthouse", () => ({
  default: (...args: unknown[]) => lighthouseMock(...args)
}));

import { runManualTabLighthouse } from "../src/lighthouse/run-manual-tab.js";

const ALLOWED_HOSTS = ["app.example.com"];
const FROZEN_URL = "https://app.example.com/dashboard?token=secret-query#frag-secret";

function buildConfig(): AuditConfig {
  return {
    mode: "manual-tabs",
    displayName: "Manual",
    baseUrl: "https://app.example.com",
    paths: ["/dashboard"],
    formFactors: ["mobile", "desktop"],
    categories: ["performance", "seo"],
    runsPerPage: 1,
    throttling: { preset: "slow-4g" },
    basicAuth: { enabled: false },
    formLogin: { enabled: false },
    manualChrome: {}
  } as unknown as AuditConfig;
}

interface FakeCdpSession {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

interface FakePage {
  close: ReturnType<typeof vi.fn>;
  browser: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  mainFrame: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  target: ReturnType<typeof vi.fn>;
}

function buildFakePage(): {
  page: FakePage;
  disconnect: ReturnType<typeof vi.fn>;
  cdp: FakeCdpSession;
} {
  const disconnect = vi.fn();
  const cdp: FakeCdpSession = {
    send: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined)
  };
  const page: FakePage = {
    close: vi.fn(),
    browser: vi.fn(() => ({ disconnect })),
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: vi.fn(() => ({ url: () => FROZEN_URL })),
    goto: vi.fn(async () => null),
    url: vi.fn(() => FROZEN_URL),
    target: vi.fn(() => ({ createCDPSession: vi.fn(async () => cdp) }))
  };
  return { page, disconnect, cdp };
}

function lhrResult(finalUrl: string) {
  return {
    lhr: {
      requestedUrl: FROZEN_URL,
      finalDisplayedUrl: finalUrl,
      categories: { performance: { score: 0.9 } },
      audits: {}
    }
  };
}

describe("runManualTabLighthouse", () => {
  beforeEach(() => {
    lighthouseMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes lighthouse with the frozen url, the connected page, and disableStorageReset", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page } = buildFakePage();

    const lhr = await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    expect(lhr.categories.performance.score).toBe(0.9);
    expect(lighthouseMock).toHaveBeenCalledTimes(1);

    const [url, flags, , passedPage] = lighthouseMock.mock.calls[0] as [string, Record<string, unknown>, unknown, unknown];
    expect(url).toBe(FROZEN_URL);
    expect(passedPage).toBe(page);
    expect(flags.disableStorageReset).toBe(true);
    expect(flags.onlyCategories).toEqual(["performance", "seo"]);
  });

  it("sets mobile throttling and no desktop screenEmulation for the mobile form factor", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page } = buildFakePage();

    await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    const [, flags] = lighthouseMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(flags.throttlingMethod).toBe("simulate");
    expect(flags.throttling).toMatchObject({ cpuSlowdownMultiplier: 4 });
    expect(flags.screenEmulation).toBeUndefined();
  });

  it("sets desktop screenEmulation and no mobile throttling for the desktop form factor", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page } = buildFakePage();

    await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "desktop",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    const [, flags] = lighthouseMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(flags.screenEmulation).toMatchObject({ mobile: false, width: 1920, height: 1080 });
    expect(flags.throttlingMethod).toBeUndefined();
    expect(flags.throttling).toBeUndefined();
  });

  it("accepts cross-host redirects during the audit (host allowlist is removed)", async () => {
    const offHostFinalUrl = "https://terms/accept";
    lighthouseMock.mockResolvedValue(lhrResult(offHostFinalUrl));
    const { page } = buildFakePage();

    const lhr = await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    expect(lhr.finalDisplayedUrl).toBe(offHostFinalUrl);
  });

  it("rejects auditUrls with a non-http(s) scheme", async () => {
    const { page } = buildFakePage();
    await expect(
      runManualTabLighthouse({
        page: page as unknown as Page,
        auditUrl: "chrome://settings",
        formFactor: "mobile",
        config: buildConfig(),
        allowedHosts: ALLOWED_HOSTS
      })
    ).rejects.toMatchObject({ message: expect.stringMatching(/Unsupported URL scheme/) });
  });

  it("clears device/CPU/network emulation overrides on the page before each run", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page, cdp } = buildFakePage();

    await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    const sentCommands = cdp.send.mock.calls.map((call: unknown[]) => call[0]);
    expect(sentCommands).toContain("Emulation.clearDeviceMetricsOverride");
    expect(sentCommands).toContain("Emulation.setCPUThrottlingRate");
    expect(sentCommands).toContain("Network.emulateNetworkConditions");
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });

  it("parks the tab at about:blank before invoking Lighthouse (NO_NAVSTART workaround)", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page } = buildFakePage();

    await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    expect(page.goto).toHaveBeenCalledWith("about:blank", expect.objectContaining({ waitUntil: "load" }));
    const blankCallOrder = page.goto.mock.invocationCallOrder[0] ?? 0;
    const lhCallOrder = lighthouseMock.mock.invocationCallOrder[0] ?? 0;
    expect(blankCallOrder).toBeLessThan(lhCallOrder);
  });

  it("still runs Lighthouse if the about:blank pre-navigation fails", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page } = buildFakePage();
    page.goto.mockRejectedValueOnce(new Error("Navigation timeout"));

    const lhr = await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    expect(lhr).toBeDefined();
    expect(lighthouseMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Lighthouse runtimeError (e.g. NO_NAVSTART) as a thrown error", async () => {
    lighthouseMock.mockResolvedValue({
      lhr: {
        requestedUrl: FROZEN_URL,
        finalDisplayedUrl: FROZEN_URL,
        runtimeError: { code: "NO_NAVSTART", message: "No navigationStart event found" },
        categories: {},
        audits: {}
      }
    });
    const { page } = buildFakePage();

    const error = await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    }).catch((e: unknown) => e as Error);

    expect(error.message).toBe("runtimeError: NO_NAVSTART");
  });

  it("never closes the page or disconnects the browser and does not attach a navigation listener", async () => {
    lighthouseMock.mockResolvedValue(lhrResult("https://app.example.com/dashboard"));
    const { page, disconnect } = buildFakePage();

    await runManualTabLighthouse({
      page: page as unknown as Page,
      auditUrl: FROZEN_URL,
      formFactor: "mobile",
      config: buildConfig(),
      allowedHosts: ALLOWED_HOSTS
    });

    expect(page.close).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    // The guard was removed — runner should NOT attach framenavigated listeners.
    expect(page.on).not.toHaveBeenCalledWith("framenavigated", expect.any(Function));
    expect(page.off).not.toHaveBeenCalledWith("framenavigated", expect.any(Function));
  });
});
