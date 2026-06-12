import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config/env.js";

describe("manual Chrome runtime config", () => {
  it("keeps manual Chrome disabled with safe defaults", () => {
    const config = loadRuntimeConfig({ NODE_ENV: "test" });

    expect(config.manualChrome).toEqual({
      enabled: false,
      autoOpen: true,
      port: 9222,
      profileDir: ".lh-audit/chrome-profile",
      startupTimeoutMs: 15_000,
      maxTabs: 20,
      maxEvidenceFiles: 100,
      maxEvidenceBytes: 50 * 1024 * 1024
    });
  });

  it("loads an enabled local manual Chrome configuration", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "test",
      MANUAL_CHROME_ENABLED: "true",
      MANUAL_CHROME_PORT: "9333",
      MANUAL_CHROME_PROFILE_DIR: "/tmp/perf-profile",
      MANUAL_CHROME_STARTUP_TIMEOUT_MS: "20000",
      MANUAL_CHROME_MAX_TABS: "12",
      MANUAL_CHROME_MAX_EVIDENCE_FILES: "24",
      MANUAL_CHROME_MAX_EVIDENCE_BYTES: "1048576",
      ALLOWED_HOSTS: "example.com, auth.example.com"
    });

    expect(config.allowedHosts).toEqual(["example.com", "auth.example.com"]);
    expect(config.manualChrome).toEqual({
      enabled: true,
      autoOpen: true,
      port: 9333,
      profileDir: "/tmp/perf-profile",
      startupTimeoutMs: 20_000,
      maxTabs: 12,
      maxEvidenceFiles: 24,
      maxEvidenceBytes: 1_048_576
    });
  });

  it("always auto-opens manual Chrome when the feature is enabled", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "test",
      MANUAL_CHROME_ENABLED: "true",
      MANUAL_CHROME_AUTO_OPEN: "false",
      ALLOWED_HOSTS: "example.com"
    });

    expect(config.manualChrome.enabled).toBe(true);
    expect(config.manualChrome.autoOpen).toBe(true);
  });

  it("allows enabled manual mode without an ALLOWED_HOSTS allow-list (open to any host)", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "test",
      MANUAL_CHROME_ENABLED: "true"
    });

    expect(config.manualChrome.enabled).toBe(true);
    expect(config.allowedHosts).toEqual([]);
  });

  it("rejects invalid manual Chrome numeric limits", () => {
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: "test",
        MANUAL_CHROME_MAX_TABS: "0"
      })
    ).toThrow(/MANUAL_CHROME_MAX_TABS/);
  });
});
