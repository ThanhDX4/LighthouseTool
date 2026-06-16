import { randomUUID } from "node:crypto";
import {
  areRedirectHostsAllowed,
  assertAllowedManualUrl
} from "./access-control.js";
import { matchTabsToEnvironments, type CompareTabInput } from "./compare-matching.js";
import { slugifyPathname } from "./route-slug.js";
import type { ManualChromeScanSnapshot, ManualChromeSessionRecord } from "./types.js";
import type {
  AuditEnvironment,
  FormLoginConfig,
  ManualChromeExecutionData,
  ManualChromeTargetDescriptor,
  ManualCompareSelection,
  ManualCompareWarning,
  ManualTabsAuditConfig,
  ManualTabsAuditRequest
} from "../types/config.js";

const manualDisabledFormLogin: FormLoginConfig = {
  enabled: false,
  usernameSelector: "input[name=\"email\"]",
  passwordSelector: "input[name=\"password\"]",
  submitSelector: "button[type=\"submit\"]",
  postLogin: { mode: "navigation", timeoutMs: 30_000 }
};

export interface ResolveManualTargetsInput {
  snapshot: ManualChromeScanSnapshot;
  session: ManualChromeSessionRecord;
  targetIds: readonly string[];
  allowedHosts: readonly string[];
  selectedAt?: string;
  /** When present, resolve a 2-environment compare selection. */
  compare?: ManualCompareSelection | undefined;
}

export interface ResolvedManualTargets {
  targets: ManualChromeTargetDescriptor[];
  baseUrl: string;
  /** Set only for compare jobs. */
  environments?: AuditEnvironment[] | undefined;
  warnings?: ManualCompareWarning[] | undefined;
}

/**
 * Resolve a scan selection into immutable, frozen target descriptors.
 *
 * Returns a `{ code, message }` error instead of throwing so the caller can map
 * each failure to a specific HTTP status. Every selected raw URL and its known
 * redirect hosts are revalidated against the allowlist here — the snapshot is
 * treated as untrusted UI state, not authority.
 */
export function resolveManualTargets(
  input: ResolveManualTargetsInput
): ResolvedManualTargets | { code: "INVALID_SELECTION" | "DISALLOWED_HOST" | "DISALLOWED_REDIRECT" | "NO_BASE_URL"; message: string } {
  const selectedTabs = selectSnapshotTabs(input.snapshot, input.targetIds);
  if (!selectedTabs) {
    return { code: "INVALID_SELECTION", message: "One or more selected tabs are no longer valid" };
  }

  const selectedAt = input.selectedAt ?? new Date().toISOString();

  if (input.compare) {
    return resolveCompareTargets(selectedTabs, input.session, input.compare, input.allowedHosts, selectedAt);
  }

  const targets: ManualChromeTargetDescriptor[] = [];
  let baseUrl: string | undefined;

  for (const [index, tab] of selectedTabs.entries()) {
    let auditUrl: URL;
    try {
      auditUrl = assertAllowedManualUrl(tab.rawUrl, input.allowedHosts);
    } catch {
      return { code: "DISALLOWED_HOST", message: "A selected tab URL is not allowed" };
    }
    if (!areRedirectHostsAllowed(tab.redirectHosts, input.allowedHosts)) {
      return { code: "DISALLOWED_REDIRECT", message: "A selected tab has a disallowed redirect host" };
    }
    if (!baseUrl) {
      baseUrl = auditUrl.origin;
    }
    targets.push(
      Object.freeze({
        targetId: tab.id,
        profileSessionId: input.session.profileSessionId,
        ownerNonce: input.session.ownerNonce,
        serverInstanceId: input.session.serverInstanceId,
        auditUrl: auditUrl.toString(),
        displayUrl: tab.displayUrl,
        route: buildManualRoute(index, auditUrl),
        selectedAt
      })
    );
  }

  if (!baseUrl) {
    return { code: "NO_BASE_URL", message: "Unable to derive a base URL from the selection" };
  }

  return { targets, baseUrl };
}

