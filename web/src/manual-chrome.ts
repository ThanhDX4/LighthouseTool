import { matchTabsToEnvironments, type CompareTabInput } from "../../src/manual-chrome/compare-matching.js";
import type { Category, FormFactor, ThrottlingPreset } from "./job-detail.js";

export type ManualEvidenceMode = "none" | "html";
export type ManualCachePolicy = "preserve-profile";

export interface ManualScanTab {
    id: string;
    title: string;
    displayUrl: string;
    hasHiddenUrlParts: boolean;
    valid: true;
}

export interface ManualSkippedTab {
    id: string;
    title: string;
    displayUrl: string;
    reason: string;
}

export interface ManualScanResponse {
    scanId: string;
    expiresAt: string;
    busy: boolean;
    remoteDebuggingUrl: string;
    totalOpenTabs: number;
    tabs: ManualScanTab[];
    skipped: ManualSkippedTab[];
}

export interface ManualSessionResponse {
    enabled: boolean;
    running: boolean;
    busy: boolean;
    profileSessionId?: string;
    remoteDebuggingUrl?: string;
    profileDir?: string;
}

/**
 * Immutable view of a completed scan plus the user's current tab selection.
 * App.tsx holds this in state and replaces it wholesale on every change.
 */
export interface ManualScanState {
    scanId: string;
    expiresAt: string;
    totalOpenTabs: number;
    tabs: ManualScanTab[];
    skipped: ManualSkippedTab[];
    selectedIds: string[];
}

export interface ManualSharedSettings {
    displayName: string;
    formFactors: FormFactor[];
    categories: Category[];
    runsPerPage: number;
    throttlingPreset: ThrottlingPreset;
    custom: {
        rttMs: number;
        throughputKbps: number;
        cpuSlowdownMultiplier: number;
    };
}

export interface ManualCompareAnchorInput {
    name: string;
    anchorTargetId: string;
}

export interface ManualCompareInput {
    enabled: boolean;
    environments: [ManualCompareAnchorInput, ManualCompareAnchorInput];
    includeQuery?: boolean;
}

export interface ManualComparePreviewEnvironment {
    name: string;
    host: string;
    routes: string[];
}

export interface ManualComparePreviewWarning {
    reason: "UNMATCHED_HOST" | "UNBALANCED_ROUTE" | "DUPLICATE_PATHNAME";
    displayUrl: string;
    detail?: string;
}

export interface ManualComparePreview {
    environments: ManualComparePreviewEnvironment[];
    warnings: ManualComparePreviewWarning[];
}

export interface ManualPayloadInput {
    scan: ManualScanState;
    settings: ManualSharedSettings;
    evidenceMode: ManualEvidenceMode;
    compare?: ManualCompareInput;
}

export interface ManualJobPayload {
    mode: "manual-tabs";
    displayName?: string;
    formFactors: FormFactor[];
    categories: Category[];
    runsPerPage: number;
    throttling: {
        preset: ThrottlingPreset;
        custom?: {
            rttMs: number;
            throughputKbps: number;
            cpuSlowdownMultiplier: number;
        };
    };
    manualChrome: {
        scanId: string;
        targetIds: string[];
        cachePolicy: ManualCachePolicy;
        evidenceMode: ManualEvidenceMode;
        compare?: {
            environments: [ManualCompareAnchorInput, ManualCompareAnchorInput];
        };
    };
}

export function deriveScanState(response: ManualScanResponse): ManualScanState {
    return {
        scanId: response.scanId,
        expiresAt: response.expiresAt,
        totalOpenTabs: response.totalOpenTabs,
        tabs: response.tabs.map((tab) => ({ ...tab })),
        skipped: response.skipped.map((tab) => ({ ...tab })),
        selectedIds: [],
    };
}

export function toggleSelectedTab(state: ManualScanState, targetId: string): ManualScanState {
    const isValid = state.tabs.some((tab) => tab.id === targetId);
    if (!isValid) return state;
    const isSelected = state.selectedIds.includes(targetId);
    return {
        ...state,
        selectedIds: isSelected
            ? state.selectedIds.filter((id) => id !== targetId)
            : [...state.selectedIds, targetId],
    };
}

export function isScanExpired(state: ManualScanState, now: number = Date.now()): boolean {
    const expiry = Date.parse(state.expiresAt);
    return Number.isFinite(expiry) ? expiry <= now : true;
}

export interface ManualSubmissionValidityInput {
    scan: ManualScanState | null;
    evidenceMode: ManualEvidenceMode;
    evidenceConsent: boolean;
    formFactors: FormFactor[];
    categories: Category[];
    runsPerPage: number;
    now?: number;
}

