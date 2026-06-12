import { slugifyPathname } from "./route-slug.js";
import type { AuditEnvironment } from "../types/config.js";

export interface CompareAnchor {
  /** User-given environment name, e.g. "Dev 1". */
  name: string;
  /** Id of a selected tab whose host defines this environment. */
  anchorTargetId: string;
}

export interface CompareTabInput {
  targetId: string;
  /** Already host-allowlist-validated upstream. */
  rawUrl: string;
  displayUrl: string;
}

export interface CompareAssignment {
  targetId: string;
  envName: string;
  /** Pathname-derived label shared across environments. */
  route: string;
}

export type CompareWarningReason = "UNMATCHED_HOST" | "UNBALANCED_ROUTE" | "DUPLICATE_PATHNAME";

export interface CompareWarning {
  reason: CompareWarningReason;
  displayUrl: string;
  detail?: string;
}

export interface CompareMatchResult {
  /** Two environments, in anchor order (first = baseline). */
  environments: AuditEnvironment[];
  assignments: CompareAssignment[];
  warnings: CompareWarning[];
}

interface ResolvedAnchor {
  name: string;
  host: string;
  baseUrl: string;
}

/**
 * Match a manual tab selection into two compare environments.
 *
 * Environments are defined by anchor tabs: each anchor's hostname becomes that
 * environment's host key and its origin becomes the baseUrl. Every other selected
 * tab is assigned to the environment whose hostname it matches exactly. Routes are
 * identified by pathname only, so the same path on two subdomains pairs into one
 * comparison row.
 *
 * Pure and side-effect free. Throws on caller-preventable precondition violations
 * (missing anchor tab, anchors sharing a host); recoverable selection issues are
 * surfaced as warnings instead.
 */
export function matchTabsToEnvironments(
  selectedTabs: readonly CompareTabInput[],
  anchors: readonly [CompareAnchor, CompareAnchor]
): CompareMatchResult {
  const resolved: [ResolvedAnchor, ResolvedAnchor] = [
    resolveAnchor(anchors[0], selectedTabs),
    resolveAnchor(anchors[1], selectedTabs)
  ];
  if (resolved[0].host === resolved[1].host) {
    throw new Error("Compare anchors must resolve to distinct hosts");
  }

  const environments: AuditEnvironment[] = resolved.map((anchor) => ({
    name: anchor.name,
    baseUrl: anchor.baseUrl
  }));
  const hostToEnvName = new Map(resolved.map((anchor) => [anchor.host, anchor.name] as const));

  const assignments: CompareAssignment[] = [];
  const warnings: CompareWarning[] = [];
  const displayUrlByAssignment: string[] = [];
  const seenRoutesByEnv = new Map<string, Set<string>>();

  for (const tab of selectedTabs) {
    const url = parseUrl(tab.rawUrl);
    const envName = url ? hostToEnvName.get(url.hostname) : undefined;
    if (!url || !envName) {
      warnings.push({ reason: "UNMATCHED_HOST", displayUrl: tab.displayUrl });
      continue;
    }

    const route = buildCompareRoute(url.pathname);
    const seen = seenRoutesByEnv.get(envName) ?? new Set<string>();
    if (seen.has(route)) {
      warnings.push({ reason: "DUPLICATE_PATHNAME", displayUrl: tab.displayUrl, detail: route });
      continue;
    }
    seen.add(route);
    seenRoutesByEnv.set(envName, seen);

    assignments.push({ targetId: tab.targetId, envName, route });
    displayUrlByAssignment.push(tab.displayUrl);
  }

  appendUnbalancedWarnings(environments, assignments, displayUrlByAssignment, warnings);

  return { environments, assignments, warnings };
}

function resolveAnchor(anchor: CompareAnchor, selectedTabs: readonly CompareTabInput[]): ResolvedAnchor {
  const tab = selectedTabs.find((candidate) => candidate.targetId === anchor.anchorTargetId);
  if (!tab) {
    throw new Error(`Compare anchor "${anchor.name}" references a tab that is not in the selection`);
  }
  const url = parseUrl(tab.rawUrl);
  if (!url) {
    throw new Error(`Compare anchor "${anchor.name}" has an unparseable URL`);
  }
  return { name: anchor.name, host: url.hostname, baseUrl: url.origin };
}

function appendUnbalancedWarnings(
  environments: readonly AuditEnvironment[],
  assignments: readonly CompareAssignment[],
  displayUrlByAssignment: readonly string[],
  warnings: CompareWarning[]
): void {
  const routesByEnv = new Map<string, Set<string>>();
  for (const env of environments) {
    routesByEnv.set(
      env.name,
      new Set(assignments.filter((a) => a.envName === env.name).map((a) => a.route))
    );
  }

  assignments.forEach((assignment, index) => {
    const presentInBothEnvironments = environments.every((env) =>
      routesByEnv.get(env.name)?.has(assignment.route)
    );
    if (!presentInBothEnvironments) {
      warnings.push({
        reason: "UNBALANCED_ROUTE",
        displayUrl: displayUrlByAssignment[index]!,
        detail: assignment.route
      });
    }
  });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function buildCompareRoute(pathname: string): string {
  return `/manual-tabs/${slugifyPathname(pathname)}`;
}
