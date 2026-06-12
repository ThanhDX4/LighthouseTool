import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuditConfig, ManualChromeTargetDescriptor, ManualTabsAuditConfig } from "../src/types/config.js";
import { manualChromeMarkerUrl } from "../src/manual-chrome/session-manager.js";

const tokenSecret = Buffer.alloc(32, 8).toString("base64");

describe("audit worker report evidence", () => {
  it("generates one Lighthouse HTML evidence report for each successful worker run", async () => {
    vi.resetModules();
    vi.doMock("../src/security/credentials.js", () => ({
      decryptJobConfig: (config: AuditConfig) => config
    }));
    vi.doMock("../src/lighthouse/run-once.js", () => ({
      FatalAuditError: class FatalAuditError extends Error {
        fatal = true;
      },
      runOnceLighthouse: vi.fn()
    }));
    vi.doMock("../src/lighthouse/run-route.js", () => ({
      runRouteAudits: async (input: any) => {
        const successfulRuns = Array.from({ length: input.runsTotal }, (_unused, index) => ({
          runIndex: index + 1,
          lhr: minimalLhr(input.url, index + 1)
        }));
        for (const run of successfulRuns) {
          await input.onRunComplete({ runIndex: run.runIndex, ok: true, durationMs: 10 });
        }
        return {
          status: "ok",
          lhrs: successfulRuns.map((run) => run.lhr),
          successfulRuns,
          medianLhr: successfulRuns[0]!.lhr,
          medianRunIndex: 1,
          errors: []
        };
      }
    }));
    vi.doMock("../src/report/lighthouse-html.js", () => ({
      buildLighthouseHtmlReport: (lhr: any) => `<!doctype html><title>${lhr.finalDisplayedUrl}</title>`
    }));

    const { processAuditJob } = await import("../src/worker/audit-worker.js");
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-evidence-"));
    const job = {
      data: {
        jobId: "job-html-evidence",
        config: auditConfig,
        createdAt: "2026-06-05T00:00:00.000Z"
      },
      updateProgress: vi.fn()
    };

    const result = await processAuditJob(job as any, {
      connection: fakeRedis() as any,
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      downloadTokenSecret: tokenSecret,
      dataDir,
      concurrency: 1
    });

    const htmlReports = (result as any).htmlReports;
    expect(htmlReports).toHaveLength(2);
    expect(htmlReports[0]).toMatchObject({
      route: "/",
      formFactor: "desktop",
      runIndex: 1,
      downloadUrl: expect.stringMatching(/^\/jobs\/job-html-evidence\/evidence\/lighthouse-01-root-desktop-run-1\.html$/)
    });

    const reportDir = join(dataDir, "jobs", "job-html-evidence");
    await expect(fs.stat(join(reportDir, "report.xlsx"))).resolves.toBeTruthy();
    await expect(fs.stat(join(reportDir, "evidence", htmlReports[0].fileName))).resolves.toBeTruthy();
    const meta = JSON.parse(await fs.readFile(join(reportDir, "meta.json"), "utf8"));
    expect(meta.evidence.htmlReports).toHaveLength(2);
  });

  it("runs compare environments sequentially and records environment evidence", async () => {
    vi.resetModules();
    const routeRuns: Array<{ url: string; route: string; formFactor: string }> = [];
    const runOnceCalls: any[] = [];

    vi.doMock("../src/security/credentials.js", () => ({
      decryptJobConfig: (config: AuditConfig) => config
    }));
    vi.doMock("../src/lighthouse/run-once.js", () => ({
      FatalAuditError: class FatalAuditError extends Error {
        fatal = true;
      },
      runOnceLighthouse: vi.fn(async (options: any) => {
        runOnceCalls.push(options);
        return minimalLhr(options.url, 1);
      })
    }));
    vi.doMock("../src/lighthouse/run-route.js", () => ({
      runRouteAudits: async (input: any) => {
        routeRuns.push({ url: input.url, route: input.route, formFactor: input.formFactor });
        const lhr = await input.runOnce(input.url, 1);
        await input.onRunComplete({ runIndex: 1, ok: true, durationMs: 10 });
        return {
          status: "ok",
          lhrs: [lhr],
          successfulRuns: [{ runIndex: 1, lhr }],
          medianLhr: lhr,
          medianRunIndex: 1,
          errors: []
        };
      }
    }));
    vi.doMock("../src/report/lighthouse-html.js", () => ({
      buildLighthouseHtmlReport: (lhr: any) => `<!doctype html><title>${lhr.finalDisplayedUrl}</title>`
    }));

    const { processAuditJob } = await import("../src/worker/audit-worker.js");
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-compare-"));
    const updateProgress = vi.fn();
    const job = {
      data: {
        jobId: "job-compare-evidence",
        config: compareAuditConfig,
        createdAt: "2026-06-05T00:00:00.000Z"
      },
      updateProgress
    };

    const result = await processAuditJob(job as any, {
      connection: fakeRedis() as any,
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      downloadTokenSecret: tokenSecret,
      dataDir,
      concurrency: 1
    });

    expect(routeRuns).toEqual([
      { url: "https://dev1.example.com/mypage", route: "/mypage", formFactor: "desktop" },
      { url: "https://dev1.example.com/mypage", route: "/mypage", formFactor: "mobile" },
      { url: "https://dev3.example.com/mypage", route: "/mypage", formFactor: "desktop" },
      { url: "https://dev3.example.com/mypage", route: "/mypage", formFactor: "mobile" }
    ]);
    expect(runOnceCalls.map((call) => call.config.formLogin.loginUrl)).toEqual([
      "https://dev1.example.com/login",
      "https://dev1.example.com/login",
      "https://dev3.example.com/login",
      "https://dev3.example.com/login"
    ]);
    expect(updateProgress.mock.calls[0]?.[0]).toMatchObject({
      eventName: "started",
      totalRuns: 4
    });

    const htmlReports = (result as any).htmlReports;
    expect(htmlReports).toHaveLength(4);
    expect(htmlReports[0]).toMatchObject({
      environment: { name: "Dev 1", baseUrl: "https://dev1.example.com" },
      route: "/mypage",
      formFactor: "desktop"
    });
    expect((result as any).evidenceIndex).toMatchObject({
      downloadUrl: "/jobs/job-compare-evidence/evidence/index.html"
    });

    const reportDir = join(dataDir, "jobs", "job-compare-evidence");
    const meta = JSON.parse(await fs.readFile(join(reportDir, "meta.json"), "utf8"));
    expect(meta.config.environments).toEqual([
      { name: "Dev 1", baseUrl: "https://dev1.example.com" },
      { name: "Dev 3", baseUrl: "https://dev3.example.com" }
    ]);
    expect(meta.evidence.indexHtmlReport).toEqual({
      fileName: "index.html",
      relativePath: "evidence/index.html"
    });
  });
});