export function isManualSubmissionValid(input: ManualSubmissionValidityInput): boolean {
    const { scan } = input;
    if (!scan) return false;
    if (scan.selectedIds.length === 0) return false;
    if (isScanExpired(scan, input.now)) return false;
    if (input.formFactors.length === 0 || input.categories.length === 0) return false;
    if (input.runsPerPage < 1 || input.runsPerPage > 11) return false;
    if (input.evidenceMode === "html" && !input.evidenceConsent) return false;
    return true;
}

export function buildManualPayload(input: ManualPayloadInput): ManualJobPayload {
    const { scan, settings, evidenceMode, compare } = input;
    const selectedIds = scan.tabs
        .filter((tab) => scan.selectedIds.includes(tab.id))
        .map((tab) => tab.id);
    const displayName = settings.displayName.trim();

    const includeCompare = Boolean(compare?.enabled) && isManualCompareValid(scan.tabs, compare!);
    const compareField = includeCompare
        ? {
              compare: {
                  environments: [
                      {
                          name: compare!.environments[0].name.trim(),
                          anchorTargetId: compare!.environments[0].anchorTargetId,
                      },
                      {
                          name: compare!.environments[1].name.trim(),
                          anchorTargetId: compare!.environments[1].anchorTargetId,
                      },
                  ] as [ManualCompareAnchorInput, ManualCompareAnchorInput],
                  includeQuery: compare!.includeQuery ?? true,
              },
          }
        : {};

    return {
        mode: "manual-tabs",
        ...(displayName ? { displayName } : {}),
        formFactors: [...settings.formFactors],
        categories: [...settings.categories],
        runsPerPage: settings.runsPerPage,
        throttling:
            settings.throttlingPreset === "custom"
                ? { preset: settings.throttlingPreset, custom: { ...settings.custom } }
                : { preset: settings.throttlingPreset },
        manualChrome: {
            scanId: scan.scanId,
            targetIds: selectedIds,
            cachePolicy: "preserve-profile",
            evidenceMode,
            ...compareField,
        },
    };
}

function anchorHost(tabs: readonly ManualScanTab[], anchorTargetId: string): string | null {
    const tab = tabs.find((candidate) => candidate.id === anchorTargetId);
    if (!tab) return null;
    try {
        return new URL(tab.displayUrl).hostname;
    } catch {
        return null;
    }
}

/**
 * Validate a compare configuration: both environments named, both anchors chosen,
 * both anchors present in the scan, and resolving to two distinct hosts.
 */
export function isManualCompareValid(tabs: readonly ManualScanTab[], compare: ManualCompareInput): boolean {
    const [first, second] = compare.environments;
    if (!first || !second) return false;
    if (!first.name.trim() || !second.name.trim()) return false;
    if (!first.anchorTargetId || !second.anchorTargetId) return false;
    const hostA = anchorHost(tabs, first.anchorTargetId);
    const hostB = anchorHost(tabs, second.anchorTargetId);
    if (!hostA || !hostB) return false;
    return hostA !== hostB;
}

/**
 * Client-side preview of how the selected tabs map onto the two environments.
 * Reuses the server's pure matcher (sanitized displayUrl carries origin + pathname,
 * which is all the matcher needs) so the preview cannot drift from the real result.
 */
export function previewCompareMatch(
    tabs: readonly ManualScanTab[],
    selectedIds: readonly string[],
    environments: readonly [ManualCompareAnchorInput, ManualCompareAnchorInput]
): ManualComparePreview {
    const selected = tabs.filter((tab) => selectedIds.includes(tab.id));
    const tabInputs: CompareTabInput[] = selected.map((tab) => ({
        targetId: tab.id,
        rawUrl: tab.displayUrl,
        displayUrl: tab.displayUrl,
    }));

    let result;
    try {
        result = matchTabsToEnvironments(tabInputs, environments);
    } catch {
        return { environments: [], warnings: [] };
    }

    const previewEnvironments = result.environments.map((environment) => ({
        name: environment.name,
        host: hostFromOrigin(environment.baseUrl),
        routes: result.assignments
            .filter((assignment) => assignment.envName === environment.name)
            .map((assignment) => assignment.route),
    }));

    return { environments: previewEnvironments, warnings: result.warnings };
}

function hostFromOrigin(origin: string): string {
    try {
        return new URL(origin).hostname;
    } catch {
        return origin;
    }
}

export function selectedTabDisplayUrls(state: ManualScanState): string[] {
    return state.tabs
        .filter((tab) => state.selectedIds.includes(tab.id))
        .map((tab) => tab.displayUrl);
}
