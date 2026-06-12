# Manual Chrome Tabs Audit Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only `Manual Chrome Tabs` audit mode that scans tabs in an app-owned persistent Chrome profile and audits selected authenticated pages without closing Chrome, while preserving the existing static LP audit flow.

**Architecture:** Keep `POST /jobs`, SSE progress, persisted reports, history, and downloads as the shared pipeline. Add a discriminated `manual-tabs` job contract, an app-owned loopback CDP session manager, Redis-backed scan snapshots and fenced profile locks, and a worker branch that connects to selected existing pages instead of launching fresh Chrome. Reuse the existing route-run, extraction, workbook, and evidence pipeline with sanitized manual target metadata and explicit evidence limits.

**Tech Stack:** TypeScript, Fastify, BullMQ, Redis/ioredis, Chrome Launcher, Puppeteer Core, Lighthouse, React 18, Vite, Vitest, ExcelJS.

**Design reference:** `docs/superpowers/specs/2026-06-11-manual-chrome-tabs-audit-design.md`

---

### Task 1: Add Mode-Aware Config, Runtime Settings, And Encrypted Manual Targets

**Files:**
- Modify: `src/types/config.ts`
- Modify: `src/config/audit-config.ts`
- Modify: `src/config/safe-audit-config.ts`
- Modify: `src/config/env.ts`
- Modify: `src/security/credentials.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`
- Test: `tests/credentials.test.ts`

- [x] **Step 1: Write failing config tests**

Add tests that prove:

```ts
expect(parseAuditRequest(staticPayload).mode).toBe("static");

expect(parseAuditRequest({
  mode: "manual-tabs",
  displayName: "Authenticated checkout",
  formFactors: ["desktop"],
  categories: ["performance"],
  runsPerPage: 1,
  throttling: { preset: "slow-4g" },
  manualChrome: {
    scanId: "scan_123",
    targetIds: ["target-1"],
    cachePolicy: "preserve-profile",
    evidenceMode: "none"
  }
})).toMatchObject({
  mode: "manual-tabs",
  manualChrome: {
    scanId: "scan_123",
    targetIds: ["target-1"]
  }
});
```

Also reject manual payloads with credential fields, missing targets, invalid cache policy, invalid evidence mode, or more than the configured maximum targets.

- [x] **Step 2: Write failing encryption tests**

Add a manual queued config fixture whose resolved target contains a raw `auditUrl`. Assert:

```ts
const encrypted = encryptJobConfig(config, encryptionKey);
expect(JSON.stringify(encrypted)).not.toContain("otpToken=secret");
expect(isEncryptedSecret(encrypted.manualChrome.targets[0]?.auditUrl)).toBe(true);

const decrypted = decryptJobConfig(encrypted, encryptionKey);
expect(decrypted.manualChrome.targets[0]?.auditUrl).toBe(
  "https://example.com/checkout?otpToken=secret"
);
```

- [x] **Step 3: Run the targeted tests and verify RED**

Run:

```bash
pnpm run test -- tests/config.test.ts tests/credentials.test.ts
```

Expected: FAIL because `mode`, `manualChrome`, runtime limits, and manual target encryption do not exist.

- [x] **Step 4: Add discriminated request and queued config types**

In `src/types/config.ts`, introduce:

```ts
export type AuditMode = "static" | "manual-tabs";
export type ManualEvidenceMode = "none" | "html";
export type ManualCachePolicy = "preserve-profile";

export interface ManualChromeSelection {
  scanId: string;
  targetIds: string[];
  cachePolicy: ManualCachePolicy;
  evidenceMode: ManualEvidenceMode;
}

export interface ManualChromeTargetDescriptor {
  targetId: string;
  profileSessionId: string;
  ownerNonce: string;
  serverInstanceId: string;
  auditUrl: SecretValue;
  displayUrl: string;
  selectedAt: string;
}
```

Keep the public parsed request separate from the queued job config:

- `StaticAuditRequest`
- `ManualTabsAuditRequest`
- `ParsedAuditRequest`
- `StaticAuditConfig`
- `ManualTabsAuditConfig`
- `AuditConfig`

The manual request contains `scanId` and `targetIds`; the queued config contains resolved immutable `targets`, derived `baseUrl`, generated `paths`, and disabled auth objects.

