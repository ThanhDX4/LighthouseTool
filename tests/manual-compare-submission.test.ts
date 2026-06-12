import { describe, expect, it } from "vitest";
import { resolveManualTargets } from "../src/manual-chrome/job-submission.js";
import type { ManualChromeScanSnapshot, ManualChromeSessionRecord } from "../src/manual-chrome/types.js";
import type { ManualCompareSelection } from "../src/types/config.js";

const session: ManualChromeSessionRecord = {
  profileSessionId: "profile-1",
  ownerNonce: "nonce-1",
  serverInstanceId: "boot-1",
  port: 9222,
  profileDir: "/tmp/profile",
  processId: 1234,
  startedAt: "2026-06-12T00:00:00.000Z",
  expiresAt: "2026-06-12T00:45:00.000Z"
};

function scanTab(id: string, rawUrl: string): ManualChromeScanSnapshot["tabs"][number] {
  return {
    id,
    title: id,
    rawUrl,
    displayUrl: rawUrl,
    hasHiddenUrlParts: false,
    valid: true,
    redirectHosts: [new URL(rawUrl).hostname]
  };
}

function snapshotOf(tabs: ManualChromeScanSnapshot["tabs"]): ManualChromeScanSnapshot {
  return {
    scanId: "scan-1",
    profileSessionId: session.profileSessionId,
    serverInstanceId: session.serverInstanceId,
    expiresAt: session.expiresAt,
    tabs
  };
}

const compare: ManualCompareSelection = {
  environments: [
    { name: "Dev 1", anchorTargetId: "t-dev1-checkout" },
    { name: "Dev 3", anchorTargetId: "t-dev3-checkout" }
  ]
};

describe("resolveManualTargets — compare", () => {
  it("attaches environments and shared pathname routes to each target", () => {
    const tabs = [
      scanTab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      scanTab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      scanTab("t-dev1-cart", "https://dev1.example.com/cart"),
      scanTab("t-dev3-cart", "https://dev3.example.com/cart")
    ];

    const resolved = resolveManualTargets({
      snapshot: snapshotOf(tabs),
      session,
      targetIds: tabs.map((t) => t.id),
      allowedHosts: [],
      compare
    });

    if ("code" in resolved) throw new Error(`unexpected error: ${resolved.message}`);

    expect(resolved.environments).toEqual([
      { name: "Dev 1", baseUrl: "https://dev1.example.com" },
      { name: "Dev 3", baseUrl: "https://dev3.example.com" }
    ]);
    expect(resolved.baseUrl).toBe("https://dev1.example.com");
    expect(resolved.warnings).toEqual([]);

    const byTarget = new Map(resolved.targets.map((t) => [t.targetId, t]));
    expect(byTarget.get("t-dev1-checkout")?.route).toBe("/manual-tabs/checkout");
    expect(byTarget.get("t-dev1-checkout")?.environment).toEqual({
      name: "Dev 1",
      baseUrl: "https://dev1.example.com"
    });
    expect(byTarget.get("t-dev3-checkout")?.route).toBe("/manual-tabs/checkout");
    expect(byTarget.get("t-dev3-checkout")?.environment?.name).toBe("Dev 3");
  });

  it("warns about an unbalanced route but still resolves it", () => {
    const tabs = [
      scanTab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      scanTab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      scanTab("t-dev1-only", "https://dev1.example.com/promo")
    ];

    const resolved = resolveManualTargets({
      snapshot: snapshotOf(tabs),
      session,
      targetIds: tabs.map((t) => t.id),
      allowedHosts: [],
      compare
    });

    if ("code" in resolved) throw new Error(`unexpected error: ${resolved.message}`);
    expect(resolved.warnings).toContainEqual({
      reason: "UNBALANCED_ROUTE",
      displayUrl: "https://dev1.example.com/promo",
      detail: "/manual-tabs/promo"
    });
    expect(resolved.targets.some((t) => t.route === "/manual-tabs/promo")).toBe(true);
  });
});
