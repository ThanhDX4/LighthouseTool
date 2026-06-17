import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuditConfig, ManualTabsAuditConfig } from "../src/types/config.js";

const tokenSecret = Buffer.alloc(32, 8).toString("base64");
const BOOT_ID = "boot-1";
const PROFILE_SESSION_ID = "profile-1";
const OWNER_NONCE = "nonce-1";
const OWNER_TOKEN = "token-1";
const FENCING_NUMBER = 7;
const MARKER_PREFIX = "about:blank#manual-chrome-owner=";

function manualConfig(overrides: Partial<ManualTabsAuditConfig> = {}): ManualTabsAuditConfig {
  return {
    mode: "manual-tabs",
    displayName: "Manual checkout",
    baseUrl: "https://app.example.com",
    paths: ["/01-dashboard"],
    formFactors: ["desktop"],
    categories: ["performance"],
    runsPerPage: 1,
    throttling: { preset: "slow-4g" },
    basicAuth: { enabled: false },
    formLogin: {
      enabled: false,
      usernameSelector: "input[name=\"email\"]",
      passwordSelector: "input[name=\"password\"]",
      submitSelector: "button[type=\"submit\"]",
      postLogin: { mode: "navigation", timeoutMs: 30_000 }
    },
    manualChrome: {
      cachePolicy: "preserve-profile",
      evidenceMode: "none",
      execution: {
        profileSessionId: PROFILE_SESSION_ID,
        ownerToken: OWNER_TOKEN,
        fencingNumber: FENCING_NUMBER,
        targets: [
          {
            targetId: "target-1",
            profileSessionId: PROFILE_SESSION_ID,
            ownerNonce: OWNER_NONCE,
            serverInstanceId: BOOT_ID,
            auditUrl: "https://app.example.com/dashboard?token=secret-query",
            displayUrl: "https://app.example.com/dashboard",
            route: "/01-dashboard",
            selectedAt: "2026-06-11T00:00:00.000Z"
          }
        ]
      }
    },
    ...overrides
  } as ManualTabsAuditConfig;
}

interface StoreCalls {
  markRunning: ReturnType<typeof vi.fn>;
  renewLock: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
}

function buildStore(
  options: {
    bootId?: string | null;
    ownerNonce?: string;
    canClaimLock?: boolean;
  } = {}
): { store: any; calls: StoreCalls } {
  const calls: StoreCalls = {
    markRunning: vi.fn(async () => (options.canClaimLock === false ? null : { state: "running" })),
    renewLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => true)
  };
  const store = {
    getBootId: async () => (options.bootId === undefined ? BOOT_ID : options.bootId),
    getSession: async () => ({
      profileSessionId: PROFILE_SESSION_ID,
      ownerNonce: options.ownerNonce ?? OWNER_NONCE,
      serverInstanceId: BOOT_ID,
      port: 9222,
      profileDir: ".lh-audit/chrome-profile",
      processId: 1234,
      startedAt: "2026-06-11T00:00:00.000Z",
      expiresAt: "2026-06-11T01:00:00.000Z"
    }),
    ...calls
  };
  return { store, calls };
}

function fakePage(targetId: string, url: string) {
  return {
    url: () => url,
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: () => ({ url: () => url }),
    target: () => ({
      createCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId } }),
        detach: async () => undefined
      })
    })
  };
}

function fakeBrowser(pages: unknown[]) {
  return {
    pages: async () => pages,
    disconnect: vi.fn(async () => undefined)
  };
}

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }
  };
}

function mockCommonModules(): void {
  vi.doMock("../src/security/credentials.js", () => ({
    decryptJobConfig: (config: AuditConfig) => config
  }));
  vi.doMock("../src/lighthouse/run-manual-tab.js", () => ({
    runManualTabLighthouse: vi.fn(async (options: any) => ({
      requestedUrl: options.auditUrl,
      finalDisplayedUrl: "https://app.example.com/dashboard",
      lighthouseVersion: "13.3.0",
      environment: { hostUserAgent: "Chrome/138.0.0.0" },
      categories: { performance: { id: "performance", title: "Performance", score: 0.9, auditRefs: [] } },
      audits: {
        "largest-contentful-paint": { numericValue: 2100, score: 0.9 },
        "cumulative-layout-shift": { numericValue: 0.04, score: 0.95 },
        "total-blocking-time": { numericValue: 120, score: 0.99 },
        "first-contentful-paint": { numericValue: 1050, score: 0.97 },
        "speed-index": { numericValue: 2500, score: 0.89 },
        interactive: { numericValue: 3300, score: 0.86 },
        "max-potential-fid": { numericValue: 80, score: 0.93 }
      },
      configSettings: { output: "html" }
    }))
  }));
}

async function runManualJob(
  store: any,
  browser: any,
  config: ManualTabsAuditConfig,
  jobId: string
): Promise<unknown> {
  const { processAuditJob } = await import("../src/worker/audit-worker.js");
  const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-"));
  const job = {
    data: { jobId, config, createdAt: "2026-06-11T00:00:00.000Z" },
    updateProgress: vi.fn()
  };
  const result = await processAuditJob(job as any, {
    connection: fakeRedis() as any,
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    downloadTokenSecret: tokenSecret,
    dataDir,
    concurrency: 1,
    manualChrome: {
      allowedHosts: ["app.example.com"],
      store,
      connectBrowser: async () => browser,
      lockRenewIntervalMs: 10_000
    }
  });
  return { result, dataDir };
}

