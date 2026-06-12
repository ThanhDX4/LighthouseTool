import type { ManualChromeErrorCode } from "./types.js";

export interface ManualRequestAccessInput {
  remoteAddress?: string | undefined;
  host?: string | undefined;
  origin?: string | undefined;
  referer?: string | undefined;
  forwardedFor?: string | undefined;
  forwardedHost?: string | undefined;
}

export type ManualRequestAccessResult =
  | { allowed: true }
  | { allowed: false; code: ManualChromeErrorCode; error: string };

export function evaluateManualRequestAccess(input: ManualRequestAccessInput): ManualRequestAccessResult {
  if (!isLoopbackAddress(input.remoteAddress)) {
    return forbidden("Manual Chrome requires a loopback connection");
  }

  const host = parseHost(input.host);
  if (!host || !isLoopbackHostname(host.hostname)) {
    return forbidden("Manual Chrome requires a loopback Host header");
  }

  for (const [label, value] of [["Origin", input.origin], ["Referer", input.referer]] as const) {
    if (!value) continue;
    const parsed = parseWebUrl(value);
    if (!parsed || !isLoopbackHostname(parsed.hostname) || parsed.host.toLowerCase() !== host.host.toLowerCase()) {
      return forbidden(`Manual Chrome requires a same-origin loopback ${label}`);
    }
  }

  return { allowed: true };
}

/**
 * Validates that a tab URL is auditable by Lighthouse. We only check the
 * URL scheme (http/https) — the host allowlist gate has been removed so any
 * reachable host is permitted. `_allowedHosts` is kept for backward-compatible
 * signatures but is intentionally ignored.
 */
export function assertAllowedManualUrl(value: string, _allowedHosts: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid tab URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  return new URL(url.toString());
}

export function sanitizeDisplayUrl(value: string): { displayUrl: string; hasHiddenUrlParts: boolean } {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  const displayUrl = `${url.origin}${url.pathname || "/"}`;
  return {
    displayUrl,
    hasHiddenUrlParts: Boolean(url.search || url.hash || url.username || url.password)
  };
}

export function sanitizeManualErrorMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s)\]}>,"']+/gi, (candidate) => {
    try {
      return sanitizeDisplayUrl(candidate).displayUrl;
    } catch {
      return "[redacted-url]";
    }
  });
}

/**
 * Host allowlist enforcement has been removed; all redirect chains are
 * permitted. Kept as a no-op for signature compatibility with existing callers.
 */
export function areRedirectHostsAllowed(_hosts: readonly string[], _allowedHosts: readonly string[]): boolean {
  return true;
}

function forbidden(error: string): ManualRequestAccessResult {
  return { allowed: false, code: "MANUAL_CHROME_FORBIDDEN", error };
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function isLoopbackHostname(value: string): boolean {
  const normalized = normalizeHostname(value);
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseHost(value: string | undefined): URL | null {
  if (!value) return null;
  return parseWebUrl(`http://${value}`);
}

function parseWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
