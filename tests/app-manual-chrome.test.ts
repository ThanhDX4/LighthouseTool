import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildApp,
  type BuildAppOptions,
  type ManualChromeAppService,
  type ManualChromeJobStore
} from "../src/server/app.js";
import { ManualChromeError } from "../src/manual-chrome/session-manager.js";
import { decryptJobConfig, isEncryptedSecret } from "../src/security/credentials.js";
import type { ManualChromeExecutionData } from "../src/types/config.js";
import type {
  ManualChromeScanSnapshot,
  ManualChromeSessionRecord
} from "../src/manual-chrome/types.js";

const encryptionKey = Buffer.alloc(32, 4).toString("base64");
const tokenSecret = Buffer.alloc(32, 5).toString("base64");

describe("manual Chrome endpoints", () => {
  it("reports manual Chrome availability through the health check", async () => {
    const withService = await buildApp(await baseOptions({ manualChrome: stubService() }));
    const withoutService = await buildApp(await baseOptions());

    const enabled = await withService.inject({ method: "GET", url: "/healthz" });
    const disabled = await withoutService.inject({ method: "GET", url: "/healthz" });

    expect(enabled.json()).toMatchObject({ manualChrome: true });
    expect(disabled.json()).toMatchObject({ manualChrome: false });

    await withService.close();
    await withoutService.close();
  });

  it("starts a session and scans tabs for a same-origin loopback request", async () => {
    const service = stubService({
      ensureSession: vi.fn(async () => ({ running: true, profileSessionId: "profile-1" })),
      scanTabs: vi.fn(async () => ({ scanId: "scan-1", tabs: [], skipped: [] }))
    });
    const app = await buildApp(await baseOptions({ manualChrome: service }));

    const session = await postManualChrome(app, "/manual-chrome/session");
    const scan = await postManualChrome(app, "/manual-chrome/tabs/scan");

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ running: true, profileSessionId: "profile-1" });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ scanId: "scan-1" });
    expect(service.ensureSession).toHaveBeenCalledTimes(1);
    expect(service.scanTabs).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("rejects non-loopback hosts before invoking the service", async () => {
    const service = stubService();
    const app = await buildApp(await baseOptions({ manualChrome: service }));
    const { csrfToken, cookie } = await csrfCredentials(app);

    const response = await app.inject({
      method: "POST",
      url: "/manual-chrome/session",
      headers: { host: "tool.example.com", "x-csrf-token": csrfToken, cookie }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "MANUAL_CHROME_FORBIDDEN" });
    expect(service.ensureSession).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects requests with a missing or mismatched CSRF token", async () => {
    const service = stubService();
    const app = await buildApp(await baseOptions({ manualChrome: service }));

    const response = await app.inject({
      method: "POST",
      url: "/manual-chrome/session",
      headers: { host: "localhost:3000" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "Invalid CSRF token" });
    expect(service.ensureSession).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 403 when manual Chrome is not configured", async () => {
    const app = await buildApp(await baseOptions());

    const response = await postManualChrome(app, "/manual-chrome/session");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "MANUAL_CHROME_DISABLED" });

    await app.close();
  });

  it("sets Cache-Control: no-store on success and error responses", async () => {
    const service = stubService();
    const enabledApp = await buildApp(await baseOptions({ manualChrome: service }));
    const disabledApp = await buildApp(await baseOptions());

    const success = await postManualChrome(enabledApp, "/manual-chrome/session");
    const disabled = await postManualChrome(disabledApp, "/manual-chrome/session");

    expect(success.statusCode).toBe(200);
    expect(success.headers["cache-control"]).toBe("no-store");
    expect(disabled.statusCode).toBe(403);
    expect(disabled.headers["cache-control"]).toBe("no-store");

    await enabledApp.close();
    await disabledApp.close();
  });

  it("allows a normal manual request without tripping the rate limit", async () => {
    const service = stubService();
    const app = await buildApp(await baseOptions({ manualChrome: service }));

    const response = await postManualChrome(app, "/manual-chrome/session");

    expect(response.statusCode).toBe(200);
    expect(service.ensureSession).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("maps ManualChromeError to its status code and sanitized payload", async () => {
    const service = stubService({
      ensureSession: vi.fn(async () => {
        throw new ManualChromeError("Manual Chrome is starting", "MANUAL_CHROME_STARTING", 409);
      })
    });
    const app = await buildApp(await baseOptions({ manualChrome: service }));

    const response = await postManualChrome(app, "/manual-chrome/session");

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Manual Chrome is starting", code: "MANUAL_CHROME_STARTING" });

    await app.close();
  });
});