- [x] **Step 5: Implement mode-aware validation**

Update `parseAuditRequest()` so:

- omitted `mode` becomes `static`,
- existing static payload behavior remains unchanged,
- manual mode accepts only shared Lighthouse settings plus `manualChrome`,
- manual mode forbids `baseUrl`, `paths`, `environments`, `basicAuth`, and `formLogin` as authority,
- target IDs are trimmed, unique, and bounded,
- the parser returns new arrays and nested objects instead of reusing caller-owned references.

- [x] **Step 6: Add runtime settings**

Extend `RuntimeConfig` and `.env.example` with:

```text
MANUAL_CHROME_ENABLED=false
MANUAL_CHROME_PORT=9222
MANUAL_CHROME_PROFILE_DIR=.lh-audit/chrome-profile
MANUAL_CHROME_STARTUP_TIMEOUT_MS=15000
MANUAL_CHROME_MAX_TABS=20
MANUAL_CHROME_MAX_EVIDENCE_FILES=100
MANUAL_CHROME_MAX_EVIDENCE_BYTES=52428800
```

Validate integer ranges. Reuse `ALLOWED_HOSTS` as the explicit manual tab allowlist and reject manual enablement when it is empty. The API generates a fresh random boot identity on startup, stores it in Redis, and invalidates any prior session record; workers load that current boot identity when a manual job starts.

- [x] **Step 7: Encrypt and redact manual target URLs**

Update `encryptJobConfig()` and `decryptJobConfig()` to encrypt/decrypt one authenticated manual execution envelope containing raw audit URLs, profile ownership nonce, lock owner token, and fencing metadata. Serialized queue data must contain none of those sensitive values.

Update `redactAuditConfig()` so persisted/job-detail config includes:

- `mode`,
- manual cache/evidence mode,
- selected sanitized display URLs and generated labels,
- no raw `auditUrl`,
- no profile nonce, CDP URL, or owner token.

- [x] **Step 8: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/config.test.ts tests/credentials.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/types/config.ts src/config/audit-config.ts src/config/safe-audit-config.ts src/config/env.ts src/security/credentials.ts .env.example tests/config.test.ts tests/credentials.test.ts
git commit -m "feat: add manual tabs audit config"
```

### Task 2: Add Manual Chrome Access Control, URL Sanitization, And Redis State

**Files:**
- Create: `src/manual-chrome/types.ts`
- Create: `src/manual-chrome/access-control.ts`
- Create: `src/manual-chrome/redis-store.ts`
- Test: `tests/manual-chrome-access.test.ts`
- Test: `tests/manual-chrome-store.test.ts`

- [x] **Step 1: Write failing access-control tests**

Cover:

- loopback socket addresses: `127.0.0.1`, `::1`, IPv4-mapped loopback,
- allowed `Host`: `localhost`, `127.0.0.1`, `[::1]` with optional ports,
- same-origin loopback `Origin` and `Referer`,
- ignored `X-Forwarded-*` headers,
- rejected LAN/public host values,
- unsupported URL schemes,
- sanitized `displayUrl = origin + pathname`,
- `hasHiddenUrlParts` for query strings and fragments,
- host allowlist checks for initial URLs and redirect hops.

- [x] **Step 2: Write failing Redis state tests**

Use an in-memory Redis fake that supports the exact operations used by the store. Assert:

- session records expire,
- scan snapshots are immutable and expire after 10 minutes,
- `SET NX` permits one manual lock,
- queued-to-running transition compares owner token and fencing number,
- renew and delete reject stale owners,
- a stale worker cannot delete a newer lock.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/manual-chrome-access.test.ts tests/manual-chrome-store.test.ts
```

Expected: FAIL because the manual Chrome modules do not exist.

- [x] **Step 4: Add operational types**

In `src/manual-chrome/types.ts`, define focused records:

```ts
export interface ManualChromeSessionRecord {
  profileSessionId: string;
  ownerNonce: string;
  serverInstanceId: string;
  port: number;
  profileDir: string;
  processId: number;
  startedAt: string;
  expiresAt: string;
}

export interface ManualChromeScanTab {
  id: string;
  title: string;
  rawUrl: string;
  displayUrl: string;
  hasHiddenUrlParts: boolean;
  valid: boolean;
  redirectHosts: string[];
  reason?: string;
}

export interface ManualChromeLockRecord {
  jobId: string;
  profileSessionId: string;
  ownerToken: string;
  fencingNumber: number;
  state: "queued" | "running";
  expiresAt: string;
}
```

