# Manual Chrome Tabs Audit Design

## Status

Draft after first review fixes.

## Context

The current Lighthouse Audit Tool is optimized for static landing pages and scripted form login. Each run launches a fresh Chrome instance, optionally performs Basic Auth or form login, runs Lighthouse, and then closes Chrome. That works for LP/static pages, but it does not work reliably for pages that require OTP, user-specific verification states, or browser/profile-specific authenticated state.

The new requirement is a separate manual-auth workflow inside the existing web UI:

- Users open a dedicated Chrome profile for performance testing.
- Users manually complete OTP/login/verification in that browser.
- Users leave the verified pages open as tabs.
- The tool scans the open tabs in that Chrome profile.
- The tool runs Lighthouse sequentially against selected tabs.
- The browser/profile stays open after runs so the verified state can be reused.

The existing static LP audit flow remains available and keeps its current behavior.

## Goals

1. Add a new UI mode named `Manual Chrome Tabs` alongside the existing static audit form.
2. Let the user scan the currently open tabs in a dedicated Chrome profile.
3. Show the number of detected tabs and a selectable tab list with title, URL, and validity status.
4. Let the user run the existing median-of-N Lighthouse workflow against selected tabs.
5. Keep Chrome and its profile open after scans and audit jobs.
6. Reuse existing report generation, workbook export, optional HTML evidence, progress events, queueing, and result extraction.
7. Avoid reading or exporting cookies, local storage, passwords, OTPs, or session data.

## Non-Goals

- The tool will not automate OTP entry.
- The tool will not manage credentials for this mode.
- The tool will not inspect browser cookies, local storage, IndexedDB, passwords, or session stores.
- The tool will not replace the current static LP audit flow.
- The first implementation will not support cross-machine Chrome control.

## Recommended Architecture

Use one audit pipeline with two input modes:

- `static`: current behavior. The worker launches a fresh headless Chrome per run and closes it.
- `manual-tabs`: new behavior. The worker connects to a persistent local Chrome profile through CDP and audits selected open tabs.

The new mode should be explicit in the job config instead of inferred from auth fields. This keeps the static and manual-auth paths understandable and prevents accidental use of a user's real browser state.

```ts
type AuditMode = "static" | "manual-tabs";

interface ManualChromeConfig {
    scanId: string;
    targetIds: string[];
    cachePolicy: "preserve-profile";
    evidenceMode: "none" | "html";
}
```

The exact TypeScript shape can be refined during implementation, but the public contract should preserve those concepts: mode, scan ID, selected target IDs, cache policy, and no credential fields.

## Job Contract

The current `POST /jobs` payload remains the contract for `static` mode. If `mode` is omitted, the server treats the request as `static` for backward compatibility.

Manual mode has its own payload shape and does not require `baseUrl`, `paths`, `environments`, `basicAuth`, or `formLogin` from the UI:

```json
{
    "mode": "manual-tabs",
    "displayName": "Manual authenticated checkout flow",
    "formFactors": ["desktop", "mobile"],
    "categories": ["performance", "accessibility", "best-practices", "seo"],
    "runsPerPage": 3,
    "throttling": { "preset": "slow-4g" },
    "manualChrome": {
        "scanId": "scan_abc123",
        "targetIds": ["target-1", "target-2"],
        "cachePolicy": "preserve-profile",
        "evidenceMode": "none"
    }
}
```

The server resolves `scanId` and `targetIds` during `POST /jobs`, before enqueueing the job. The queued job must contain encrypted immutable target descriptors, not a pointer to the scan snapshot. The worker must not depend on scan snapshot storage.

The client must not submit title or URL as authority. Titles and URLs in the UI are display metadata only.

Manual mode derivation rules:

- `baseUrl` is derived from the first selected tab origin for existing report metadata compatibility.
- `paths` is not user-entered. The worker builds one internal route label per selected tab.
- `environments` and environment compare are disabled for the first release.
- `basicAuth` and `formLogin` are forced to disabled.
- Duplicate pathnames across tabs are allowed. Route identity uses a unique generated label, for example `/01-checkout`, while the report also displays the sanitized tab URL.
- A manual job is rejected if the scan snapshot has expired or if no selected target IDs are still valid.
- A manual job is rejected if another manual job is pending or running for the profile.

Scan snapshots are short-lived server-side UI selection aids only. They contain target ID, title, raw URL, sanitized display URL, validity, skip reason, and `expiresAt`. A 10-minute TTL is enough because snapshots are resolved atomically at job submission. Snapshot cleanup can happen opportunistically after scans and job submissions.