describe("manual Chrome job submission", () => {
  it("enqueues encrypted target descriptors for a valid manual request", async () => {
    const enqueued: any[] = [];
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({
        manualChrome: service,
        manualChromeStore: store,
        allowedHosts: ["shop.example.com"],
        queue: {
          add: async (name: string, data: any, options: any) => {
            enqueued.push({ name, data, options });
            return { id: data.jobId };
          },
          getJobs: async () => []
        } as any
      })
    );

    const response = await postManualJob(app, {
      mode: "manual-tabs",
      formFactors: ["mobile"],
      manualChrome: {
        scanId: "scan-1",
        targetIds: ["target-1", "target-2"],
        cachePolicy: "preserve-profile",
        evidenceMode: "html"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      eventsUrl: expect.stringMatching(/^\/jobs\/.+\/events$/),
      downloadUrl: expect.stringMatching(/^\/jobs\/.+\/download$/)
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].name).toBe("run-audit");
    expect(service.verifyOwnedSession).toHaveBeenCalledWith({
      profileSessionId: "profile-1",
      serverInstanceId: "boot-1"
    });
    expect(store.acquireLock).toHaveBeenCalledTimes(1);

    const config = enqueued[0].data.config;
    expect(config.mode).toBe("manual-tabs");
    expect(config.baseUrl).toBe("https://shop.example.com");
    expect(config.manualChrome.cachePolicy).toBe("preserve-profile");
    expect(config.manualChrome.evidenceMode).toBe("html");
    expect(isEncryptedSecret(config.manualChrome.execution)).toBe(true);
    expect(JSON.stringify(enqueued[0].data)).not.toContain("otpToken");
    expect(JSON.stringify(enqueued[0].data)).not.toContain("super-secret");
    expect(JSON.stringify(enqueued[0].data)).not.toContain("/checkout");

    await app.close();
  });

  it("rejects an unknown or expired scanId", async () => {
    const service = stubService();
    const store = fakeStore({ getScan: vi.fn(async () => null) });
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(400);
    expect(store.acquireLock).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a target ID that is not present in the snapshot", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );

    const response = await postManualJob(app, manualPayload({ targetIds: ["target-9"] }));

    expect(response.statusCode).toBe(400);
    expect(store.acquireLock).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a selection that resolves to an invalid tab", async () => {
    const service = stubService();
    const store = fakeStore({
      getScan: vi.fn(async () =>
        scanSnapshot({
          tabs: [
            {
              id: "target-1",
              title: "Broken",
              rawUrl: "chrome://settings",
              displayUrl: "chrome://...",
              hasHiddenUrlParts: false,
              valid: false,
              redirectHosts: [],
              reason: "Unsupported URL scheme"
            }
          ]
        })
      )
    });
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );

    const response = await postManualJob(app, manualPayload({ targetIds: ["target-1"] }));

    expect(response.statusCode).toBe(400);
    expect(store.acquireLock).not.toHaveBeenCalled();

    await app.close();
  });

  it("accepts a selection regardless of the configured allowlist (allowlist removed)", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["other.example.com"] })
    );

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(202);
    expect(store.acquireLock).toHaveBeenCalled();

    await app.close();
  });

  it("accepts submissions when the host allowlist is empty (open to any host)", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: [] }));

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(202);
    expect(store.acquireLock).toHaveBeenCalled();

    await app.close();
  });

  it("accepts a selection whose redirect chain includes an off-allowlist host (allowlist removed)", async () => {
    const service = stubService();
    const store = fakeStore({
      getScan: vi.fn(async () =>
        scanSnapshot({
          tabs: [
            {
              id: "target-1",
              title: "Checkout",
              rawUrl: "https://shop.example.com/checkout",
              displayUrl: "https://shop.example.com/checkout",
              hasHiddenUrlParts: false,
              valid: true,
              redirectHosts: ["shop.example.com", "tracker.evil.com"]
            }
          ]
        })
      )
    });
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );

    const response = await postManualJob(app, manualPayload({ targetIds: ["target-1"] }));

    expect(response.statusCode).toBe(202);
    expect(store.acquireLock).toHaveBeenCalled();

    await app.close();
  });

  it("rejects a non-loopback caller with 403", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );
    const { csrfToken, cookie } = await csrfCredentials(app);

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { host: "tool.example.com", "x-csrf-token": csrfToken, cookie },
      payload: manualPayload()
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "MANUAL_CHROME_FORBIDDEN" });
    expect(service.verifyOwnedSession).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 403 when manual Chrome is disabled", async () => {
    const app = await buildApp(await baseOptions({ allowedHosts: ["shop.example.com"] }));

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "MANUAL_CHROME_DISABLED" });

    await app.close();
  });

  it("returns 409 when the profile lock is already held", async () => {
    const service = stubService();
    const store = fakeStore({ acquireLock: vi.fn(async () => null) });
    const app = await buildApp(
      await baseOptions({ manualChrome: service, manualChromeStore: store, allowedHosts: ["shop.example.com"] })
    );

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "MANUAL_CHROME_BUSY" });

    await app.close();
  });

  it("rejects when html evidence selection exceeds the evidence file limit", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({
        manualChrome: service,
        manualChromeStore: store,
        allowedHosts: ["shop.example.com"],
        manualChromeMaxEvidenceFiles: 1
      })
    );

    const response = await postManualJob(
      app,
      manualPayload({ targetIds: ["target-1", "target-2"], evidenceMode: "html" })
    );

    expect(response.statusCode).toBe(400);
    expect(store.acquireLock).not.toHaveBeenCalled();

    await app.close();
  });

  it("releases the lock via compare-and-delete when enqueue fails", async () => {
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({
        manualChrome: service,
        manualChromeStore: store,
        allowedHosts: ["shop.example.com"],
        queue: {
          add: async () => {
            throw new Error("redis unavailable");
          },
          getJobs: async () => []
        } as any
      })
    );

    const response = await postManualJob(app, manualPayload());

    expect(response.statusCode).toBe(503);
    expect(store.acquireLock).toHaveBeenCalledTimes(1);
    expect(store.releaseLock).toHaveBeenCalledWith({
      profileSessionId: "profile-1",
      ownerToken: expect.any(String),
      fencingNumber: 7
    });

    await app.close();
  });

  it("generates unique NN-prefixed route labels for the selected tabs", async () => {
    const enqueued: any[] = [];
    const service = stubService();
    const store = fakeStore();
    const app = await buildApp(
      await baseOptions({
        manualChrome: service,
        manualChromeStore: store,
        allowedHosts: ["shop.example.com"],
        queue: {
          add: async (name: string, data: any, options: any) => {
            enqueued.push({ name, data, options });
            return { id: data.jobId };
          },
          getJobs: async () => []
        } as any
      })
    );

    const response = await postManualJob(
      app,
      manualPayload({ targetIds: ["target-1", "target-2"], evidenceMode: "none" })
    );

    expect(response.statusCode).toBe(202);
    const config = decryptedExecution(enqueued[0].data.config);
    expect(config.targets.map((target: any) => target.route)).toEqual(["/manual-tabs/01-checkout", "/manual-tabs/02-account"]);
    const firstTarget = config.targets[0];
    expect(firstTarget).toBeDefined();
    expect(firstTarget?.auditUrl).toBe("https://shop.example.com/checkout?otpToken=super-secret");
    expect(firstTarget?.displayUrl).toBe("https://shop.example.com/checkout");
    expect(firstTarget?.profileSessionId).toBe("profile-1");
    expect(config.ownerToken).toEqual(expect.any(String));
    expect(config.fencingNumber).toBe(7);

    await app.close();
  });
});