Add stable error codes matching the spec.

- [x] **Step 5: Implement pure access-control helpers**

Create pure functions for:

- request loopback validation,
- loopback CDP endpoint validation,
- manual URL scheme validation,
- display URL sanitization,
- allowlist enforcement,
- sanitized diagnostic URL formatting.

Return new objects and arrays; never mutate request headers, URLs, or scan records.

- [x] **Step 6: Implement Redis session, scan, and fenced-lock operations**

Use namespaced keys such as:

```text
manual-chrome:session
manual-chrome:scan:<scanId>
manual-chrome:lock:<profileSessionId>
manual-chrome:fence:<profileSessionId>
```

Use Redis atomic operations or Lua scripts for compare-and-set, compare-and-renew, and compare-and-delete. Do not implement ownership checks as separate `GET` then `DEL` calls.

- [x] **Step 7: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/manual-chrome-access.test.ts tests/manual-chrome-store.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/manual-chrome tests/manual-chrome-access.test.ts tests/manual-chrome-store.test.ts
git commit -m "feat: add manual chrome state controls"
```

### Task 3: Launch, Verify, And Scan The App-Owned Chrome Profile

**Files:**
- Create: `src/manual-chrome/session-manager.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Test: `tests/manual-chrome-session.test.ts`
- Test: `tests/server-app.test.ts`

- [x] **Step 1: Write failing session-manager tests**

Mock Chrome Launcher and Puppeteer to cover:

- headed Chrome launch with the configured profile directory and loopback debugging port,
- port-in-use rejection instead of attaching to an unknown CDP instance,
- marker target creation using `ownerNonce`,
- Redis session record renewal while the launched process is alive,
- marker/session verification before scan,
- server-instance mismatch after restart fails closed,
- API restart replaces the Redis boot identity and invalidates the previous session even if its marker still exists,
- simultaneous session starts are atomic: one launch wins and the other receives `MANUAL_CHROME_STARTING`,
- the marker is excluded from scan results and never logs or returns the ownership nonce,
- Chrome is not killed after a successful scan.

- [x] **Step 2: Write failing API tests**

Add Fastify injection tests for:

```http
POST /manual-chrome/session
POST /manual-chrome/tabs/scan
```

Assert:

- CSRF required,
- loopback socket/Host/Origin rules,
- `Cache-Control: no-store`,
- stable `{error, code}` bodies,
- disabled mode returns `403`,
- busy profile returns `409`,
- scan response contains count, valid tabs, skipped tabs, `scanId`, and `expiresAt`,
- raw query strings, fragments, cookies, storage, headers, and request bodies never appear in the response.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/manual-chrome-session.test.ts tests/server-app.test.ts
```

Expected: FAIL because the session service and routes are missing.

- [x] **Step 4: Implement the profile session manager**

`session-manager.ts` should expose a narrow interface:

```ts
export interface ManualChromeService {
  status(): Promise<ManualChromeStatus>;
  ensureSession(): Promise<ManualChromeStatus>;
  scanTabs(): Promise<ManualChromeScanResponse>;
  verifyOwnedSession(expected: ManualChromeOwnership): Promise<ManualChromeSessionRecord>;
}
```

Launch Chrome headed with:

- configured executable,
- `--remote-debugging-address=127.0.0.1`,
- configured port,
- configured user data directory,
- no headless flag,
- a no-store local marker target opened after launch. Keep the nonce outside server logs and exclude the marker target completely from scans.

Connect with Puppeteer only to `http://127.0.0.1:<port>`.

- [x] **Step 5: Implement safe tab scanning**

Scan `browser.pages()` and build ownership-bound server-side snapshots containing the profile session ID, boot identity, raw URLs, sanitized display URLs, target IDs, titles, skip reasons, and known redirect hosts.

The API response must omit `rawUrl` and redirect details. Skip internal schemes and apply the shared `ALLOWED_HOSTS` allowlist before a tab becomes selectable.

- [x] **Step 6: Register manual endpoints**

