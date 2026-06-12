# Manual Compare — Front-end (Design Spec)

**Date:** 2026-06-12
**Status:** Approved (design)
**Branch:** codex/manual-chrome-tabs
**Depends on:** [2026-06-12-manual-compare-environments-design.md](2026-06-12-manual-compare-environments-design.md) (server/worker/report already implemented)

## Goal

Let users actually trigger a 2-environment compare from the manual audit UI. The
server already accepts `manualChrome.compare = { environments: [{name, anchorTargetId}×2] }`
but no client surface sends it. This spec adds the UI + payload wiring.

## Interaction (web/src/ManualAudit.tsx)

1. After scanning and selecting tabs, show a checkbox **"Compare 2 environments"**.
2. When enabled, render two cards (Environment 1 / Environment 2). Each has:
   - a **name** input (e.g. "Dev 1"),
   - an **anchor tab** dropdown listing the scanned valid tabs (the anchor's host
     defines the environment).
3. Below the cards, a **preview** computed from the current tab selection: group tabs
   by hostname matching each anchor host, list each environment's routes (by pathname),
   and show inline warnings: `unmatched host`, `route only in one env (N/A)`,
   `duplicate pathname`.

## Validation / submit gating

- Compare enabled ⇒ both names non-empty, both anchors chosen, and **two distinct
  anchor hosts** — otherwise submit is blocked with a clear message.
- Unmatched / unbalanced / duplicate tabs ⇒ **warn only, still allow submit** (mirrors
  backend decision #3; warnings also reappear as report diagnostics).
- Compare disabled ⇒ payload identical to today (no `compare` field).

## Payload (web/src/manual-chrome.ts)

- Extend `ManualJobPayload.manualChrome` with optional
  `compare?: { environments: [{ name: string; anchorTargetId: string }, ...] }`.
- Add compare anchor/name state to `ManualScanState` (or a sibling compare-state object
  held by `ManualAudit.tsx`).
- `buildManualPayload` attaches `compare` only when compare mode is valid; otherwise omits it.

## Preview matching — reuse, avoid drift

`src/manual-chrome/compare-matching.ts` imports only a *type* from config, so it is
browser-safe. Plan: reuse its pure logic for the preview. If the web Vite build cannot
resolve `../../src/...`, extract the shared `slugifyPathname` + host-grouping into a
browser-importable helper and add a small, unit-tested `previewCompareMatch` in `web/`
that mirrors `matchTabsToEnvironments` exactly. Reuse is preferred over re-porting.

## Testing (TDD order)

Repo testing infra: Vitest, `environment: node`, `include: tests/**/*.test.ts`. No
React Testing Library / jsdom set up, so render tests are out of scope; logic lives in
`.ts` and is unit-tested (consistent with the existing codebase).

1. **RED** `tests/manual-compare-payload.test.ts`: `buildManualPayload` includes a
   correct `compare` field when enabled; omits it when disabled.
2. **RED** preview helper: grouping by host, route by pathname, detects
   unmatched/unbalanced/duplicate — same cases as `matchTabsToEnvironments`.
3. **GREEN** implement payload + preview helper + `ManualAudit.tsx` state/UI.
4. **Verify** typecheck + full suite green; UI built per web design-quality rules.

## Out of scope

- N>2 environments. Changing the static flow. Automated render/E2E tests (no RTL/jsdom
  configured) — covered by logic unit tests + manual check.
