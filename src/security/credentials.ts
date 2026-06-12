import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  AuditConfig,
  ManualChromeExecutionData,
  SecretEnvelope,
  SecretValue
} from "../types/config.js";

export function encryptJobConfig(config: AuditConfig, encodedKey: string): AuditConfig {
  const key = parseEncryptionKey(encodedKey);
  const encrypted = {
    ...config,
    basicAuth: {
      ...config.basicAuth,
      password:
        config.basicAuth.enabled && typeof config.basicAuth.password === "string"
          ? encryptSecret(config.basicAuth.password, key)
          : config.basicAuth.password
    },
    formLogin: {
      ...config.formLogin,
      password:
        config.formLogin.enabled && typeof config.formLogin.password === "string"
          ? encryptSecret(config.formLogin.password, key)
          : config.formLogin.password
    },
    manualChrome: config.manualChrome
      ? {
          cachePolicy: config.manualChrome.cachePolicy,
          evidenceMode: config.manualChrome.evidenceMode,
          execution: isEncryptedSecret(config.manualChrome.execution)
            ? config.manualChrome.execution
            : encryptSecret(JSON.stringify(config.manualChrome.execution), key)
        }
      : undefined
  };
  return encrypted as AuditConfig;
}

export function decryptJobConfig(config: AuditConfig, encodedKey: string): AuditConfig {
  const key = parseEncryptionKey(encodedKey);
  const decrypted = {
    ...config,
    basicAuth: {
      ...config.basicAuth,
      password: isEncryptedSecret(config.basicAuth.password) ? decryptSecret(config.basicAuth.password, key) : config.basicAuth.password
    },
    formLogin: {
      ...config.formLogin,
      password: isEncryptedSecret(config.formLogin.password) ? decryptSecret(config.formLogin.password, key) : config.formLogin.password
    },
    manualChrome: config.manualChrome
      ? {
          cachePolicy: config.manualChrome.cachePolicy,
          evidenceMode: config.manualChrome.evidenceMode,
          execution: isEncryptedSecret(config.manualChrome.execution)
            ? parseManualExecution(decryptSecret(config.manualChrome.execution, key))
            : cloneManualExecution(config.manualChrome.execution)
        }
      : undefined
  };
  return decrypted as AuditConfig;
}

export function isEncryptedSecret(value: unknown): value is SecretEnvelope {
  const candidate = value as Record<string, unknown> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.alg === "aes-256-gcm" &&
    typeof candidate.ciphertext === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string"
  );
}

function encryptSecret(plaintext: string, key: Buffer): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptSecret(secret: SecretEnvelope, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function parseManualExecution(value: string): ManualChromeExecutionData {
  const parsed = JSON.parse(value) as ManualChromeExecutionData;
  return cloneManualExecution(parsed);
}

function cloneManualExecution(value: ManualChromeExecutionData): ManualChromeExecutionData {
  return {
    profileSessionId: value.profileSessionId,
    ownerToken: value.ownerToken,
    fencingNumber: value.fencingNumber,
    targets: value.targets.map((target) => ({ ...target }))
  };
}

function parseEncryptionKey(encodedKey: string): Buffer {
  const candidates = [
    Buffer.from(encodedKey, "base64"),
    Buffer.from(encodedKey, "hex"),
    Buffer.from(encodedKey, "utf8")
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM");
  }
  return key;
}
