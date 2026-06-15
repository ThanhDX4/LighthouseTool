# Manual Audit — Compare 2 Environments (Design Spec)

**Date:** 2026-06-12
**Status:** Approved (design), pending spec review
**Branch:** codex/manual-chrome-tabs

## Goal

Add the ability to run a Lighthouse **compare between 2 environments** within the
**manual Chrome tabs** audit flow. When the user scans their open tabs, the selected
tabs are matched into two environments by **host/subdomain**, routes are paired by
**pathname**, and the resulting report includes a `Compare` sheet.

The report layer already supports environments + a `Compare` sheet for the _static_
audit flow ([src/report/workbook.ts](../../../src/report/workbook.ts) `addCompareSheet`,
`findEnvironmentResult`) and the static worker path already assembles per-environment
`RouteReport`s ([src/worker/audit-worker.ts](../../../src/worker/audit-worker.ts)).
The manual flow currently hard-codes `environment: undefined` and
`ManualTabsAuditConfig.environments?: undefined`. **This feature brings the existing
compare report path to the manual flow** — it does not reinvent the report layer.

## Decisions (locked)

1. **Environment source — Hybrid (anchor + auto-group).** The user names 2 environments
   and picks one selected tab as the _anchor_ of each. The anchor tab's **hostname**
   becomes that environment's host key; `baseUrl` = anchor's `origin`. Every other
   selected tab is assigned to the environment whose hostname it matches exactly.
2. **Route identity = pathname only.** `dev1.example.com/checkout` and
   `dev3.example.com/checkout` → the same route `/checkout`. Query and hash are ignored.
3. **Unbalanced selection** (a pathname present in only one environment): the route is
   still audited and shown with `N/A` in the missing environment's columns (existing
   `findEnvironmentResult` behavior), **and** a warning `DiagnosticEntry` is emitted.
4. **Exactly 2 environments** for manual compare (YAGNI). The report layer supports N,
   but the manual compare request is constrained to 2 anchors.

## Architecture

### New pure module — `src/manual-chrome/compare-matching.ts`

The single unit under test. Pure, no I/O.

```ts
export interface CompareAnchor {
    name: string; // user-given, e.g. "Dev 1"
    anchorTargetId: string; // a selected tab id whose host defines the environment
}

export interface CompareTabInput {
    targetId: string;
    rawUrl: string; // already host-allowlist-validated upstream
    displayUrl: string;
}

export interface CompareAssignment {
    targetId: string;
    envName: string;
    route: string; // "/<slug(pathname)>", shared across envs
}

export interface CompareWarning {
    reason: "UNMATCHED_HOST" | "UNBALANCED_ROUTE" | "DUPLICATE_PATHNAME";
    displayUrl: string;
    detail?: string;
}

export interface CompareMatchResult {
    environments: AuditEnvironment[]; // [{name, baseUrl}, {name, baseUrl}]
    assignments: CompareAssignment[];
    warnings: CompareWarning[];
}

export function matchTabsToEnvironments(
    selectedTabs: readonly CompareTabInput[],
    anchors: readonly [CompareAnchor, CompareAnchor],
): CompareMatchResult;
```

**Algorithm**

1. Resolve each anchor's hostname + origin from its tab's `rawUrl`. Two anchors must
   resolve to two **distinct** hostnames (else throw / return a structured error).
2. For each selected tab: parse hostname.
    - Matches an anchor host → assign to that environment; `route = /<slug(pathname)>`.
    - Matches neither → `UNMATCHED_HOST` warning, excluded.
3. Within one environment, a repeated `route` → keep first, `DUPLICATE_PATHNAME` warning.
4. After assignment, any `route` present in one environment but not the other →
   `UNBALANCED_ROUTE` warning (the route is still kept; compare renders N/A).
5. `environments` preserves anchor order (first anchor = baseline, matching the static
   `Compare` baseline convention).

`slug(pathname)` reuses the existing slug rule from
[src/manual-chrome/job-submission.ts](../../../src/manual-chrome/job-submission.ts)
(`slugifyPathname`) — extract it to a shared helper to avoid duplication (refactor-clean).

### Request / config / type changes

- `ManualTabsAuditConfig`: relax `environments?: undefined` to accept
  `AuditEnvironment[]` (compare jobs only). Keep absent for normal manual jobs.
- Manual submit request schema (zod): optional
  `compare?: { environments: [{ name, anchorTargetId }, { name, anchorTargetId }] }`.
- `safe-audit-config` redaction: include environment names (no secrets in names/baseUrls,
  but route through the same redaction path for consistency).

### Worker wiring — `src/worker/audit-worker.ts` (manual branch)

- If the resolved manual config carries compare environments:
    - Call `matchTabsToEnvironments` to get `environments` + `assignments` + `warnings`.
    - Build each `RouteReport` with `environment` set and `routeKey = ${envName} ${route}`
      (identical to the static compare path).
    - Emit each `CompareWarning` as a `DiagnosticEntry` (severity `warning`).
    - Pass `environments` to `buildAuditReport` → `Compare` sheet is produced automatically.
- If no compare: **unchanged** behavior (`environment: undefined`, no `Compare` sheet).

## Report output (mirrors static compare)

`Summary` (with Environment column) · `Compare` · per-environment route sheets
(`Dev 1 checkout`, `Dev 3 checkout`) · `Diagnostics` (incl. warnings) · `Run Configuration`.
All already implemented and tested in `workbook.ts`.

## Testing (TDD order)

1. **RED unit** — `tests/manual-compare-matching.test.ts`:
    - 2 envs, matching pathnames → 2 environments, balanced assignments, no warnings.
    - host not matching any anchor → `UNMATCHED_HOST`, tab excluded.
    - pathname in one env only → `UNBALANCED_ROUTE` warning, route retained.
    - duplicate pathname in one env → `DUPLICATE_PATHNAME`, first kept.
    - two anchors with same host → structured error.
2. **GREEN** — implement `matchTabsToEnvironments`.
3. **Integration** — extend `tests/report.test.ts`: assemble a manual compare config →
   `buildAuditWorkbook` → assert `Compare` sheet exists, Summary has Environment column,
   both environments' values present, unbalanced route shows `N/A`.
4. **GREEN** — worker wiring + type/schema changes.
5. **refactor-clean** — extract shared `slugifyPathname`, remove any dead code, keep all green.

Coverage target ≥ 80% on new module + changed worker branch.

## Out of scope

- N>2 environment compare in manual flow.
- Front-end UI for anchor selection (separate task; this spec covers server/worker/report).
- Changing the static audit flow.
