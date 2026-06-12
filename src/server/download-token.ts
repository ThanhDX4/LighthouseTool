import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

interface TokenStore {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown> | unknown;
}

export interface DownloadTokenServiceOptions {
  secret: string;
  store: TokenStore | Map<string, unknown>;
  ttlSeconds?: number;
}

export interface DownloadTokenClaims {
  jobId: string;
}

export function createDownloadTokenService(options: DownloadTokenServiceOptions) {
  const key = parseSecret(options.secret);
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const store = normalizeStore(options.store);
  const verify = async (jobId: string, token: string): Promise<DownloadTokenClaims> => {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.jobId !== jobId) {
      throw new Error("Download token job mismatch");
    }
    return { jobId };
  };

  return {
    async issue(jobId: string): Promise<string> {
      return new SignJWT({ jobId })
        .setProtectedHeader({ alg: "HS256" })
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key);
    },

    verify,

    async consume(jobId: string, token: string): Promise<DownloadTokenClaims> {
      const claims = await verify(jobId, token);
      const hash = hashToken(token);
      const consumedKey = `download-token:used:${hash}`;
      const alreadyUsed = await store.get(consumedKey);
      if (alreadyUsed) {
        throw new Error("Download token already used");
      }
      await store.set(consumedKey, "1", ttlSeconds);
      return claims;
    }
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseSecret(secret: string): Uint8Array {
  const candidates = [
    Buffer.from(secret, "base64"),
    Buffer.from(secret, "hex"),
    Buffer.from(secret, "utf8")
  ];
  const key = candidates.find((candidate) => candidate.length >= 32);
  if (!key) {
    throw new Error("DOWNLOAD_TOKEN_SECRET must decode to at least 32 bytes");
  }
  return key;
}

function normalizeStore(store: TokenStore | Map<string, unknown>): TokenStore {
  if (store instanceof Map) {
    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: string) => {
        store.set(key, value);
      }
    };
  }
  return store;
}
