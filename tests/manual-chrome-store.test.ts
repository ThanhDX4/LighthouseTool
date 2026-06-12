import { describe, expect, it } from "vitest";
import { createManualChromeStore } from "../src/manual-chrome/redis-store.js";
import type {
  ManualChromeLockRecord,
  ManualChromeScanSnapshot,
  ManualChromeSessionRecord
} from "../src/manual-chrome/types.js";

describe("manual Chrome Redis store", () => {
  it("replaces boot identity and invalidates the previous session", async () => {
    const redis = new FakeRedis();
    const store = createManualChromeStore(redis as any);
    await store.initializeBoot("boot-old");
    await store.saveSession(session("boot-old"), 60);

    await store.initializeBoot("boot-new");

    expect(await store.getBootId()).toBe("boot-new");
    expect(await store.getSession()).toBeNull();
  });

  it("stores immutable expiring scan snapshots", async () => {
    const redis = new FakeRedis();
    const store = createManualChromeStore(redis as any);
    const snapshot = scanSnapshot();

    await store.saveScan(snapshot, 600);
    snapshot.tabs[0]!.rawUrl = "https://mutated.example";

    expect(await store.getScan("scan-1")).toMatchObject({
      scanId: "scan-1",
      tabs: [{ rawUrl: "https://example.com/account?otp=secret" }]
    });
  });

  it("uses owner token and fencing number for transition, renewal, and release", async () => {
    const redis = new FakeRedis();
    const store = createManualChromeStore(redis as any);
    const first = await store.acquireLock({
      jobId: "job-1",
      profileSessionId: "profile-1",
      ownerToken: "owner-1",
      ttlSeconds: 30
    });

    expect(first?.fencingNumber).toBe(1);
    await expect(
      store.acquireLock({ jobId: "job-2", profileSessionId: "profile-1", ownerToken: "owner-2", ttlSeconds: 30 })
    ).resolves.toBeNull();
    await expect(store.markRunning(first!, 60)).resolves.toMatchObject({ state: "running" });
    await expect(store.renewLock({ ...first!, ownerToken: "stale" }, 60)).resolves.toBe(false);
    await expect(store.releaseLock({ ...first!, fencingNumber: 999 })).resolves.toBe(false);
    await expect(store.renewLock(first!, 60)).resolves.toBe(true);
    await expect(store.releaseLock(first!)).resolves.toBe(true);

    const second = await store.acquireLock({
      jobId: "job-2",
      profileSessionId: "profile-1",
      ownerToken: "owner-2",
      ttlSeconds: 30
    });
    expect(second?.fencingNumber).toBe(2);
    await expect(store.releaseLock(first!)).resolves.toBe(false);
    expect(await store.getLock("profile-1")).toMatchObject({ ownerToken: "owner-2", fencingNumber: 2 });
  });
});

function session(serverInstanceId: string): ManualChromeSessionRecord {
  return {
    profileSessionId: "profile-1",
    ownerNonce: "nonce-1",
    serverInstanceId,
    port: 9222,
    profileDir: ".lh-audit/chrome-profile",
    processId: 123,
    startedAt: "2026-06-11T10:00:00.000Z",
    expiresAt: "2099-06-11T10:01:00.000Z"
  };
}

function scanSnapshot(): ManualChromeScanSnapshot {
  return {
    scanId: "scan-1",
    profileSessionId: "profile-1",
    serverInstanceId: "boot-1",
    expiresAt: "2099-06-11T10:10:00.000Z",
    tabs: [
      {
        id: "target-1",
        title: "Account",
        rawUrl: "https://example.com/account?otp=secret",
        displayUrl: "https://example.com/account",
        hasHiddenUrlParts: true,
        valid: true,
        redirectHosts: ["example.com"]
      }
    ]
  };
}

class FakeRedis {
  private readonly values = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async eval(script: string, _keyCount: number, ...args: string[]) {
    const operation = script.match(/^-- ([A-Z_]+)/)?.[1];
    if (operation === "INITIALIZE_BOOT") {
      this.values.set(args[0]!, args[2]!);
      this.values.delete(args[1]!);
      return 1;
    }
    if (operation === "ACQUIRE_LOCK") {
      const [lockKey, fenceKey, serialized] = args;
      if (this.values.has(lockKey!)) return null;
      const fence = (this.counters.get(fenceKey!) ?? 0) + 1;
      this.counters.set(fenceKey!, fence);
      const record = JSON.parse(serialized!) as ManualChromeLockRecord;
      this.values.set(lockKey!, JSON.stringify({ ...record, fencingNumber: fence }));
      return fence;
    }
    if (operation === "UPDATE_LOCK") {
      const [lockKey, ownerToken, fencingNumber, nextValue] = args;
      const current = this.values.get(lockKey!);
      if (!current) return 0;
      const record = JSON.parse(current) as ManualChromeLockRecord;
      if (record.ownerToken !== ownerToken || record.fencingNumber !== Number(fencingNumber)) return 0;
      this.values.set(lockKey!, nextValue!);
      return 1;
    }
    if (operation === "RELEASE_LOCK") {
      const [lockKey, ownerToken, fencingNumber] = args;
      const current = this.values.get(lockKey!);
      if (!current) return 0;
      const record = JSON.parse(current) as ManualChromeLockRecord;
      if (record.ownerToken !== ownerToken || record.fencingNumber !== Number(fencingNumber)) return 0;
      this.values.delete(lockKey!);
      return 1;
    }
    throw new Error(`Unknown fake Redis operation: ${operation}`);
  }
}
