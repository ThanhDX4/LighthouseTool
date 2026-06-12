import type { ManualChromeLockIdentity, ManualChromeLockRecord, ManualChromeScanSnapshot, ManualChromeSessionRecord } from "./types.js";

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const keys = {
  boot: "manual-chrome:boot",
  session: "manual-chrome:session",
  scan: (scanId: string) => `manual-chrome:scan:${scanId}`,
  lock: (profileSessionId: string) => `manual-chrome:lock:${profileSessionId}`,
  fence: (profileSessionId: string) => `manual-chrome:fence:${profileSessionId}`
};

const initializeBootScript = `-- INITIALIZE_BOOT
redis.call("SET", ARGV[1], ARGV[3])
redis.call("DEL", ARGV[2])
return 1`;

const acquireLockScript = `-- ACQUIRE_LOCK
if redis.call("EXISTS", ARGV[1]) == 1 then return nil end
local fence = redis.call("INCR", ARGV[2])
local record = cjson.decode(ARGV[3])
record.fencingNumber = fence
redis.call("SET", ARGV[1], cjson.encode(record), "EX", ARGV[4])
return fence`;

const updateLockScript = `-- UPDATE_LOCK
local current = redis.call("GET", ARGV[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.ownerToken ~= ARGV[2] or tonumber(record.fencingNumber) ~= tonumber(ARGV[3]) then return 0 end
redis.call("SET", ARGV[1], ARGV[4], "EX", ARGV[5])
return 1`;

const releaseLockScript = `-- RELEASE_LOCK
local current = redis.call("GET", ARGV[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.ownerToken ~= ARGV[2] or tonumber(record.fencingNumber) ~= tonumber(ARGV[3]) then return 0 end
redis.call("DEL", ARGV[1])
return 1`;

export function createManualChromeStore(redis: RedisLike) {
  return {
    async initializeBoot(serverInstanceId: string): Promise<void> {
      await redis.eval(initializeBootScript, 0, keys.boot, keys.session, serverInstanceId);
    },

    getBootId(): Promise<string | null> {
      return redis.get(keys.boot);
    },

    async saveSession(record: ManualChromeSessionRecord, ttlSeconds: number): Promise<void> {
      await redis.set(keys.session, JSON.stringify(record), "EX", ttlSeconds);
    },

    async getSession(): Promise<ManualChromeSessionRecord | null> {
      return readRecord(redis, keys.session, isSessionRecord);
    },

    async saveScan(snapshot: ManualChromeScanSnapshot, ttlSeconds: number): Promise<void> {
      await redis.set(keys.scan(snapshot.scanId), JSON.stringify(cloneScan(snapshot)), "EX", ttlSeconds);
    },

    async getScan(scanId: string): Promise<ManualChromeScanSnapshot | null> {
      const record = await readRecord(redis, keys.scan(scanId), isScanSnapshot);
      return record ? cloneScan(record) : null;
    },

    async acquireLock(input: {
      jobId: string;
      profileSessionId: string;
      ownerToken: string;
      ttlSeconds: number;
    }): Promise<ManualChromeLockRecord | null> {
      const record: ManualChromeLockRecord = {
        jobId: input.jobId,
        profileSessionId: input.profileSessionId,
        ownerToken: input.ownerToken,
        fencingNumber: 0,
        state: "queued",
        expiresAt: expiresAt(input.ttlSeconds)
      };
      const result = await redis.eval(
        acquireLockScript,
        0,
        keys.lock(input.profileSessionId),
        keys.fence(input.profileSessionId),
        JSON.stringify(record),
        String(input.ttlSeconds)
      );
      if (typeof result !== "number") return null;
      return { ...record, fencingNumber: result };
    },

    async getLock(profileSessionId: string): Promise<ManualChromeLockRecord | null> {
      return readRecord(redis, keys.lock(profileSessionId), isLockRecord);
    },

    async markRunning(identity: ManualChromeLockIdentity, ttlSeconds: number): Promise<ManualChromeLockRecord | null> {
      const current = await this.getLock(identity.profileSessionId);
      if (!matchesLock(current, identity)) return null;
      const next = { ...current, state: "running" as const, expiresAt: expiresAt(ttlSeconds) };
      const updated = await updateLock(redis, next, ttlSeconds);
      return updated ? next : null;
    },

    async renewLock(identity: ManualChromeLockIdentity, ttlSeconds: number): Promise<boolean> {
      const current = await this.getLock(identity.profileSessionId);
      if (!matchesLock(current, identity)) return false;
      return updateLock(redis, { ...current, expiresAt: expiresAt(ttlSeconds) }, ttlSeconds);
    },

    async releaseLock(identity: ManualChromeLockIdentity): Promise<boolean> {
      const result = await redis.eval(
        releaseLockScript,
        0,
        keys.lock(identity.profileSessionId),
        identity.ownerToken,
        String(identity.fencingNumber)
      );
      return result === 1;
    }
  };
}

async function updateLock(redis: RedisLike, record: ManualChromeLockRecord, ttlSeconds: number): Promise<boolean> {
  const result = await redis.eval(
    updateLockScript,
    0,
    keys.lock(record.profileSessionId),
    record.ownerToken,
    String(record.fencingNumber),
    JSON.stringify(record),
    String(ttlSeconds)
  );
  return result === 1;
}

async function readRecord<T>(redis: RedisLike, key: string, validate: (value: unknown) => value is T): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validate(parsed)) return null;
    if (hasExpired(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cloneScan(snapshot: ManualChromeScanSnapshot): ManualChromeScanSnapshot {
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => ({ ...tab, redirectHosts: [...tab.redirectHosts] }))
  };
}

function matchesLock(record: ManualChromeLockRecord | null, identity: ManualChromeLockIdentity): record is ManualChromeLockRecord {
  return Boolean(
    record && record.ownerToken === identity.ownerToken && record.fencingNumber === identity.fencingNumber
  );
}

function hasExpired(value: unknown): boolean {
  if (!isRecord(value) || typeof value.expiresAt !== "string") return false;
  return Date.parse(value.expiresAt) <= Date.now();
}

function isSessionRecord(value: unknown): value is ManualChromeSessionRecord {
  return isRecord(value) && typeof value.profileSessionId === "string" && typeof value.serverInstanceId === "string";
}

function isScanSnapshot(value: unknown): value is ManualChromeScanSnapshot {
  return isRecord(value) && typeof value.scanId === "string" && Array.isArray(value.tabs);
}

function isLockRecord(value: unknown): value is ManualChromeLockRecord {
  return isRecord(value) && typeof value.ownerToken === "string" && typeof value.fencingNumber === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expiresAt(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}