/** Build the immutable queued config from a parsed request and resolved targets. Pure. */
export function buildManualQueuedConfig(
  parsed: ManualTabsAuditRequest,
  baseUrl: string,
  targets: ManualChromeTargetDescriptor[],
  execution: ManualChromeExecutionData
): ManualTabsAuditConfig {
  return {
    mode: "manual-tabs",
    displayName: parsed.displayName,
    formFactors: [...parsed.formFactors],
    categories: [...parsed.categories],
    runsPerPage: parsed.runsPerPage,
    throttling: {
      preset: parsed.throttling.preset,
      custom: parsed.throttling.custom ? { ...parsed.throttling.custom } : undefined
    },
    baseUrl,
    paths: targets.map((target) => target.route),
    basicAuth: { enabled: false },
    formLogin: manualDisabledFormLogin,
    manualChrome: {
      cachePolicy: parsed.manualChrome.cachePolicy,
      evidenceMode: parsed.manualChrome.evidenceMode,
      execution
    }
  };
}

export function newManualJobId(): string {
  return randomUUID();
}

export function newManualOwnerToken(): string {
  return randomUUID();
}

/**
 * Resolve a 2-environment compare selection. Validates each tab against the
 * allowlist, matches tabs to environments by host/subdomain, and builds frozen
 * target descriptors carrying their environment and a shared pathname route.
 */
function resolveCompareTargets(
  selectedTabs: ManualChromeScanSnapshot["tabs"],
  session: ManualChromeSessionRecord,
  compare: ManualCompareSelection,
  allowedHosts: readonly string[],
  selectedAt: string
): ResolvedManualTargets | { code: "INVALID_SELECTION" | "DISALLOWED_HOST" | "DISALLOWED_REDIRECT" | "NO_BASE_URL"; message: string } {
  const validatedUrlById = new Map<string, URL>();
  const tabInputs: CompareTabInput[] = [];
  for (const tab of selectedTabs) {
    let auditUrl: URL;
    try {
      auditUrl = assertAllowedManualUrl(tab.rawUrl, allowedHosts);
    } catch {
      return { code: "DISALLOWED_HOST", message: "A selected tab URL is not allowed" };
    }
    if (!areRedirectHostsAllowed(tab.redirectHosts, allowedHosts)) {
      return { code: "DISALLOWED_REDIRECT", message: "A selected tab has a disallowed redirect host" };
    }
    validatedUrlById.set(tab.id, auditUrl);
    tabInputs.push({ targetId: tab.id, rawUrl: tab.rawUrl, displayUrl: tab.displayUrl });
  }

  let match;
  try {
    // For compare jobs, include the query string in route matching by default.
    match = matchTabsToEnvironments(tabInputs, compare.environments, { includeQuery: true });
  } catch (error) {
    return { code: "INVALID_SELECTION", message: error instanceof Error ? error.message : "Invalid compare selection" };
  }

  const environmentByName = new Map(match.environments.map((environment) => [environment.name, environment] as const));
  const tabById = new Map(selectedTabs.map((tab) => [tab.id, tab] as const));
  const targets: ManualChromeTargetDescriptor[] = [];
  for (const assignment of match.assignments) {
    const tab = tabById.get(assignment.targetId);
    const auditUrl = validatedUrlById.get(assignment.targetId);
    const environment = environmentByName.get(assignment.envName);
    if (!tab || !auditUrl || !environment) continue;
    targets.push(
      Object.freeze({
        targetId: tab.id,
        profileSessionId: session.profileSessionId,
        ownerNonce: session.ownerNonce,
        serverInstanceId: session.serverInstanceId,
        auditUrl: auditUrl.toString(),
        displayUrl: tab.displayUrl,
        route: assignment.route,
        selectedAt,
        environment: { ...environment }
      })
    );
  }

  const baseUrl = match.environments[0]?.baseUrl;
  if (!baseUrl) {
    return { code: "NO_BASE_URL", message: "Unable to derive a base URL from the selection" };
  }

  return { targets, baseUrl, environments: match.environments, warnings: match.warnings };
}

function selectSnapshotTabs(
  snapshot: ManualChromeScanSnapshot,
  targetIds: readonly string[]
): ManualChromeScanSnapshot["tabs"] | null {
  const byId = new Map(snapshot.tabs.map((tab) => [tab.id, tab] as const));
  const selected: ManualChromeScanSnapshot["tabs"] = [];
  for (const targetId of targetIds) {
    const tab = byId.get(targetId);
    if (!tab || !tab.valid) return null;
    selected.push(tab);
  }
  return selected.length ? selected : null;
}

/**
 * Build a unique route label. The `NN-` index prefix guarantees uniqueness
 * across duplicate pathnames, so no collision set is needed.
 */
function buildManualRoute(index: number, url: URL): string {
  const prefix = String(index + 1).padStart(2, "0");
  return `/${prefix}-${slugifyPathname(url.pathname)}`;
}