const auditConfig: AuditConfig = {
  baseUrl: "https://example.com",
  displayName: "Example",
  paths: ["/"],
  formFactors: ["desktop"],
  categories: ["performance"],
  runsPerPage: 2,
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

const compareAuditConfig = {
  ...auditConfig,
  baseUrl: "https://dev1.example.com",
  displayName: "Dev compare",
  environments: [
    { name: "Dev 1", baseUrl: "https://dev1.example.com" },
    { name: "Dev 3", baseUrl: "https://dev3.example.com" }
  ],
  paths: ["/mypage"],
  formFactors: ["desktop", "mobile"],
  runsPerPage: 1,
  formLogin: {
    enabled: true,
    loginUrl: "https://dev1.example.com/login",
    usernameSelector: "input[name=\"email\"]",
    username: "qa@example.com",
    passwordSelector: "input[name=\"password\"]",
    password: "secret",
    submitSelector: "button[type=\"submit\"]",
    postLogin: { mode: "navigation", timeoutMs: 30_000 }
  }
};

function minimalLhr(url: string, runIndex: number) {
  return {
    requestedUrl: url,
    finalDisplayedUrl: url,
    fetchTime: "2026-06-05T09:10:00.000Z",
    lighthouseVersion: "13.3.0",
    environment: { hostUserAgent: "Chrome/138.0.0.0" },
    categories: {
      performance: {
        id: "performance",
        title: "Performance",
        score: runIndex === 1 ? 0.91 : 0.93,
        auditRefs: []
      }
    },
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

const PROFILE_SESSION_ID = "profile-1";
const OWNER_TOKEN = "owner-token-1";
const FENCING_NUMBER = 7;
const SERVER_INSTANCE_ID = "boot-1";
const OWNER_NONCE = "nonce-1";
const manualIdentity = {
  profileSessionId: PROFILE_SESSION_ID,
  ownerToken: OWNER_TOKEN,
  fencingNumber: FENCING_NUMBER
};
const RAW_AUDIT_URL = "https://app.example.com/secret?token=abc";

describe("audit worker manual tabs", () => {
  it("does not touch the manual store for static jobs", async () => {
    const { processAuditJob, store, runManualTab } = await setupManual();
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-static-"));
    const job = makeJob("job-static-guard", auditConfig);

    await processAuditJob(job, manualOptions(dataDir, store));

    expect(store.markRunning).not.toHaveBeenCalled();
    expect(runManualTab).not.toHaveBeenCalled();
  });

  it("marks running, verifies ownership, runs each tab, and releases the lock", async () => {
    const { processAuditJob, store, runManualTab, connectBrowser, browser } = await setupManual();
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-ok-"));
    const job = makeJob("job-manual-ok", manualConfig());

    const result = await processAuditJob(job, manualOptions(dataDir, store, { connectBrowser }));

    expect(store.markRunning).toHaveBeenCalledWith(manualIdentity, 60);
    expect(connectBrowser).toHaveBeenCalledTimes(1);
    expect(runManualTab).toHaveBeenCalledTimes(1);
    expect(runManualTab.mock.calls[0]?.[0]).toMatchObject({ auditUrl: RAW_AUDIT_URL });
    expect((result as any).summary.successfulRuns).toBe(1);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(store.releaseLock).toHaveBeenCalledWith(manualIdentity);
  });

  it("never leaks the raw audit url into progress or report metadata", async () => {
    const { processAuditJob, store, connectBrowser } = await setupManual();
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-sanitize-"));
    const job = makeJob("job-manual-sanitize", manualConfig());

    await processAuditJob(job, manualOptions(dataDir, store, { connectBrowser }));

    const progressArgs = JSON.stringify(job.updateProgress.mock.calls);
    expect(progressArgs).not.toContain("token=abc");
    const meta = await fs.readFile(join(dataDir, "jobs", "job-manual-sanitize", "meta.json"), "utf8");
    expect(meta).not.toContain("token=abc");
  });

  it("fails closed before any CDP connection when markRunning returns null", async () => {
    const { processAuditJob, store, runManualTab, connectBrowser } = await setupManual({ markRunning: null });
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-lost-"));
    const job = makeJob("job-manual-lost", manualConfig());

    await expect(processAuditJob(job, manualOptions(dataDir, store, { connectBrowser }))).rejects.toThrow(
      /lock is no longer owned/i
    );
    expect(connectBrowser).not.toHaveBeenCalled();
    expect(runManualTab).not.toHaveBeenCalled();
    expect(store.releaseLock).not.toHaveBeenCalled();
  });

  it("aborts remaining runs and fails closed when lock renewal fails", async () => {
    const { processAuditJob, store, runManualTab, connectBrowser } = await setupManual({
      renew: false,
      runDelayMs: 25
    });
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-renew-"));
    const job = makeJob("job-manual-renew", manualConfig({ runsPerPage: 3 }));

    await expect(
      processAuditJob(job, manualOptions(dataDir, store, { connectBrowser, lockRenewIntervalMs: 1 }))
    ).rejects.toThrow(/lost or superseded/i);
    expect(runManualTab.mock.calls.length).toBeLessThan(3);
    expect(store.releaseLock).toHaveBeenCalledWith(manualIdentity);
  });

  it("records a missing-tab failure and still succeeds via another tab", async () => {
    const present = manualTarget({ targetId: "t-present", route: "/manual-tabs/01-home" });
    const missing = manualTarget({
      targetId: "t-missing",
      route: "/manual-tabs/02-away",
      displayUrl: "https://app.example.com/away"
    });
    const { processAuditJob, store, connectBrowser } = await setupManual({
      targets: [present, missing],
      pageTargetIds: ["t-present"]
    });
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-missing-"));
    const job = makeJob("job-manual-missing", manualConfig({ targets: [present, missing] }));

    const result = await processAuditJob(job, manualOptions(dataDir, store, { connectBrowser }));

    expect((result as any).summary.successfulRuns).toBe(1);
    expect((result as any).summary.status).toBe("partial");
    expect(store.releaseLock).toHaveBeenCalledWith(manualIdentity);
  });

  it("fails with the first useful error when every manual run fails", async () => {
    const { processAuditJob, store, connectBrowser } = await setupManual({
      runError: new Error(`Navigation to ${RAW_AUDIT_URL} timed out`)
    });
    const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-worker-manual-allfail-"));
    const job = makeJob("job-manual-allfail", manualConfig());

    await expect(processAuditJob(job, manualOptions(dataDir, store, { connectBrowser }))).rejects.toThrow(
      /All manual tab audits failed\. First error:/
    );
    expect(store.releaseLock).toHaveBeenCalledWith(manualIdentity);
  });
});

interface SetupManualOptions {
  markRunning?: unknown;
  renew?: boolean;
  runError?: Error;
  runDelayMs?: number;
  targets?: ManualChromeTargetDescriptor[];
  pageTargetIds?: string[];
}

async function setupManual(options: SetupManualOptions = {}) {
  vi.resetModules();
  vi.doMock("../src/security/credentials.js", () => ({
    decryptJobConfig: (config: AuditConfig) => config
  }));
  vi.doMock("../src/lighthouse/run-once.js", () => ({
    FatalAuditError: class FatalAuditError extends Error {
      fatal = true;
    },
    runOnceLighthouse: vi.fn(async (input: any) => minimalLhr(input.url, 1))
  }));
  vi.doMock("../src/lighthouse/run-route.js", async () => {
    const { FatalAuditError } = await import("../src/lighthouse/run-once.js");
    return {
      runRouteAudits: async (input: any) => {
        const lhrs: any[] = [];
        const successfulRuns: any[] = [];
        const errors: any[] = [];
        for (let runIndex = 1; runIndex <= input.runsTotal; runIndex += 1) {
          try {
            const lhr = await input.runOnce(input.url, runIndex);
            lhrs.push(lhr);
            successfulRuns.push({ runIndex, lhr });
            await input.onRunComplete({ runIndex, ok: true, durationMs: 10 });
          } catch (error) {
            if (input.isFatalError?.(error) || error instanceof FatalAuditError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ runIndex, message });
            await input.onRunComplete({ runIndex, ok: false, durationMs: 10, error: message });
          }
        }
        const ok = lhrs.length > 0;
        return {
          status: ok ? "ok" : "failed",
          lhrs,
          successfulRuns,
          medianLhr: ok ? lhrs[0] : null,
          medianRunIndex: ok ? successfulRuns[0]?.runIndex ?? null : null,
          errors
        };
      }
    };
  });
  const runManualTab = vi.fn(async (opts: any) => {
    if (options.runDelayMs) await new Promise((resolve) => setTimeout(resolve, options.runDelayMs));
    if (options.runError) throw options.runError;
    return minimalLhr(opts.auditUrl, 1);
  });
  vi.doMock("../src/lighthouse/run-manual-tab.js", () => ({
    runManualTabLighthouse: runManualTab
  }));
  vi.doMock("../src/report/lighthouse-html.js", () => ({
    buildLighthouseHtmlReport: (lhr: any) => `<!doctype html><title>${lhr.finalDisplayedUrl}</title>`
  }));

  const { processAuditJob } = await import("../src/worker/audit-worker.js");

  const targets = options.targets ?? [manualTarget()];
  const pageTargetIds = options.pageTargetIds ?? targets.map((target) => target.targetId);
  const pages = [
    fakePage(manualChromeMarkerUrl(OWNER_NONCE), "marker"),
    ...pageTargetIds.map((targetId, index) => fakePage(`https://app.example.com/tab-${index}`, targetId))
  ];
  const browser = { pages: async () => pages, disconnect: vi.fn(async () => {}) };
  const connectBrowser = vi.fn(async () => browser);

  const running =
    options.markRunning === null
      ? null
      : {
          jobId: "job",
          profileSessionId: PROFILE_SESSION_ID,
          ownerToken: OWNER_TOKEN,
          fencingNumber: FENCING_NUMBER,
          state: "running" as const,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
  const store = {
    getBootId: vi.fn(async () => SERVER_INSTANCE_ID),
    getSession: vi.fn(async () => ({
      profileSessionId: PROFILE_SESSION_ID,
      ownerNonce: OWNER_NONCE,
      serverInstanceId: SERVER_INSTANCE_ID,
      port: 9333,
      profileDir: "/tmp/manual-profile",
      processId: 1,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })),
    markRunning: vi.fn(async () => running),
    renewLock: vi.fn(async () => options.renew !== false),
    releaseLock: vi.fn(async () => true)
  };

  return { processAuditJob, store, runManualTab, connectBrowser, browser };
}

function fakePage(url: string, targetId: string) {
  return {
    url: () => url,
    target: () => ({
      createCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId } }),
        detach: async () => {}
      })
    })
  };
}

