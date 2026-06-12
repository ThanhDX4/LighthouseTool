import { describe, expect, it } from "vitest";
import {
  buildManualPayload,
  deriveScanState,
  isManualSubmissionValid,
  isScanExpired,
  selectedTabDisplayUrls,
  toggleSelectedTab,
  type ManualScanResponse,
  type ManualScanState,
  type ManualSharedSettings
} from "../web/src/manual-chrome.js";
import type { Category, FormFactor } from "../web/src/job-detail.js";

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function scanResponse(overrides: Partial<ManualScanResponse> = {}): ManualScanResponse {
  return {
    scanId: "scan-1",
    expiresAt: FAR_FUTURE,
    busy: false,
    remoteDebuggingUrl: "http://127.0.0.1:9222",
    totalOpenTabs: 3,
    tabs: [
      { id: "target-1", title: "Dashboard", displayUrl: "https://app.example.com/dashboard", hasHiddenUrlParts: true, valid: true },
      { id: "target-2", title: "Orders", displayUrl: "https://app.example.com/orders", hasHiddenUrlParts: false, valid: true }
    ],
    skipped: [
      { id: "target-3", title: "DevTools", displayUrl: "devtools://...", reason: "Unsupported URL scheme" }
    ],
    ...overrides
  };
}

function sharedSettings(overrides: Partial<ManualSharedSettings> = {}): ManualSharedSettings {
  return {
    displayName: "Manual checkout",
    formFactors: ["desktop"],
    categories: ["performance"],
    runsPerPage: 1,
    throttlingPreset: "slow-4g",
    custom: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
    ...overrides
  };
}

describe("manual chrome web helpers", () => {
  it("derives an immutable scan state with no tabs selected", () => {
    const state = deriveScanState(scanResponse());
    expect(state.scanId).toBe("scan-1");
    expect(state.tabs).toHaveLength(2);
    expect(state.skipped).toHaveLength(1);
    expect(state.selectedIds).toEqual([]);
  });

  it("toggles a valid tab without mutating the previous state", () => {
    const state = deriveScanState(scanResponse());
    const selected = toggleSelectedTab(state, "target-1");
    expect(selected.selectedIds).toEqual(["target-1"]);
    expect(state.selectedIds).toEqual([]);

    const deselected = toggleSelectedTab(selected, "target-1");
    expect(deselected.selectedIds).toEqual([]);
  });

  it("ignores toggles for unknown / skipped tab ids", () => {
    const state = deriveScanState(scanResponse());
    expect(toggleSelectedTab(state, "target-3").selectedIds).toEqual([]);
    expect(toggleSelectedTab(state, "missing").selectedIds).toEqual([]);
  });

  it("detects expired scans", () => {
    expect(isScanExpired(deriveScanState(scanResponse({ expiresAt: PAST })))).toBe(true);
    expect(isScanExpired(deriveScanState(scanResponse({ expiresAt: FAR_FUTURE })))).toBe(false);
  });

  it("disables submission when no tab is selected", () => {
    const scan = deriveScanState(scanResponse());
    expect(
      isManualSubmissionValid({
        scan,
        evidenceMode: "none",
        evidenceConsent: false,
        formFactors: ["desktop"],
        categories: ["performance"],
        runsPerPage: 1
      })
    ).toBe(false);
  });

  it("disables submission when the scan has expired", () => {
    const scan = toggleSelectedTab(deriveScanState(scanResponse({ expiresAt: PAST })), "target-1");
    expect(
      isManualSubmissionValid({
        scan,
        evidenceMode: "none",
        evidenceConsent: false,
        formFactors: ["desktop"],
        categories: ["performance"],
        runsPerPage: 1
      })
    ).toBe(false);
  });

  it("requires explicit consent when html evidence is selected", () => {
    const scan = toggleSelectedTab(deriveScanState(scanResponse()), "target-1");
    const base = {
      scan,
      formFactors: ["desktop"] as FormFactor[],
      categories: ["performance"] as Category[],
      runsPerPage: 1
    };
    expect(isManualSubmissionValid({ ...base, evidenceMode: "html", evidenceConsent: false })).toBe(false);
    expect(isManualSubmissionValid({ ...base, evidenceMode: "html", evidenceConsent: true })).toBe(true);
    expect(isManualSubmissionValid({ ...base, evidenceMode: "none", evidenceConsent: false })).toBe(true);
  });

  it("builds a payload containing mode, scanId, selected ids, and no base url / auth fields", () => {
    let scan = deriveScanState(scanResponse());
    scan = toggleSelectedTab(scan, "target-2");
    scan = toggleSelectedTab(scan, "target-1");

    const payload = buildManualPayload({ scan, settings: sharedSettings(), evidenceMode: "html" });

    expect(payload.mode).toBe("manual-tabs");
    expect(payload.manualChrome.scanId).toBe("scan-1");
    // Order follows the scan's tab order, not selection order.
    expect(payload.manualChrome.targetIds).toEqual(["target-1", "target-2"]);
    expect(payload.manualChrome.cachePolicy).toBe("preserve-profile");
    expect(payload.manualChrome.evidenceMode).toBe("html");

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("basicAuth");
    expect(serialized).not.toContain("formLogin");
  });

  it("omits custom throttling unless the custom preset is selected", () => {
    const scan = toggleSelectedTab(deriveScanState(scanResponse()), "target-1");
    const preset = buildManualPayload({ scan, settings: sharedSettings(), evidenceMode: "none" });
    expect(preset.throttling.custom).toBeUndefined();

    const custom = buildManualPayload({
      scan,
      settings: sharedSettings({ throttlingPreset: "custom" }),
      evidenceMode: "none"
    });
    expect(custom.throttling.custom).toMatchObject({ cpuSlowdownMultiplier: 4 });
  });

  it("returns sanitized display urls for the selected tabs only", () => {
    const scan = toggleSelectedTab(deriveScanState(scanResponse()), "target-2");
    expect(selectedTabDisplayUrls(scan)).toEqual(["https://app.example.com/orders"]);
  });
});