Extend `BuildAppOptions` with a `manualChrome` dependency and a simple capability flag for `/healthz`.

Register routes before the SPA wildcard:

- `POST /manual-chrome/session`
- `POST /manual-chrome/tabs/scan`

Reuse CSRF and rate limiting, then add manual-specific loopback enforcement.

- [x] **Step 7: Wire the service at server startup**

Instantiate the service in `src/server/index.ts` with:

- Redis store,
- Chrome path,
- manual runtime settings,
- shared allowed hosts,
- data directory,
- the deployment instance ID.

Generate the boot identity in the API startup path and persist it with the session store. Worker startup must not invent a separate identity.

Ensure shutdown stops the renewal timer but does not automatically close the dedicated Chrome profile.

- [x] **Step 8: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/manual-chrome-session.test.ts tests/server-app.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/manual-chrome/session-manager.ts src/server/app.ts src/server/index.ts tests/manual-chrome-session.test.ts tests/server-app.test.ts
git commit -m "feat: add manual chrome session scanning"
```

### Task 4: Resolve Manual Job Targets And Acquire The Profile Lock

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/manual-chrome/redis-store.ts`
- Modify: `src/types/config.ts`
- Test: `tests/server-app.test.ts`
- Test: `tests/manual-chrome-store.test.ts`

- [x] **Step 1: Write failing manual job submission tests**

Add `POST /jobs` tests that cover:

- valid `manual-tabs` request,
- unknown/expired `scanId`,
- target ID not present in the snapshot,
- empty or disallowed host allowlist,
- known disallowed redirect host,
- non-loopback caller,
- another queued/running manual job,
- evidence count limit,
- enqueue failure after lock creation.

Assert the enqueued config contains encrypted target descriptors and no raw URL text.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/server-app.test.ts tests/manual-chrome-store.test.ts
```

Expected: FAIL because manual request resolution and lock acquisition do not exist.

- [x] **Step 3: Resolve scan selections atomically**

In the manual branch of `POST /jobs`:

1. enforce manual access control,
2. parse the public request,
3. load the non-expired scan snapshot,
4. verify the current session record and marker still match the ownership-bound snapshot,
5. resolve selected IDs only from that snapshot,
6. verify every raw URL and known redirect host,
7. derive `baseUrl` from the first selected origin,
8. generate unique labels such as `/manual-tabs/01-checkout`,
9. create immutable target descriptors,
10. encrypt the manual execution envelope before enqueueing.

- [x] **Step 4: Acquire a queued lock before enqueue**

Create a lock with:

- generated job ID,
- profile session ID,
- unguessable owner token,
- incremented fencing number,
- `queued` state,
- pending TTL.

Store the owner token/fencing metadata needed by the worker only inside the encrypted execution envelope.

- [x] **Step 5: Release correctly on enqueue failure**

Wrap queue insertion so failure invokes compare-and-delete with the same owner token and fencing number. Never delete a lock based only on profile session ID.

- [x] **Step 6: Preserve the static submission path**

Keep existing static parsing, host validation, credential encryption, queue options, response shape, and tests unchanged except for the explicit default `mode: "static"`.

- [x] **Step 7: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/server-app.test.ts tests/config.test.ts tests/credentials.test.ts tests/manual-chrome-store.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/server/app.ts src/manual-chrome/redis-store.ts src/types/config.ts tests/server-app.test.ts tests/manual-chrome-store.test.ts
git commit -m "feat: enqueue manual tab audit jobs"
```

### Task 5: Run Lighthouse Against Existing Tabs With Fenced Lock Renewal

**Files:**
- Create: `src/lighthouse/run-manual-tab.ts`
- Modify: `src/worker/audit-worker.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/progress.ts`
- Modify: `src/manual-chrome/session-manager.ts`
- Modify: `src/manual-chrome/redis-store.ts`
- Test: `tests/manual-tab-runner.test.ts`
- Test: `tests/audit-worker-process.test.ts`
- Test: `tests/audit-worker.test.ts`
- Test: `tests/progress.test.ts`

- [x] **Step 1: Write failing manual page-runner tests**

Mock Lighthouse and Puppeteer `Page` objects. Assert:

