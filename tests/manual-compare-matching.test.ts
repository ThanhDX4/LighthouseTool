import { describe, expect, it } from "vitest";
import {
  matchTabsToEnvironments,
  type CompareAnchor,
  type CompareTabInput
} from "../src/manual-chrome/compare-matching.js";

function tab(targetId: string, rawUrl: string): CompareTabInput {
  return { targetId, rawUrl, displayUrl: rawUrl };
}

const anchors: readonly [CompareAnchor, CompareAnchor] = [
  { name: "Dev 1", anchorTargetId: "t-dev1-checkout" },
  { name: "Dev 3", anchorTargetId: "t-dev3-checkout" }
];

describe("matchTabsToEnvironments", () => {
  it("derives two environments and pairs routes by pathname across subdomains", () => {
    const tabs = [
      tab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      tab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      tab("t-dev1-cart", "https://dev1.example.com/cart?step=2"),
      tab("t-dev3-cart", "https://dev3.example.com/cart")
    ];

    const result = matchTabsToEnvironments(tabs, anchors);

    expect(result.environments).toEqual([
      { name: "Dev 1", baseUrl: "https://dev1.example.com" },
      { name: "Dev 3", baseUrl: "https://dev3.example.com" }
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.assignments).toEqual([
      { targetId: "t-dev1-checkout", envName: "Dev 1", route: "/checkout" },
      { targetId: "t-dev3-checkout", envName: "Dev 3", route: "/checkout" },
      { targetId: "t-dev1-cart", envName: "Dev 1", route: "/cart" },
      { targetId: "t-dev3-cart", envName: "Dev 3", route: "/cart" }
    ]);
  });

  it("warns and excludes a tab whose host matches neither anchor", () => {
    const tabs = [
      tab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      tab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      tab("t-stray", "https://staging.other.com/checkout")
    ];

    const result = matchTabsToEnvironments(tabs, anchors);

    expect(result.assignments.map((a) => a.targetId)).toEqual([
      "t-dev1-checkout",
      "t-dev3-checkout"
    ]);
    expect(result.warnings).toEqual([
      { reason: "UNMATCHED_HOST", displayUrl: "https://staging.other.com/checkout" }
    ]);
  });

  it("warns about an unbalanced route but still keeps it for N/A rendering", () => {
    const tabs = [
      tab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      tab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      tab("t-dev1-only", "https://dev1.example.com/promo")
    ];

    const result = matchTabsToEnvironments(tabs, anchors);

    expect(result.assignments).toContainEqual({
      targetId: "t-dev1-only",
      envName: "Dev 1",
      route: "/promo"
    });
    expect(result.warnings).toContainEqual({
      reason: "UNBALANCED_ROUTE",
      displayUrl: "https://dev1.example.com/promo",
      detail: "/promo"
    });
  });

  it("keeps the first occurrence and warns on a duplicate pathname within one environment", () => {
    const tabs = [
      tab("t-dev1-checkout", "https://dev1.example.com/checkout"),
      tab("t-dev3-checkout", "https://dev3.example.com/checkout"),
      tab("t-dev1-checkout-dup", "https://dev1.example.com/checkout?ref=x")
    ];

    const result = matchTabsToEnvironments(tabs, anchors);

    const dev1Checkout = result.assignments.filter(
      (a) => a.envName === "Dev 1" && a.route === "/checkout"
    );
    expect(dev1Checkout).toHaveLength(1);
    expect(dev1Checkout[0]!.targetId).toBe("t-dev1-checkout");
    expect(result.warnings).toContainEqual({
      reason: "DUPLICATE_PATHNAME",
      displayUrl: "https://dev1.example.com/checkout?ref=x",
      detail: "/checkout"
    });
  });

  it("throws when both anchors resolve to the same host", () => {
    const tabs = [
      tab("t-a", "https://dev1.example.com/checkout"),
      tab("t-b", "https://dev1.example.com/cart")
    ];
    const sameHostAnchors: readonly [CompareAnchor, CompareAnchor] = [
      { name: "Dev 1", anchorTargetId: "t-a" },
      { name: "Dev 1 again", anchorTargetId: "t-b" }
    ];

    expect(() => matchTabsToEnvironments(tabs, sameHostAnchors)).toThrow(/distinct host/i);
  });

  it("throws when an anchor target id is not among the selected tabs", () => {
    const tabs = [tab("t-dev1-checkout", "https://dev1.example.com/checkout")];

    expect(() => matchTabsToEnvironments(tabs, anchors)).toThrow(/anchor/i);
  });
});