Queued manual target descriptor:

```ts
interface ManualChromeTargetDescriptor {
    targetId: string;
    profileSessionId: string;
    ownerNonce: string;
    serverInstanceId: string;
    auditUrl: string; // raw URL frozen at job submission
    displayUrl: string; // sanitized origin + pathname for UI/report metadata
    title?: string; // UI-only unless title reporting is explicitly enabled later
    selectedAt: string;
}
```

The descriptors live inside the encrypted job config that the worker already decrypts. This avoids cross-process scan snapshot dependencies and prevents snapshot expiry while a job waits in the queue. Raw `auditUrl` values are allowed in encrypted queued job config until the job reaches a terminal state and BullMQ removes it according to existing queue retention settings. They must not be copied into unencrypted logs, workbook metadata, or diagnostics.

## Chrome Profile Model

The system uses a dedicated local Chrome profile for performance testing. The first release is local-only and is disabled in Docker/shared deployments.

Default profile directory:

```text
.lh-audit/chrome-profile
```

Default CDP endpoint:

```text
http://127.0.0.1:9222
```

Default launch command shape:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=.lh-audit/chrome-profile
```

The backend owns the profile lifecycle for the first release:

1. The UI exposes an `Open Chrome profile` action.
2. The backend launches Chrome with the configured profile directory and CDP port.
3. The backend generates `profileSessionId` and `ownerNonce`, records the launched process, and writes a Redis session record.
4. If the configured port is already in use before launch, the backend does not attach to it. It returns a clear error telling the operator to close that Chrome instance or choose another port.
5. If the server restarts while Chrome remains open, the app treats that browser as unowned. The user must close it and click `Open Chrome profile` again.
6. The backend never closes Chrome after scan or audit.
7. The operator may close Chrome manually when finished.

App-owned profile verification:

- The session record contains `profileSessionId`, `ownerNonce`, `serverInstanceId`, CDP port, profile directory, launched process ID, `startedAt`, and `expiresAt`.
- The API server renews the session record while the launched process is alive.
- Immediately after launch, the server opens one marker target whose URL includes the unguessable `ownerNonce`, for example `/manual-chrome/marker/<ownerNonce>`.
- Scan and worker code must verify both the Redis session record and the marker target before trusting the CDP endpoint.
- If the marker target is missing, the owner nonce differs, the session record expired, the worker's local `MANUAL_CHROME_SERVER_INSTANCE_ID` does not match the session record, or the session record server instance ID is stale, the browser is treated as unowned and manual operations fail closed.
- This verification happens after Chrome launch too, so a check-to-launch port race becomes a failed unowned-session check rather than an accidental attach.

Configuration:

- `MANUAL_CHROME_ENABLED=true` enables the mode for local loopback use.
- `MANUAL_CHROME_PORT` overrides `9222`.
- `MANUAL_CHROME_PROFILE_DIR` overrides `.lh-audit/chrome-profile`.
- `MANUAL_CHROME_STARTUP_TIMEOUT_MS` controls startup wait time, default `15_000`.
- `MANUAL_CHROME_SERVER_INSTANCE_ID` identifies the running API/worker deployment instance and must be generated at process startup.
- `MANUAL_CHROME_MAX_TABS` controls selected tab count, default `20`.
- `MANUAL_CHROME_MAX_EVIDENCE_FILES` controls HTML evidence count, default `100`.
- `MANUAL_CHROME_MAX_EVIDENCE_BYTES` controls per-file HTML evidence size, default `50 MiB`.
- Manual mode also requires a non-empty allowed-host allowlist for selected tab URLs.

Only app-owned loopback CDP sessions are accepted. The UI should hide manual mode when `MANUAL_CHROME_ENABLED` is not active.

## UI Flow

The existing web app gets a mode switch:

- `Static LP Audit`
- `Manual Chrome Tabs`

In `Manual Chrome Tabs` mode:

1. The user sees setup guidance:
    - Click `Open Chrome profile` if it is not already running.
    - Manually complete OTP/login/verification in each target tab.
    - Leave each target page open.
    - Return to the tool and click `Scan tabs`.
2. `Scan tabs` calls the backend and displays:
    - total open tabs detected,
    - selectable valid tabs,
    - skipped tabs with reasons.
3. The user selects tabs to audit.
4. The user configures shared Lighthouse settings:
    - form factors,
    - categories,
    - runs per page,
    - throttling.
5. The user chooses evidence mode:
    - `No HTML evidence` by default,
    - `Generate HTML evidence` only after an explicit authenticated-content warning.
6. The user starts the audit.
7. Progress events should identify the sanitized display URL currently being audited.
8. The final job detail/download view should stay consistent with the existing job flow.

The Basic Auth and Form Login sections should be hidden or disabled in manual-tabs mode because authentication is done by the user in Chrome.

## Backend API

Add a local-only profile ensure endpoint:

```http
POST /manual-chrome/session
```

This endpoint starts the dedicated Chrome profile if it is not already running under the current app process. It requires CSRF protection and returns status metadata only:

```json
{
    "enabled": true,
    "running": true,
    "busy": false,
    "profileSessionId": "profile_abc123",
    "remoteDebuggingUrl": "http://127.0.0.1:9222",
    "profileDir": ".lh-audit/chrome-profile"
}
```

Add a tab scan endpoint:

```http
POST /manual-chrome/tabs/scan
```

Response shape:

```json
{
    "scanId": "scan_abc123",
    "expiresAt": "2026-06-11T10:10:00.000Z",
    "busy": false,
    "remoteDebuggingUrl": "http://127.0.0.1:9222",
    "tabs": [
        {
            "id": "target-id",
            "title": "Account dashboard",
            "displayUrl": "https://example.com/account",
            "hasHiddenUrlParts": false,
            "valid": true
        }
    ],
    "skipped": [
        {
            "id": "target-id",
            "title": "DevTools",
            "displayUrl": "devtools://...",
            "reason": "Unsupported URL scheme"
        }
    ]
}
```

Both manual endpoints require:

- `MANUAL_CHROME_ENABLED=true`.
- The HTTP request socket remote address must be loopback (`127.0.0.1` or `::1`) for the first release. The server must ignore `X-Forwarded-*` headers for this decision.
- The `Host` header must be loopback (`localhost`, `127.0.0.1`, or `[::1]`, with optional port).
- If `Origin` or `Referer` is present, it must also be same-origin loopback.
- Manual mode is not available through LAN hosts, public tunnels, or reverse proxies in the first release.
- CSRF protection.
- Existing request rate limiting or a manual-specific stricter limit.
- `Cache-Control: no-store`.
- No cookies, local storage, headers, request bodies, or browser storage values in responses.

Manual endpoint error bodies use a stable shape:

```json
{
    "error": "Manual Chrome is busy",
    "code": "MANUAL_CHROME_BUSY"
}
```

Common codes include `MANUAL_CHROME_DISABLED`, `MANUAL_CHROME_FORBIDDEN`, `MANUAL_CHROME_BUSY`, `MANUAL_CHROME_PORT_IN_USE`, `MANUAL_CHROME_UNOWNED`, `MANUAL_CHROME_START_TIMEOUT`, `MANUAL_CHROME_UNAVAILABLE`, and `MANUAL_CHROME_INVALID_SELECTION`.

The existing `POST /jobs` endpoint accepts the manual-tabs payload from the Job Contract section. Keeping one job endpoint preserves job history, SSE events, downloads, and report persistence.

Manual `POST /jobs` has extra requirements:

- The request must pass the same loopback enforcement as manual endpoints.
- The server resolves `scanId` and `targetIds` to encrypted target descriptors before enqueueing.
- The server requires a non-empty allowed-host allowlist for manual mode and enforces it against every selected raw tab URL.
- The server rejects any selected target whose redirect chain is known to contain a disallowed host from prior scan metadata.
- The server rejects the job with `409` if another manual job is pending or running for the profile.
- The server rejects `evidenceMode: "html"` if the estimated evidence file count exceeds `MANUAL_CHROME_MAX_EVIDENCE_FILES`.
- If enqueueing fails after lock creation, the server releases the lock only when its owner token still matches.
- The response should clearly distinguish validation errors (`400`), disabled mode (`403`), non-loopback caller (`403`), profile busy (`409`), and Chrome unavailable (`503`).

## Worker Flow

For `static` jobs, keep the current worker path unchanged.

For `manual-tabs` jobs:

1. Decrypt and parse the job config.
2. Confirm the encrypted config contains resolved target descriptors.
3. Claim the existing manual profile lock by comparing the owner token from the job config.
4. Verify the Redis session record and marker target match the `profileSessionId` and `ownerNonce` in the encrypted target descriptors.
5. Connect to the app-owned local CDP endpoint with Puppeteer.
6. For each selected tab and form factor:
    - resolve the matching `Page` by selected target ID,
    - navigate through Lighthouse using the frozen `auditUrl` from the target descriptor,
    - run `runsPerPage` sequential Lighthouse runs,
    - pass the `Puppeteer.Page` to Lighthouse,
    - set `disableStorageReset: true`,
    - avoid closing the browser or profile.
7. Map each tab to a route report:
    - `route`: generated unique route label,
    - `url`: sanitized display URL,
    - no tab title by default because titles may contain PII.
8. Reuse `runRouteAudits`, `extractFormFactorReport`, `writeReportFiles`, and `buildAuditWorkbook`.
9. Disconnect Puppeteer after the job but do not close Chrome.
10. Release the per-profile manual audit lock only if the lock owner token still matches.

If a selected tab target is missing at runtime, the worker should mark that tab/form-factor as failed, add a diagnostic that asks the user to rescan tabs, continue with the next tab, and only fail the whole job if no runs succeed.

Only one manual-tabs job can be pending or running per Chrome profile at a time. Static jobs can keep using the existing queue behavior, but manual jobs must not overlap because Lighthouse may navigate shared profile tabs.

Manual lock lifecycle:

- `POST /jobs` creates a Redis lock before enqueueing a manual job using `SET NX`.
- The lock value contains job ID, profile session ID, owner token, fencing number, lock state (`queued` or `running`), and expiration timestamp.
- If lock creation fails because a lock exists, the API returns `409 Profile busy`.
- If enqueueing fails, the API releases the lock with compare-and-delete on owner token.
- The lock has a pending TTL. If it expires before the worker starts, a later manual job may acquire a new lock; the stale queued job must fail closed when its worker starts and sees a missing or different owner token.
- The worker changes lock state from `queued` to `running` with compare-and-set on owner token and fencing number.
- The worker renews the running lock periodically with compare-and-renew on owner token and fencing number.
- The worker releases the lock on success or failure with compare-and-delete on owner token and fencing number.
- A stale worker must never delete or renew a newer lock.
- While a manual lock exists, `POST /manual-chrome/tabs/scan` returns `409 Profile busy`; `POST /manual-chrome/session` may return read-only status but must not relaunch Chrome.

## Lighthouse Behavior

Manual-tabs mode should run Lighthouse against the frozen `auditUrl` resolved at job submission while connected to the selected tab's browser/profile context. This supports pages where auth state is stored in durable browser state such as cookies, local storage, or session storage.

It must not promise to preserve transient JavaScript memory that disappears on reload. Lighthouse navigation audits can reload or navigate the selected tab, so pages that only work because of non-durable in-memory state may need to be prepared again or may need a future non-navigation measurement mode.

The UI must warn users that Lighthouse may reload or navigate the selected tab during measurement. This is acceptable for performance measurement, but it must be visible before the job starts.

Recommended Lighthouse flags for manual-tabs mode:

- `disableStorageReset: true`
- same `onlyCategories` handling as static mode
- same desktop/mobile form factor handling as static mode
- same mobile throttling handling as static mode
- no Basic Auth headers unless a future explicit requirement adds them

The first release uses `cachePolicy: "preserve-profile"`. It preserves browser storage and caches to avoid destroying authenticated state. The report must label this clearly because results are not directly comparable to the current fresh-Chrome static flow. A future `clear-http-cache` option may clear HTTP cache through CDP while preserving cookies/storage, but service worker caches and application-managed caches require separate design.

URL and redirect semantics:

- `auditUrl` is frozen when the server accepts the manual job.
- Each Lighthouse run starts from that frozen `auditUrl`.
- Redirects during a run are allowed and recorded by Lighthouse.
- Every redirect hop must satisfy the manual allowed-host allowlist before navigation continues. If Lighthouse or Puppeteer exposes a disallowed redirect hop, the run fails immediately and the diagnostic uses a sanitized URL.
- A redirect in one run or form factor must not mutate the next run's starting URL; the next run again starts from the frozen `auditUrl`.
- Hash-only or query-parameter changes caused by the page after load are treated as runtime behavior, not as target drift.
- If the original target tab is closed, the target fails; if it remains open but is at another URL before the worker starts, the worker still audits the frozen `auditUrl` in that same tab/profile context.

## Validation And Security

Validation rules:

- `mode` defaults to `static` for backward compatibility.
- `manual-tabs` requires at least one selected valid tab.
- `manual-tabs` requires a non-expired `scanId`.
- `manual-tabs` accepts target IDs only from the server-side scan snapshot.
- `manual-tabs` accepts only app-owned local Chrome profile sessions.
- Manual endpoints and manual job submission require loopback socket remote addresses plus loopback `Host` and same-origin loopback `Origin`/`Referer` when present.
- Selected tab URLs must use `http:` or `https:`.
- Manual mode requires an explicit non-empty allowed-host allowlist, and selected tab URLs plus final redirected URLs must pass it.
- Manual mode must reject a redirect chain as soon as any hop leaves the allowed-host allowlist.
- Internal URL schemes are skipped:
    - `chrome:`
    - `devtools:`
    - `about:`
    - `edge:`
    - `file:`
    - `data:`

Security rules:

- Manual Chrome mode is disabled unless explicitly enabled by environment configuration.
- Manual Chrome mode is intended for local single-user operation. Shared, tunneled, or production deployments must keep it disabled for the first release.
- Manual endpoints and manual job submission must reject non-loopback callers even if they have a CSRF token.
- The server must not trust proxy headers for manual-mode access control.
- Do not return cookies, local storage, IndexedDB, passwords, headers, or request bodies from the tab scan endpoint.
- Do not return raw query strings or fragments in scan responses. Use `displayUrl = origin + pathname` and `hasHiddenUrlParts = true` when query or fragment exists.
- Do not log selected tab raw URLs, query strings, or fragments.
- Do not expose CDP beyond loopback.
- Do not allow arbitrary remote debugging URLs from unauthenticated external clients in production deployments.

URL redaction policy:

- The UI, job metadata, workbook route labels, and diagnostics use sanitized display URLs by default.
- The server may retain raw URLs only inside the short-lived scan snapshot, encrypted queued manual target descriptors, and worker runtime state for validation and Lighthouse navigation.
- Lighthouse HTML evidence may include authenticated-page screenshots, DOM-derived details, network URLs, raw requested URLs, and final URLs from the Lighthouse result.
- Manual mode defaults to `evidenceMode: "none"`.
- `evidenceMode: "html"` requires explicit UI consent that authenticated page content may be written to disk and exposed through existing tokenized evidence downloads.
- Manual HTML evidence uses the existing evidence endpoint behavior. Evidence tokens are reusable while valid; they are not one-time downloads.
- Existing data-dir cleanup still applies, but it does not make evidence safe for sensitive pages.
- Manual HTML evidence has per-file byte and total file count limits. If a generated evidence file exceeds the byte limit, the worker deletes that evidence file, records a diagnostic, and continues the job without that evidence link.
- The UI must warn the user not to audit URLs containing OTPs, password reset tokens, or one-time session tokens in query strings or fragments.
- Tab titles may contain PII. Manual reports should omit tab titles by default and use sanitized display URLs plus generated labels. Title reporting can be a future explicit opt-in.

## Reporting

Reports should preserve the current workbook and evidence structure. For manual-tabs mode:

- `Run Configuration` should show `Audit mode: Manual Chrome Tabs`.
- `Auth summary` should say manual browser authentication was used.
- `Run Configuration` should show `Cache policy: preserve profile`.
- `Run Configuration` should show `Evidence mode: none` or `html`.
- Each selected tab should appear as a route row using a generated unique route label plus sanitized display URL.
- Diagnostics should include tab resolution errors and unsupported URL skips.
- HTML evidence should be generated per successful run only when `evidenceMode: "html"`.

## Error Handling

Expected errors and behavior:

- Chrome profile not running: tab scan returns a clear setup error.
- CDP endpoint unreachable: tab scan and job fail fast with an actionable message.
- Chrome startup timeout: session endpoint returns `503` with retry guidance.
- Simultaneous `Open Chrome profile` calls: one launch wins; the other returns `409 MANUAL_CHROME_STARTING`.
- No valid tabs: UI disables `Run audit`.
- Selected tab closed before job starts: diagnostic error for that tab; continue other tabs.
- Selected tab URL changed after submit: worker still audits the frozen `auditUrl` if the target exists.
- Another manual job is already pending or running: reject with `409 Profile busy`.
- Chrome closed mid-job: current and remaining manual runs fail with diagnostics; lock is released in the worker failure path or by TTL.
- Server restarted after Chrome launch: existing Chrome is treated as unowned; user must close it and relaunch through the tool.
- Queued manual job starts after its lock expired: worker fails the stale job without touching any newer lock.
- Lighthouse run fails on one run: existing degraded/failed median logic applies.
- All runs fail: existing all-runs-failed behavior applies with the first useful error.

## Testing Plan

Unit tests:

- Parse config with `mode: "static"` default.
- Parse config with `mode: "manual-tabs"`.
- Reject manual-tabs configs with no selected tabs.
- Reject manual-tabs configs with expired or unknown `scanId`.
- Reject non-loopback CDP endpoints.
- Reject non-loopback manual endpoint callers and manual job submissions.
- Reject manual mode when the manual allowed-host allowlist is empty.
- Reject selected tab URLs disallowed by the manual allowed-host allowlist.
- Filter unsupported tab URL schemes.
- Sanitize query strings and fragments from display URLs.
- Resolve scan snapshots to encrypted immutable job target descriptors at submission.
- Preserve immutable config behavior.

Worker tests:

- Static jobs still call the existing `runOnceLighthouse` path.
- Manual-tabs jobs connect to a mocked browser/page provider.
- Manual-tabs jobs pass `disableStorageReset: true`.
- Manual-tabs jobs do not close the browser.
- Missing selected tab produces diagnostics and does not stop other tabs.
- URL drift after submit still starts each run from the frozen `auditUrl`.
- Redirects in one run do not change the next run's starting URL.
- Concurrent manual jobs respect the profile lock.
- Worker renews and releases the manual profile lock.
- Worker crash or failure recovers through lock TTL.
- Stale queued manual jobs fail closed if their lock owner token no longer matches.
- Lock renew and release operations are owner-token/fencing checked.
- Chrome closing mid-job creates diagnostics and releases or expires lock.
- Worker verifies profile session record and marker target before connecting to app-owned Chrome.
- Worker verifies the session record `serverInstanceId` against its own `MANUAL_CHROME_SERVER_INSTANCE_ID` before connecting.
- Redirected final URL host disallowed by manual allowlist marks the run failed.
- Redirect-hop allowlist enforcement blocks navigation before the browser continues to the next hop.

Server/API tests:

- `POST /manual-chrome/session` starts the app-owned dedicated profile.
- `POST /manual-chrome/tabs/scan` returns sanitized tab metadata without storage/session data.
- Manual endpoints are disabled unless `MANUAL_CHROME_ENABLED=true`.
- Manual endpoints use CSRF, rate limiting, and no-store responses.
- Manual endpoints reject non-loopback callers.
- Manual endpoints reject non-loopback Host or Origin/Referer values and ignore proxy headers.
- Unknown pre-existing CDP instances are rejected instead of attached.
- Scan responses include `expiresAt`, busy state, and sanitized URLs.
- Scan snapshot metadata includes redirect-chain host metadata for allowlist enforcement.
- `POST /jobs` accepts manual-tabs payload.
- `POST /jobs` rejects invalid manual-tabs payloads.
- `POST /jobs` rejects manual-tabs payloads from non-loopback callers.
- `POST /jobs` returns `409` while a manual job is pending or running.
- Enqueue failure after lock creation releases the lock only when owner token matches.
- Session-bound scans/jobs fail after server restart invalidates profile ownership.
- Evidence file count and byte limits are enforced.
- Static-flow API, UI, workbook, and evidence behavior remain unchanged.

UI tests:

- Mode switch hides static auth fields in manual-tabs mode.
- `Open Chrome profile` shows running/error state.
- `Scan tabs` displays count, valid tabs, and skipped tabs.
- UI shows scan expiry and profile busy states.
- `Run audit` is disabled until at least one valid tab is selected.
- `Run audit` requires HTML evidence consent only when HTML evidence is enabled.
- Submitted payload contains `mode: "manual-tabs"`, `scanId`, and selected target IDs.

Manual acceptance:

- Open the dedicated Chrome test profile.
- Complete OTP/login manually in two tabs.
- Scan tabs from the UI.
- Select both tabs.
- Run desktop and mobile audits with `runsPerPage = 1`.
- Confirm Chrome remains open after the job.
- Confirm report download is generated.
- Repeat with HTML evidence opt-in and confirm evidence is generated.

## Resolved Decisions And Future Work

Resolved for the first release:

1. The tool owns an `Open Chrome profile` action and rejects already running CDP endpoints it did not launch.
2. The CDP port defaults to `9222` and can be overridden by environment variable, not by arbitrary UI input.
3. Manual-tabs mode is single-profile and single-environment. Compare environments remain static-mode only.

Open for future releases:

- A safe non-navigation measurement mode for pages that depend on transient in-memory state.
- Optional cache-clearing controls that preserve authentication.
- Multi-profile support for comparing manually authenticated states.
