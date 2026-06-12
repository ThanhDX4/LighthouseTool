import { describe, expect, it } from "vitest";
import { parseAuditRequest, parsePathText } from "../src/config/audit-config.js";

describe("audit config validation", () => {
  it("normalizes a minimal valid audit request without leaking credential defaults", () => {
    const parsed = parseAuditRequest({
      baseUrl: "https://example.com/",
      paths: ["/", "/products"],
      formFactors: ["mobile", "desktop"]
    });

    expect(parsed).toMatchObject({
      mode: "static",
      baseUrl: "https://example.com",
      displayName: "example.com",
      paths: ["/", "/products"],
      formFactors: ["mobile", "desktop"],
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runsPerPage: 1,
      throttling: { preset: "slow-4g" },
      basicAuth: { enabled: false },
      formLogin: { enabled: false }
    });
  });

  it("parses a manual-tabs request without accepting static URL or credential authority", () => {
    const parsed = parseAuditRequest({
      mode: "manual-tabs",
      displayName: "Authenticated checkout",
      formFactors: ["desktop", "desktop"],
      categories: ["performance", "seo"],
      runsPerPage: 2,
      throttling: { preset: "slow-4g" },
      manualChrome: {
        scanId: " scan_123 ",
        targetIds: ["target-1", "target-1", "target-2"],
        cachePolicy: "preserve-profile",
        evidenceMode: "none"
      }
    });

    expect(parsed).toEqual({
      mode: "manual-tabs",
      displayName: "Authenticated checkout",
      formFactors: ["desktop"],
      categories: ["performance", "seo"],
      runsPerPage: 2,
      throttling: { preset: "slow-4g" },
      manualChrome: {
        scanId: "scan_123",
        targetIds: ["target-1", "target-2"],
        cachePolicy: "preserve-profile",
        evidenceMode: "none"
      }
    });
  });

  it("rejects incomplete manual-tabs requests and static-only fields", () => {
    expect(() =>
      parseAuditRequest({
        mode: "manual-tabs",
        formFactors: ["desktop"],
        manualChrome: {
          scanId: "scan_123",
          targetIds: [],
          cachePolicy: "preserve-profile",
          evidenceMode: "none"
        }
      })
    ).toThrow(/selected tab/i);

    expect(() =>
      parseAuditRequest({
        mode: "manual-tabs",
        baseUrl: "https://example.com",
        formFactors: ["desktop"],
        manualChrome: {
          scanId: "scan_123",
          targetIds: ["target-1"],
          cachePolicy: "preserve-profile",
          evidenceMode: "none"
        }
      })
    ).toThrow(/baseUrl/i);

    expect(() =>
      parseAuditRequest({
        mode: "manual-tabs",
        formFactors: ["desktop"],
        basicAuth: { enabled: true, username: "stage", password: "secret" },
        manualChrome: {
          scanId: "scan_123",
          targetIds: ["target-1"],
          cachePolicy: "preserve-profile",
          evidenceMode: "none"
        }
      })
    ).toThrow(/basicAuth/i);
  });

  it("normalizes schemeless domain and localhost URLs", () => {
    const domain = parseAuditRequest({
      baseUrl: "example.com/store",
      paths: ["/"],
      formFactors: ["mobile"]
    });
    expect(domain.baseUrl).toBe("https://example.com/store");

    const local = parseAuditRequest({
      baseUrl: "localhost:3000",
      paths: ["/"],
      formFactors: ["desktop"],
      formLogin: {
        enabled: true,
        loginUrl: "localhost:3000/login",
        username: "demo",
        password: "secret"
      }
    });
    expect(local.baseUrl).toBe("http://localhost:3000");
    expect(local.formLogin.loginUrl).toBe("http://localhost:3000/login");
  });

  it("normalizes compare environments while preserving the first base URL as the baseline", () => {
    const parsed = parseAuditRequest({
      baseUrl: "dev1.example.com",
      displayName: "Dev compare",
      environments: [
        { name: "Dev 1", baseUrl: "dev1.example.com" },
        { name: "Dev 3", baseUrl: "https://dev3.example.com/" }
      ],
      paths: ["/mypage"],
      formFactors: ["desktop", "mobile"]
    });

    expect(parsed).toMatchObject({
      baseUrl: "https://dev1.example.com",
      displayName: "Dev compare",
      environments: [
        { name: "Dev 1", baseUrl: "https://dev1.example.com" },
        { name: "Dev 3", baseUrl: "https://dev3.example.com" }
      ],
      paths: ["/mypage"],
      formFactors: ["desktop", "mobile"]
    });
  });

  it("rejects invalid URLs, missing routes, missing form factors, and incomplete auth", () => {
    expect(() =>
      parseAuditRequest({ baseUrl: "not a url", paths: ["/"], formFactors: ["mobile"] })
    ).toThrow(/Base URL/);

    expect(() =>
      parseAuditRequest({ baseUrl: "https://example.com", paths: [], formFactors: ["mobile"] })
    ).toThrow(/path/i);

    expect(() =>
      parseAuditRequest({ baseUrl: "https://example.com", paths: ["/"], formFactors: [] })
    ).toThrow(/form factor/i);

    expect(() =>
      parseAuditRequest({
        baseUrl: "https://example.com",
        paths: ["/"],
        formFactors: ["mobile"],
        basicAuth: { enabled: true, username: "stage", password: "" }
      })
    ).toThrow(/Basic Auth password/);

    expect(() =>
      parseAuditRequest({
        baseUrl: "https://example.com",
        paths: ["/"],
        formFactors: ["mobile"],
        formLogin: { enabled: true, loginUrl: "", username: "u", password: "p" }
      })
    ).toThrow(/Login URL/);

    expect(() =>
      parseAuditRequest({
        baseUrl: "https://example.com",
        environments: [
          { name: "Dev 1", baseUrl: "https://dev1.example.com" },
          { name: "Dev 1", baseUrl: "https://dev3.example.com" }
        ],
        paths: ["/"],
        formFactors: ["mobile"]
      })
    ).toThrow(/Environment names must be unique/);
  });

  it("parses route textarea input into immutable slash-prefixed unique paths", () => {
    const parsed = parsePathText("\n/\nproducts\n/cart?draft=true\nproducts\n");

    expect(parsed).toEqual(["/", "/products", "/cart"]);
  });
});