- the runner receives the frozen `auditUrl`,
- the selected page is passed to Lighthouse,
- `disableStorageReset: true`,
- shared categories, desktop/mobile form-factor settings, and mobile throttling are preserved,
- each run starts from the original frozen URL,
- main-frame redirect hops outside the allowlist are aborted,
- final Lighthouse URLs are revalidated before results are accepted,
- sanitized errors never expose query strings or fragments,
- the runner does not disconnect or close the browser/page; the worker owns the single job-level connection.

- [x] **Step 2: Write failing worker tests**

Cover:

- static jobs still call `runOnceLighthouse`,
- manual jobs verify the session record and marker target,
- manual jobs claim queued lock as running,
- running lock renews periodically,
- renewal failure or replacement by a newer fenced lock aborts the active run and prevents further navigation,
- missing target adds diagnostics and continues,
- stale owner token/fencing fails the job before CDP connection,
- Chrome closing mid-job produces diagnostics,
- lock release is owner/fencing checked on success and failure,
- all-runs-failed behavior still includes the first useful error.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/manual-tab-runner.test.ts tests/audit-worker-process.test.ts tests/audit-worker.test.ts tests/progress.test.ts
```

Expected: FAIL because the manual worker path is missing.

- [x] **Step 4: Implement the existing-page Lighthouse runner**

`run-manual-tab.ts` should:

- receive an already-connected browser/page from the worker,
- attach a main-frame navigation allowlist guard,
- call Lighthouse with the page,
- keep storage/profile state,
- remove listeners/interception after each run,
- validate final Lighthouse URLs,
- sanitize every surfaced URL/error,
- never disconnect or close Chrome or the selected page.

- [x] **Step 5: Branch worker processing by mode**

Keep `processAuditJob()` as the public entry point and delegate:

```ts
if (config.mode === "manual-tabs") {
  return processManualTabsAuditJob(job, config, options);
}
return processStaticAuditJob(job, config, options);
```

The static function should contain the existing implementation with behavior unchanged.

- [x] **Step 6: Reuse route aggregation and reporting**

For each selected target and form factor:

- resolve the page by target ID,
- use the generated route label and sanitized display URL,
- call `runRouteAudits`,
- reuse `extractFormFactorReport`,
- emit progress with the sanitized display URL,
- continue after target-level failures,
- fail the whole job only when no run succeeds.

- [x] **Step 7: Add lock lifecycle handling**

Before connecting:

- compare-and-set queued lock to running,
- verify profile session, nonce, instance ID, and marker,
- start a renewal timer.

If renewal fails or the fencing owner changes, signal cancellation to the active runner, abort the current navigation, skip all remaining runs, and fail closed.

In `finally`:

- stop renewal,
- disconnect Puppeteer,
- compare-and-delete the lock with owner token and fencing number.

- [x] **Step 8: Wire worker startup**

Pass the manual runtime config, allowed hosts, Redis store, and shared deployment instance ID from `src/worker/index.ts`.

- [x] **Step 9: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/manual-tab-runner.test.ts tests/audit-worker-process.test.ts tests/audit-worker.test.ts tests/progress.test.ts tests/route-runner.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add src/lighthouse/run-manual-tab.ts src/worker/audit-worker.ts src/worker/index.ts src/worker/progress.ts src/manual-chrome/session-manager.ts src/manual-chrome/redis-store.ts tests/manual-tab-runner.test.ts tests/audit-worker-process.test.ts tests/audit-worker.test.ts tests/progress.test.ts
git commit -m "feat: audit authenticated chrome tabs"
```

### Task 6: Preserve Report Structure And Enforce Manual Evidence Privacy

**Files:**
- Modify: `src/types/report.ts`
- Modify: `src/report/workbook.ts`
- Modify: `src/worker/report-files.ts`
- Modify: `src/server/app.ts`
- Test: `tests/report.test.ts`
- Test: `tests/report-files.test.ts`
- Test: `tests/server-app.test.ts`

- [x] **Step 1: Write failing report tests**

Add a manual-tabs report fixture and assert:

- Summary uses generated route labels and sanitized URLs,
- Run Configuration includes `Audit mode: Manual Chrome Tabs`,
- auth summary says manual browser authentication,
- cache policy and evidence mode appear,
- no raw query strings/fragments are stored,
- static workbook sheets remain unchanged.