describe("manual-tabs worker", () => {
  it(
    "claims the lock as running, audits the matched tab, and releases the lock",
    async () => {
    vi.resetModules();
    mockCommonModules();
    const { store, calls } = buildStore();
    const page = fakePage("target-1", "https://app.example.com/dashboard");
    const browser = fakeBrowser([fakePage("marker", `${MARKER_PREFIX}${OWNER_NONCE}`), page]);

    const { result, dataDir } = (await runManualJob(store, browser, manualConfig(), "job-manual-ok")) as {
      result: any;
      dataDir: string;
    };

    expect(calls.markRunning).toHaveBeenCalledWith(
      { profileSessionId: PROFILE_SESSION_ID, ownerToken: OWNER_TOKEN, fencingNumber: FENCING_NUMBER },
      expect.any(Number)
    );
    expect(calls.releaseLock).toHaveBeenCalledWith({
      profileSessionId: PROFILE_SESSION_ID,
      ownerToken: OWNER_TOKEN,
      fencingNumber: FENCING_NUMBER
    });
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(result.summary.successfulRuns).toBe(1);

    const meta = JSON.parse(await fs.readFile(join(dataDir, "jobs", "job-manual-ok", "meta.json"), "utf8"));
    expect(JSON.stringify(meta)).not.toContain("secret-query");
    },
    20_000
  );

  it("emits a Compare sheet and warning diagnostics for a 2-environment compare job", async () => {
    vi.resetModules();
    mockCommonModules();
    const { store } = buildStore();

    const compareConfig = manualConfig({
      paths: ["/checkout"],
      manualChrome: {
        cachePolicy: "preserve-profile",
        evidenceMode: "none",
        execution: {
          profileSessionId: PROFILE_SESSION_ID,
          ownerToken: OWNER_TOKEN,
          fencingNumber: FENCING_NUMBER,
          compareWarnings: [
            { reason: "UNBALANCED_ROUTE", displayUrl: "https://dev1.example.com/promo", detail: "/promo" }
          ],
          targets: [
            {
              targetId: "t-dev1",
              profileSessionId: PROFILE_SESSION_ID,
              ownerNonce: OWNER_NONCE,
              serverInstanceId: BOOT_ID,
              auditUrl: "https://dev1.example.com/checkout",
              displayUrl: "https://dev1.example.com/checkout",
              route: "/checkout",
              selectedAt: "2026-06-12T00:00:00.000Z",
              environment: { name: "Dev 1", baseUrl: "https://dev1.example.com" }
            },
            {
              targetId: "t-dev3",
              profileSessionId: PROFILE_SESSION_ID,
              ownerNonce: OWNER_NONCE,
              serverInstanceId: BOOT_ID,
              auditUrl: "https://dev3.example.com/checkout",
              displayUrl: "https://dev3.example.com/checkout",
              route: "/checkout",
              selectedAt: "2026-06-12T00:00:00.000Z",
              environment: { name: "Dev 3", baseUrl: "https://dev3.example.com" }
            }
          ]
        }
      }
    });

    const browser = fakeBrowser([
      fakePage("marker", `${MARKER_PREFIX}${OWNER_NONCE}`),
      fakePage("t-dev1", "https://dev1.example.com/checkout"),
      fakePage("t-dev3", "https://dev3.example.com/checkout")
    ]);

    const { dataDir } = (await runManualJob(store, browser, compareConfig, "job-manual-compare")) as {
      result: any;
      dataDir: string;
    };

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(dataDir, "jobs", "job-manual-compare", "report.xlsx"));
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);

    expect(sheetNames).toContain("Compare");
    expect(workbook.getWorksheet("Summary")?.getCell("A1").value).toBe("Environment");

    const diagnostics = workbook.getWorksheet("Diagnostics");
    const diagnosticCodes: unknown[] = [];
    diagnostics?.eachRow((row) => diagnosticCodes.push(row.getCell(6).value));
    expect(diagnosticCodes).toContain("COMPARE_UNBALANCED_ROUTE");
  });

  it("fails closed before connecting when the lock can no longer be claimed", async () => {
    vi.resetModules();
    mockCommonModules();
    const { store, calls } = buildStore({ canClaimLock: false });
    const browser = fakeBrowser([]);

    await expect(runManualJob(store, browser, manualConfig(), "job-stale-lock")).rejects.toThrow(/lock/i);
    expect(calls.markRunning).toHaveBeenCalledTimes(1);
    expect(browser.disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when the API boot identity no longer matches the frozen descriptor", async () => {
    vi.resetModules();
    mockCommonModules();
    const { store } = buildStore({ bootId: "boot-2" });
    const browser = fakeBrowser([]);

  await expect(runManualJob(store, browser, manualConfig(), "job-restarted")).rejects.toThrow();
  });

  it("records a diagnostic and fails the job when the selected tab is gone", async () => {
    vi.resetModules();
    mockCommonModules();
    const { store, calls } = buildStore();
    const browser = fakeBrowser([fakePage("marker", `${MARKER_PREFIX}${OWNER_NONCE}`)]);

    await expect(runManualJob(store, browser, manualConfig(), "job-missing-tab")).rejects.toThrow();
    expect(calls.releaseLock).toHaveBeenCalledTimes(1);
  });
});