function stubService(overrides: Partial<ManualChromeAppService> = {}): ManualChromeAppService & {
  ensureSession: ReturnType<typeof vi.fn>;
  scanTabs: ReturnType<typeof vi.fn>;
  verifyOwnedSession: ReturnType<typeof vi.fn>;
} {
  return {
    ensureSession: vi.fn(async () => ({ running: true })),
    scanTabs: vi.fn(async () => ({ scanId: "scan-1", tabs: [], skipped: [] })),
    verifyOwnedSession: vi.fn(async () => sessionRecord()),
    ...overrides
  } as ManualChromeAppService & {
    ensureSession: ReturnType<typeof vi.fn>;
    scanTabs: ReturnType<typeof vi.fn>;
    verifyOwnedSession: ReturnType<typeof vi.fn>;
  };
}

function fakeStore(overrides: Partial<ManualChromeJobStore> = {}): ManualChromeJobStore & {
  getScan: ReturnType<typeof vi.fn>;
  acquireLock: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
} {
  return {
    getScan: vi.fn(async () => scanSnapshot()),
    acquireLock: vi.fn(async (input: { jobId: string; profileSessionId: string; ownerToken: string }) => ({
      jobId: input.jobId,
      profileSessionId: input.profileSessionId,
      ownerToken: input.ownerToken,
      fencingNumber: 7,
      state: "queued" as const,
      expiresAt: "2099-06-11T10:10:00.000Z"
    })),
    releaseLock: vi.fn(async () => true),
    ...overrides
  } as ManualChromeJobStore & {
    getScan: ReturnType<typeof vi.fn>;
    acquireLock: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
}

function sessionRecord(): ManualChromeSessionRecord {
  return {
    profileSessionId: "profile-1",
    ownerNonce: "nonce-1",
    serverInstanceId: "boot-1",
    port: 9222,
    profileDir: ".lh-audit/chrome-profile",
    processId: 123,
    startedAt: "2026-06-11T10:00:00.000Z",
    expiresAt: "2099-06-11T10:01:00.000Z"
  };
}

function scanSnapshot(overrides: Partial<ManualChromeScanSnapshot> = {}): ManualChromeScanSnapshot {
  return {
    scanId: "scan-1",
    profileSessionId: "profile-1",
    serverInstanceId: "boot-1",
    expiresAt: "2099-06-11T10:10:00.000Z",
    tabs: [
      {
        id: "target-1",
        title: "Checkout",
        rawUrl: "https://shop.example.com/checkout?otpToken=super-secret",
        displayUrl: "https://shop.example.com/checkout",
        hasHiddenUrlParts: true,
        valid: true,
        redirectHosts: ["shop.example.com"]
      },
      {
        id: "target-2",
        title: "Account",
        rawUrl: "https://shop.example.com/account",
        displayUrl: "https://shop.example.com/account",
        hasHiddenUrlParts: false,
        valid: true,
        redirectHosts: ["shop.example.com"]
      }
    ],
    ...overrides
  };
}

async function baseOptions(extra: Partial<BuildAppOptions> = {}): Promise<BuildAppOptions> {
  const dataDir = await fs.mkdtemp(join(tmpdir(), "lh-manual-chrome-"));
  return {
    encryptionKey,
    downloadTokenSecret: tokenSecret,
    dataDir,
    queue: { add: async () => ({ id: "unused" }), getJobs: async () => [] } as any,
    tokenStore: new Map(),
    logger: false,
    ...extra
  };
}

async function csrfCredentials(app: Awaited<ReturnType<typeof buildApp>>) {
  const csrf = await app.inject({ method: "GET", url: "/csrf-token" });
  const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
  const rawCookie = csrf.headers["set-cookie"];
  const cookie = Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie as string);
  return { csrfToken, cookie };
}

