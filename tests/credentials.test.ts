import { describe, expect, it } from "vitest";
import { decryptJobConfig, encryptJobConfig, isEncryptedSecret } from "../src/security/credentials.js";
import { parseAuditRequest } from "../src/config/audit-config.js";
import { redactAuditConfig } from "../src/config/safe-audit-config.js";
import type { AuditConfig } from "../src/types/config.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("credential encryption", () => {
  it("encrypts only credential fields, decrypts them back, and never mutates the input", () => {
    const original = parseAuditRequest({
      baseUrl: "https://example.com",
      paths: ["/"],
      formFactors: ["mobile"],
      basicAuth: { enabled: true, username: "stage", password: "secret-basic" },
      formLogin: {
        enabled: true,
        loginUrl: "https://example.com/login",
        username: "demo@example.com",
        password: "secret-form"
      }
    });

    const encrypted = encryptJobConfig(original, key);

    expect(original.basicAuth.password).toBe("secret-basic");
    expect(original.formLogin.password).toBe("secret-form");
    expect(isEncryptedSecret(encrypted.basicAuth.password)).toBe(true);
    expect(isEncryptedSecret(encrypted.formLogin.password)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain("secret-basic");
    expect(JSON.stringify(encrypted)).not.toContain("secret-form");

    const decrypted = decryptJobConfig(encrypted, key);
    expect(decrypted.basicAuth.password).toBe("secret-basic");
    expect(decrypted.formLogin.password).toBe("secret-form");
  });

  it("encrypts raw manual target URLs and decrypts them without mutating the input", () => {
    const original: AuditConfig = {
      mode: "manual-tabs",
      baseUrl: "https://example.com",
      displayName: "Authenticated checkout",
      paths: ["/01-checkout"],
      formFactors: ["desktop"],
      categories: ["performance"],
      runsPerPage: 1,
      throttling: { preset: "slow-4g" },
      basicAuth: { enabled: false },
      formLogin: {
        enabled: false,
        usernameSelector: 'input[name="LOGIN_EMAIL"]',
        passwordSelector: 'input[name="PASSWORD"]',
        submitSelector: 'button[type="submit"]',
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      },
      manualChrome: {
        cachePolicy: "preserve-profile",
        evidenceMode: "none",
        execution: {
          profileSessionId: "profile_123",
          ownerToken: "owner-token",
          fencingNumber: 4,
          targets: [
            {
              targetId: "target-1",
              profileSessionId: "profile_123",
              ownerNonce: "nonce-123",
              serverInstanceId: "instance-123",
              auditUrl: "https://example.com/checkout?otpToken=secret#confirm",
              displayUrl: "https://example.com/checkout",
              route: "/01-checkout",
              selectedAt: "2026-06-11T10:00:00.000Z"
            }
          ]
        }
      }
    };

    const encrypted = encryptJobConfig(original, key);

    expect((original.manualChrome.execution as any).targets[0]?.auditUrl).toContain("otpToken=secret");
    expect(isEncryptedSecret(encrypted.manualChrome!.execution)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain("otpToken=secret");
    expect(JSON.stringify(encrypted)).not.toContain("owner-token");
    expect(JSON.stringify(encrypted)).not.toContain("nonce-123");

    const decrypted = decryptJobConfig(encrypted, key);
    expect((decrypted.manualChrome!.execution as any).targets[0]?.auditUrl).toBe(
      "https://example.com/checkout?otpToken=secret#confirm"
    );

    const safe = redactAuditConfig(original);
    expect(safe).toMatchObject({
      mode: "manual-tabs",
      manualChrome: {
        cachePolicy: "preserve-profile",
        evidenceMode: "none",
        targets: [
          {
            displayUrl: "https://example.com/checkout",
            route: "/01-checkout"
          }
        ]
      }
    });
    expect(JSON.stringify(safe)).not.toContain("otpToken=secret");
    expect(JSON.stringify(safe)).not.toContain("owner-token");
    expect(JSON.stringify(safe)).not.toContain("nonce-123");
  });
});
