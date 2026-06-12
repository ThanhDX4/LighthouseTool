import { describe, expect, it } from "vitest";
import {
  buildManualPayload,
  isManualCompareValid,
  previewCompareMatch,
  type ManualCompareInput,
  type ManualScanState,
  type ManualScanTab,
  type ManualSharedSettings
} from "../web/src/manual-chrome.js";

function tab(id: string, displayUrl: string): ManualScanTab {
  return { id, title: id, displayUrl, hasHiddenUrlParts: false, valid: true };
}

const tabs: ManualScanTab[] = [
  tab("t1", "https://dev1.example.com/checkout"),
  tab("t2", "https://dev3.example.com/checkout"),
  tab("t3", "https://dev1.example.com/cart"),
  tab("t4", "https://dev3.example.com/cart")
];

function scanState(selectedIds: string[]): ManualScanState {
  return {
    scanId: "scan-1",
    expiresAt: "2999-01-01T00:00:00.000Z",
    totalOpenTabs: tabs.length,
    tabs,
    skipped: [],
    selectedIds
  };
}

const settings: ManualSharedSettings = {
  displayName: "Compare run",
  formFactors: ["desktop"],
  categories: ["performance"],
  runsPerPage: 1,
  throttlingPreset: "slow-4g",
  custom: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }
};

const compare: ManualCompareInput = {
  enabled: true,
  environments: [
    { name: "Dev 1", anchorTargetId: "t1" },
    { name: "Dev 3", anchorTargetId: "t2" }
  ]
};

describe("buildManualPayload — compare", () => {
  it("attaches a compare field when compare mode is enabled and valid", () => {
    const payload = buildManualPayload({
      scan: scanState(["t1", "t2", "t3", "t4"]),
      settings,
      evidenceMode: "none",
      compare
    });

    expect(payload.manualChrome.compare).toEqual({
      environments: [
        { name: "Dev 1", anchorTargetId: "t1" },
        { name: "Dev 3", anchorTargetId: "t2" }
      ]
    });
  });

  it("omits the compare field when compare mode is disabled", () => {
    const payload = buildManualPayload({
      scan: scanState(["t1", "t2"]),
      settings,
      evidenceMode: "none",
      compare: { ...compare, enabled: false }
    });

    expect(payload.manualChrome.compare).toBeUndefined();
  });

  it("omits the compare field when no compare input is provided", () => {
    const payload = buildManualPayload({
      scan: scanState(["t1", "t2"]),
      settings,
      evidenceMode: "none"
    });

    expect(payload.manualChrome.compare).toBeUndefined();
  });
});

describe("isManualCompareValid", () => {
  it("is valid with two named anchors on distinct hosts", () => {
    expect(isManualCompareValid(tabs, compare)).toBe(true);
  });

  it("is invalid when both anchors resolve to the same host", () => {
    expect(
      isManualCompareValid(tabs, {
        enabled: true,
        environments: [
          { name: "Dev 1", anchorTargetId: "t1" },
          { name: "Dev 1 again", anchorTargetId: "t3" }
        ]
      })
    ).toBe(false);
  });

  it("is invalid when a name is empty or an anchor is unset", () => {
    expect(
      isManualCompareValid(tabs, {
        enabled: true,
        environments: [
          { name: "", anchorTargetId: "t1" },
          { name: "Dev 3", anchorTargetId: "t2" }
        ]
      })
    ).toBe(false);
    expect(
      isManualCompareValid(tabs, {
        enabled: true,
        environments: [
          { name: "Dev 1", anchorTargetId: "t1" },
          { name: "Dev 3", anchorTargetId: "" }
        ]
      })
    ).toBe(false);
  });
});

describe("previewCompareMatch", () => {
  it("groups selected tabs into environments by host and routes by pathname", () => {
    const preview = previewCompareMatch(tabs, ["t1", "t2", "t3", "t4"], compare.environments);

    expect(preview.environments).toEqual([
      { name: "Dev 1", host: "dev1.example.com", routes: ["/manual-tabs/checkout", "/manual-tabs/cart"] },
      { name: "Dev 3", host: "dev3.example.com", routes: ["/manual-tabs/checkout", "/manual-tabs/cart"] }
    ]);
    expect(preview.warnings).toEqual([]);
  });

  it("warns about an unbalanced route present in only one environment", () => {
    const withExtra = [...tabs, tab("t5", "https://dev1.example.com/promo")];
    const preview = previewCompareMatch(withExtra, ["t1", "t2", "t5"], compare.environments);

    expect(preview.warnings).toContainEqual({
      reason: "UNBALANCED_ROUTE",
      displayUrl: "https://dev1.example.com/promo",
      detail: "/manual-tabs/promo"
    });
  });

  it("warns about a tab whose host matches neither anchor", () => {
    const withStray = [...tabs, tab("t6", "https://staging.other.com/checkout")];
    const preview = previewCompareMatch(withStray, ["t1", "t2", "t6"], compare.environments);

    expect(preview.warnings).toContainEqual({
      reason: "UNMATCHED_HOST",
      displayUrl: "https://staging.other.com/checkout"
    });
  });
});
