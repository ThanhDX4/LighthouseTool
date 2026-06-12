import { afterEach, describe, expect, it, vi } from "vitest";
import { performFormLogin } from "../src/lighthouse/run-once.js";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("form login flow", () => {
  it("registers the post-login wait before clicking submit", async () => {
    const calls: string[] = [];
    const page = {
      setExtraHTTPHeaders: async () => calls.push("headers"),
      goto: async () => calls.push("goto"),
      waitForSelector: async (selector: string) => {
        calls.push(`wait-selector:${selector}`);
      },
      type: async (selector: string) => calls.push(`type:${selector}`),
      waitForNavigation: async () => {
        calls.push("wait-navigation");
      },
      click: async () => calls.push("click")
    };

    await performFormLogin(
      page as any,
      {
        enabled: true,
        loginUrl: "https://example.com/login",
        usernameSelector: "#email",
        username: "demo@example.com",
        passwordSelector: "#password",
        password: "secret",
        submitSelector: "button",
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      },
      { Authorization: "Basic abc" }
    );

    expect(calls.indexOf("wait-navigation")).toBeLessThan(calls.indexOf("click"));
  });

  it("waits only for DOM readiness when opening the login page", async () => {
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto: vi.fn(async () => undefined),
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: async () => undefined,
      click: async () => undefined
    };

    await performFormLogin(
      page as any,
      {
        enabled: true,
        loginUrl: "https://example.com/login",
        usernameSelector: "#email",
        username: "demo@example.com",
        passwordSelector: "#password",
        password: "secret",
        submitSelector: "button",
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      },
      {}
    );

    expect(page.goto).toHaveBeenCalledWith("https://example.com/login", {
      timeout: 30_000,
      waitUntil: "domcontentloaded"
    });
  });

  it("waits for post-login navigation at DOM readiness", async () => {
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto: async () => undefined,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: vi.fn(async () => undefined),
      click: async () => undefined
    };

    await performFormLogin(
      page as any,
      {
        enabled: true,
        loginUrl: "https://example.com/login",
        usernameSelector: "#email",
        username: "demo@example.com",
        passwordSelector: "#password",
        password: "secret",
        submitSelector: "button",
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      },
      {}
    );

    expect(page.waitForNavigation).toHaveBeenCalledWith({
      timeout: 30_000,
      waitUntil: "domcontentloaded"
    });
  });

  it("accepts a successful submit response when the page does not emit navigation", async () => {
    const submitResponse = {
      status: () => 200,
      url: () => "https://example.com/login/",
      request: () => ({
        method: () => "POST"
      })
    };
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto: async () => undefined,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: vi.fn(async () => {
        throw new Error("Navigation timeout of 30000 ms exceeded");
      }),
      waitForResponse: vi.fn(async () => submitResponse),
      click: async () => undefined
    };

    await expect(
      performFormLogin(
        page as any,
        {
          enabled: true,
          loginUrl: "https://example.com/login/",
          usernameSelector: "#email",
          username: "demo@example.com",
          passwordSelector: "#password",
          password: "secret",
          submitSelector: "button",
          postLogin: { mode: "navigation", timeoutMs: 30_000 }
        },
        {}
      )
    ).resolves.toBeUndefined();

    expect(page.waitForResponse).toHaveBeenCalled();
  });

  it("waits 2000ms after a successful login response before returning", async () => {
    vi.useFakeTimers();

    const submitResponse = {
      status: () => 200,
      url: () => "https://example.com/login/",
      request: () => ({
        method: () => "POST"
      })
    };
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto: async () => undefined,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: vi.fn(async () => new Promise(() => undefined)),
      waitForResponse: vi.fn(async () => submitResponse),
      click: async () => undefined
    };

    let resolved = false;
    const loginPromise = performFormLogin(
      page as any,
      {
        enabled: true,
        loginUrl: "https://example.com/login/",
        usernameSelector: "#email",
        username: "demo@example.com",
        passwordSelector: "#password",
        password: "secret",
        submitSelector: "button",
        postLogin: { mode: "navigation", timeoutMs: 30_000 }
      },
      {}
    ).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await loginPromise;
    expect(resolved).toBe(true);
  });

  it("waits 2000ms after a successful login response in selector mode before returning", async () => {
    vi.useFakeTimers();

    const submitResponse = {
      status: () => 200,
      url: () => "https://example.com/login/",
      request: () => ({
        method: () => "POST"
      })
    };
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto: async () => undefined,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: async () => undefined,
      waitForResponse: vi.fn(async () => submitResponse),
      click: async () => undefined
    };

    let resolved = false;
    const loginPromise = performFormLogin(
      page as any,
      {
        enabled: true,
        loginUrl: "https://example.com/login/",
        usernameSelector: "#email",
        username: "demo@example.com",
        passwordSelector: "#password",
        password: "secret",
        submitSelector: "button",
        postLogin: {
          mode: "selector",
          selector: "#home",
          timeoutMs: 30_000
        }
      },
      {}
    ).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await loginPromise;
    expect(resolved).toBe(true);
    expect(page.waitForResponse).toHaveBeenCalled();
  });

  it("uses full-size desktop screen emulation by default", async () => {
    const launchFlags: string[][] = [];
    let lighthouseFlags: Record<string, any> | undefined;

    vi.doMock("chrome-launcher", () => ({
      launch: vi.fn(async ({ chromeFlags }: { chromeFlags: string[] }) => {
        launchFlags.push([...chromeFlags]);
        return { port: 9222, kill: vi.fn(async () => undefined) };
      })
    }));
    vi.doMock("lighthouse", () => ({
      default: vi.fn(async (_url: string, flags: Record<string, any>) => {
        lighthouseFlags = flags;
        return {
          lhr: {
            finalDisplayedUrl: "https://example.com/",
            categories: {
              performance: { score: 1 }
            }
          }
        };
      })
    }));

    const { runOnceLighthouse } = await import("../src/lighthouse/run-once.js");
    await runOnceLighthouse({
      url: "https://example.com/",
      formFactor: "desktop",
      config: {
        baseUrl: "https://example.com",
        displayName: "example.com",
        paths: ["/"],
        formFactors: ["desktop"],
        categories: ["performance"],
        runsPerPage: 1,
        throttling: { preset: "slow-4g" },
        basicAuth: { enabled: false },
        formLogin: {
          enabled: false,
          usernameSelector: "#email",
          passwordSelector: "#password",
          submitSelector: "button",
          postLogin: { mode: "navigation", timeoutMs: 30_000 }
        }
      },
      timeoutMs: 1000
    });

    expect(launchFlags[0]).toContain("--window-size=1920,1080");
    expect(lighthouseFlags?.screenEmulation).toEqual({
      mobile: false,
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      disabled: false
    });
  });

  it("retries a run with HTTP/2 disabled when login navigation hits a protocol error", async () => {
    const launchFlags: string[][] = [];
    const kill = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error("net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com/login/"))
      .mockResolvedValueOnce(undefined);
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: async () => undefined,
      click: async () => undefined
    };
    const lighthouse = vi.fn(async () => ({
      lhr: {
        finalDisplayedUrl: "https://example.com/protected",
        categories: {
          performance: { score: 1 }
        }
      }
    }));

    vi.doMock("chrome-launcher", () => ({
      launch: vi.fn(async ({ chromeFlags }: { chromeFlags: string[] }) => {
        launchFlags.push([...chromeFlags]);
        return { port: 9222 + launchFlags.length, kill };
      })
    }));
    vi.doMock("puppeteer-core", () => ({
      default: {
        connect: vi.fn(async () => ({
          disconnect,
          pages: async () => [page]
        }))
      }
    }));
    vi.doMock("lighthouse", () => ({ default: lighthouse }));

    const { runOnceLighthouse } = await import("../src/lighthouse/run-once.js");
    const lhr = await runOnceLighthouse({
      url: "https://example.com/protected",
      formFactor: "mobile",
      config: {
        baseUrl: "https://example.com",
        displayName: "example.com",
        paths: ["/protected"],
        formFactors: ["mobile"],
        categories: ["performance"],
        runsPerPage: 1,
        throttling: { preset: "slow-4g" },
        basicAuth: { enabled: true, username: "basic", password: "secret" },
        formLogin: {
          enabled: true,
          loginUrl: "https://example.com/login/",
          usernameSelector: "#email",
          username: "demo@example.com",
          passwordSelector: "#password",
          password: "secret",
          submitSelector: "button",
          postLogin: { mode: "navigation", timeoutMs: 30_000 }
        }
      },
      timeoutMs: 1000
    });

    expect(lhr.finalDisplayedUrl).toBe("https://example.com/protected");
    expect(launchFlags).toHaveLength(2);
    expect(launchFlags[0]).not.toContain("--disable-http2");
    expect(launchFlags[1]).toContain("--disable-http2");
    expect(kill).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("retries a recoverable login navigation timeout with headed Chrome", async () => {
    const launchFlags: string[][] = [];
    const kill = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error("Navigation timeout of 30000 ms exceeded"))
      .mockResolvedValueOnce(undefined);
    const page = {
      setExtraHTTPHeaders: async () => undefined,
      goto,
      waitForSelector: async () => undefined,
      type: async () => undefined,
      waitForNavigation: async () => undefined,
      click: async () => undefined
    };
    const lighthouse = vi.fn(async () => ({
      lhr: {
        finalDisplayedUrl: "https://example.com/protected",
        categories: {
          performance: { score: 1 }
        }
      }
    }));

    vi.doMock("chrome-launcher", () => ({
      launch: vi.fn(async ({ chromeFlags }: { chromeFlags: string[] }) => {
        launchFlags.push([...chromeFlags]);
        return { port: 9332 + launchFlags.length, kill };
      })
    }));
    vi.doMock("puppeteer-core", () => ({
      default: {
        connect: vi.fn(async () => ({
          disconnect,
          pages: async () => [page]
        }))
      }
    }));
    vi.doMock("lighthouse", () => ({ default: lighthouse }));

    const { runOnceLighthouse } = await import("../src/lighthouse/run-once.js");
    const lhr = await runOnceLighthouse({
      url: "https://example.com/protected",
      formFactor: "mobile",
      config: {
        baseUrl: "https://example.com",
        displayName: "example.com",
        paths: ["/protected"],
        formFactors: ["mobile"],
        categories: ["performance"],
        runsPerPage: 1,
        throttling: { preset: "slow-4g" },
        basicAuth: { enabled: true, username: "basic", password: "secret" },
        formLogin: {
          enabled: true,
          loginUrl: "https://example.com/login/",
          usernameSelector: "#email",
          username: "demo@example.com",
          passwordSelector: "#password",
          password: "secret",
          submitSelector: "button",
          postLogin: { mode: "navigation", timeoutMs: 30_000 }
        }
      },
      timeoutMs: 1000
    });

    expect(lhr.finalDisplayedUrl).toBe("https://example.com/protected");
    expect(launchFlags).toHaveLength(2);
    expect(launchFlags[0]).toContain("--headless=new");
    expect(launchFlags[1]).not.toContain("--headless=new");
    expect(kill).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
