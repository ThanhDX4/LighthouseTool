import { describe, expect, it } from "vitest";
import {
  areRedirectHostsAllowed,
  assertAllowedManualUrl,
  evaluateManualRequestAccess,
  sanitizeDisplayUrl,
  sanitizeManualErrorMessage
} from "../src/manual-chrome/access-control.js";

describe("manual Chrome access control", () => {
  it("accepts loopback socket, Host, and matching Origin while ignoring forwarded headers", () => {
    expect(
      evaluateManualRequestAccess({
        remoteAddress: "::ffff:127.0.0.1",
        host: "localhost:5173",
        origin: "http://localhost:5173",
        forwardedFor: "203.0.113.20",
        forwardedHost: "public.example.com"
      })
    ).toEqual({ allowed: true });
  });

  it("rejects LAN sockets, public hosts, and mismatched loopback origins", () => {
    expect(evaluateManualRequestAccess({ remoteAddress: "192.168.1.20", host: "localhost:3000" })).toMatchObject({
      allowed: false,
      code: "MANUAL_CHROME_FORBIDDEN"
    });
    expect(evaluateManualRequestAccess({ remoteAddress: "127.0.0.1", host: "tool.example.com" }).allowed).toBe(false);
    expect(
      evaluateManualRequestAccess({
        remoteAddress: "127.0.0.1",
        host: "localhost:3000",
        origin: "http://localhost:5173"
      }).allowed
    ).toBe(false);
  });

  it("strips credentials, query strings, and fragments from display URLs", () => {
    expect(sanitizeDisplayUrl("https://user:secret@example.com/account/orders?otp=secret#step")).toEqual({
      displayUrl: "https://example.com/account/orders",
      hasHiddenUrlParts: true
    });
  });

  it("accepts any HTTP(S) host and rejects only non-http(s) schemes", () => {
    expect(assertAllowedManualUrl("https://example.com/account?otp=secret", ["example.com"]).hostname).toBe(
      "example.com"
    );
    // Allowlist parameter is ignored — every reachable host passes.
    expect(assertAllowedManualUrl("https://evil.example/account", ["example.com"]).hostname).toBe("evil.example");
    expect(assertAllowedManualUrl("https://terms/accept", []).hostname).toBe("terms");
    expect(() => assertAllowedManualUrl("chrome://settings")).toThrow(/Unsupported URL scheme/);
    expect(() => assertAllowedManualUrl("javascript:void(0)")).toThrow(/Unsupported URL scheme/);
    expect(() => assertAllowedManualUrl("not-a-url")).toThrow(/Invalid tab URL/);
    // Redirect-chain enforcement is gone — every list is allowed.
    expect(areRedirectHostsAllowed(["terms", "evil.example"], ["example.com"])).toBe(true);
  });

  it("sanitizes URLs embedded in errors before they reach progress or diagnostics", () => {
    expect(
      sanitizeManualErrorMessage(
        "Navigation failed at https://example.com/reset?token=secret#confirm and https://evil.example/path?q=x"
      )
    ).toBe("Navigation failed at https://example.com/reset and https://evil.example/path");
  });
});