- [x] **Step 2: Write failing evidence-limit tests**

Assert:

- `evidenceMode: "none"` writes no HTML evidence,
- `evidenceMode: "html"` writes successful runs only,
- file-count limit rejects submission,
- an oversized generated HTML file is deleted and recorded as a diagnostic,
- `meta.json` never contains raw manual `auditUrl` values.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/report.test.ts tests/report-files.test.ts tests/server-app.test.ts
```

Expected: FAIL because the report model and evidence writer are not mode-aware.

- [x] **Step 4: Extend report metadata**

Add mode-specific fields to `AuditReport`:

```ts
mode: AuditMode;
cachePolicy?: ManualCachePolicy;
evidenceMode?: ManualEvidenceMode;
```

Keep `RouteReport` compatible by using generated route labels and sanitized `url`.

- [x] **Step 5: Update workbook generation**

Add mode/cache/evidence rows to `Run Configuration`. Do not add tab titles. Preserve existing sheet order and formulas for static and compare jobs.

- [x] **Step 6: Add evidence policy controls**

Extend `writeReportFiles()` options with:

- evidence mode,
- maximum files,
- maximum HTML bytes.

Skip manual evidence by default. When enabled, write each file to a temporary path, check size, rename only if within limit, and add a diagnostic instead of returning an oversized link.

- [x] **Step 7: Persist safe manual metadata**

Persist mode, sanitized selected targets, cache policy, evidence mode, summary, and evidence links. Keep queue-only target IDs, raw URLs, owner tokens, nonce, and session internals out of `meta.json`, history, and detail responses.

- [x] **Step 8: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/report.test.ts tests/report-files.test.ts tests/server-app.test.ts
pnpm run typecheck
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/types/report.ts src/report/workbook.ts src/worker/report-files.ts src/server/app.ts tests/report.test.ts tests/report-files.test.ts tests/server-app.test.ts
git commit -m "feat: report manual tab audits safely"
```

### Task 7: Add The Manual Chrome Tabs Mode To The Existing Web UI

**Files:**
- Create: `web/src/manual-chrome.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/job-detail.ts`
- Modify: `web/src/job-history.ts`
- Modify: `web/src/JobHistory.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/app-manual-chrome.test.ts`
- Test: `tests/app-job-detail.test.ts`
- Test: `tests/app-job-history.test.ts`

- [x] **Step 1: Write failing pure UI-state tests**

In `tests/app-manual-chrome.test.ts`, assert:

- selecting manual mode clears static credential authority,
- valid scans create immutable selectable tab state,
- expired scans disable submission,
- no selected tabs disables submission,
- HTML mode requires explicit consent,
- built payload contains `mode`, `scanId`, selected IDs, cache policy, evidence mode, and no base URL/auth fields.

- [x] **Step 2: Write failing hydration/history tests**

Extend job detail/history fixtures so:

- manual jobs reopen in `Manual Chrome Tabs` mode,
- safe selected display URLs are shown,
- history exposes a `Manual Chrome Tabs` badge,
- static jobs continue to hydrate as `Static LP Audit`.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm run test -- tests/app-manual-chrome.test.ts tests/app-job-detail.test.ts tests/app-job-history.test.ts
```

Expected: FAIL because manual UI state and payload helpers do not exist.

- [x] **Step 4: Add pure manual UI helpers**

Create `web/src/manual-chrome.ts` with:

- API response types,
- immutable scan-state derivation,
- selected-target toggling,
- scan expiry calculation,
- manual payload builder,
- consent/submission validation.

Keep browser calls in `App.tsx` and logic in the helper module so the existing Node Vitest environment can test the behavior without adding DOM infrastructure.

- [x] **Step 5: Add the mode switch and capability check**

At the top of the audit workspace, render:

- `Static LP Audit`
- `Manual Chrome Tabs`

Read the manual capability from `/healthz`; hide the manual option when disabled.

- [x] **Step 6: Implement the manual profile and scan flow**

In manual mode:

- show setup guidance,
- `Open Chrome profile` calls `POST /manual-chrome/session`,
- `Scan tabs` calls `POST /manual-chrome/tabs/scan`,
- show total tab count, valid selectable tabs, skipped tabs and reasons,
- show scan expiry/busy/error state,
- keep shared display name, form factors, categories, runs, and throttling controls.

- [x] **Step 7: Implement privacy and navigation warnings**

Hide Basic Auth and Form Login fields. Show:

- Lighthouse may reload or navigate selected tabs,
- URLs with OTP/reset/session tokens in query strings or fragments should not be audited,
- HTML evidence can persist authenticated content.

Default to no HTML evidence and require a separate consent checkbox when HTML evidence is selected.

- [x] **Step 8: Submit through the shared job flow**

Keep the existing CSRF fetch, `POST /jobs`, SSE subscription, result links, history navigation, and job detail route. Branch only the payload builder and form validity.

- [x] **Step 9: Style the new controls**

Add focused styles for:

- mode segmented control,
- profile status,
- tab count,
- selectable tab rows,
- skipped tab list,
- evidence warning,
- busy/expired states.

Preserve the existing responsive layout and visual language.

- [x] **Step 10: Re-run tests and verify GREEN**

Run:

```bash
pnpm run test -- tests/app-manual-chrome.test.ts tests/app-job-detail.test.ts tests/app-job-history.test.ts
pnpm run typecheck
pnpm run build:web
```

Expected: PASS.

- [x] **Step 11: Commit**

```bash
git add web/src/manual-chrome.ts web/src/App.tsx web/src/job-detail.ts web/src/job-history.ts web/src/JobHistory.tsx web/src/styles.css tests/app-manual-chrome.test.ts tests/app-job-detail.test.ts tests/app-job-history.test.ts
git commit -m "feat: add manual chrome tabs web mode"
```

### Task 8: Document, Review, And Verify The Complete Feature

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/plans/2026-06-11-manual-chrome-tabs-audit.md`

- [x] **Step 1: Document local setup**

Add README instructions for:

- local-only/manual-mode security model,
- shared deployment instance ID for API and worker,
- `ALLOWED_HOSTS`,
- dedicated Chrome profile directory,
- opening the profile, completing OTP manually, scanning tabs, and running audits,
- evidence privacy warning,
- recovery after server restart or Chrome ownership failure.

- [x] **Step 2: Run the targeted regression suite**

Run:

```bash
pnpm run test -- tests/config.test.ts tests/credentials.test.ts tests/manual-chrome-access.test.ts tests/manual-chrome-store.test.ts tests/manual-chrome-session.test.ts tests/server-app.test.ts tests/manual-tab-runner.test.ts tests/audit-worker-process.test.ts tests/report-files.test.ts tests/report.test.ts tests/app-manual-chrome.test.ts tests/app-job-detail.test.ts tests/app-job-history.test.ts
```

Expected: PASS.

- [x] **Step 3: Run the full verification suite**

Run:

```bash
pnpm run test
pnpm run typecheck
pnpm run build
git diff --check
```

Expected: all commands PASS with no whitespace errors.

- [x] **Step 4: Run a static-flow regression smoke test**

Start the server and worker with manual mode disabled, submit a normal static LP audit, and confirm:

- existing form fields remain available,
- static job queues and streams progress,
- workbook and HTML evidence links still work,
- history/detail round-trip remains intact.

- [x] **Step 5: Run manual Chrome acceptance**

With manual mode enabled and the same `MANUAL_CHROME_SERVER_INSTANCE_ID` for API and worker:

1. open the dedicated Chrome profile,
2. complete OTP/login manually in two allowed-host tabs,
3. scan and select both tabs,
4. run desktop and mobile with `runsPerPage = 1`,
5. confirm progress names sanitized URLs,
6. confirm Chrome remains open,
7. confirm workbook download,
8. repeat with explicit HTML evidence consent,
9. confirm sensitive query/fragment text is absent from UI, history, workbook, logs, and `meta.json`.

- [x] **Step 6: Run focused security review**

Review:

- loopback enforcement without proxy-header trust,
- CDP binding,
- raw URL encryption/redaction,
- lock owner/fencing comparisons,
- allowlist checks on scan, submit, and redirects,
- evidence count/byte limits,
- log redaction.

- [x] **Step 7: Update the plan checkboxes and commit documentation**

```bash
git add README.md .env.example docs/superpowers/plans/2026-06-11-manual-chrome-tabs-audit.md
git commit -m "docs: document manual chrome tabs audits"
```