async function postManualChrome(app: Awaited<ReturnType<typeof buildApp>>, url: string) {
  const { csrfToken, cookie } = await csrfCredentials(app);
  return app.inject({
    method: "POST",
    url,
    headers: { host: "localhost:3000", "x-csrf-token": csrfToken, cookie }
  });
}

let nextLoopbackOctet = 2;

function manualPayload(
  overrides: { targetIds?: string[]; evidenceMode?: "none" | "html"; scanId?: string } = {}
): Record<string, unknown> {
  return {
    mode: "manual-tabs",
    formFactors: ["mobile"],
    manualChrome: {
      scanId: overrides.scanId ?? "scan-1",
      targetIds: overrides.targetIds ?? ["target-1"],
      cachePolicy: "preserve-profile",
      evidenceMode: overrides.evidenceMode ?? "none"
    }
  };
}

async function postManualJob(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
  const { csrfToken, cookie } = await csrfCredentials(app);
  const octet = nextLoopbackOctet++;
  return app.inject({
    method: "POST",
    url: "/jobs",
    remoteAddress: `127.0.0.${octet}`,
    headers: { host: "localhost:3000", "x-csrf-token": csrfToken, cookie },
    payload
  });
}

function decryptedExecution(config: any): ManualChromeExecutionData {
  const decrypted = decryptJobConfig(config, encryptionKey) as any;
  return decrypted.manualChrome.execution as ManualChromeExecutionData;
}