function manualTarget(overrides: Partial<ManualChromeTargetDescriptor> = {}): ManualChromeTargetDescriptor {
  return {
    targetId: "t-1",
    profileSessionId: PROFILE_SESSION_ID,
    ownerNonce: OWNER_NONCE,
    serverInstanceId: SERVER_INSTANCE_ID,
    auditUrl: RAW_AUDIT_URL,
    displayUrl: "https://app.example.com/secret",
    route: "/manual-tabs/01-home",
    selectedAt: "2026-06-05T00:00:00.000Z",
    ...overrides
  };
}

function manualConfig(overrides: { runsPerPage?: number; targets?: ManualChromeTargetDescriptor[] } = {}): ManualTabsAuditConfig {
  const targets = overrides.targets ?? [manualTarget()];
  return {
    mode: "manual-tabs",
    baseUrl: "https://app.example.com",
    displayName: "Manual session",
    paths: targets.map((target) => target.route),
    formFactors: ["desktop"],
    categories: ["performance"],
    runsPerPage: overrides.runsPerPage ?? 1,
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
        targets
      }
    }
  };
}

function makeJob(jobId: string, config: AuditConfig): any {
  return {
    data: { jobId, config, createdAt: "2026-06-05T00:00:00.000Z" },
    updateProgress: vi.fn()
  };
}

function manualOptions(
  dataDir: string,
  store: unknown,
  extra: { connectBrowser?: any; lockRenewIntervalMs?: number } = {}
): any {
  return {
    connection: fakeRedis(),
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    downloadTokenSecret: tokenSecret,
    dataDir,
    concurrency: 1,
    manualChrome: {
      allowedHosts: ["app.example.com"],
      store,
      connectBrowser: extra.connectBrowser,
      lockTtlSeconds: 60,
      lockRenewIntervalMs: extra.lockRenewIntervalMs
    }
  };
}
