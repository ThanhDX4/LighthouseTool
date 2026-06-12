# Manual Chrome Tabs — Quality Backlog

Deferred refactors from the Task 4 code-quality review (commit `c62eaed`). Address **after** Tasks 5-8 are complete and verified. None are correctness bugs; the behavior is tested and shipping. These are maintainability cleanups.

## Findings

### 1. `handleManualJobSubmission` is too long (~170 lines, 7+ concerns)
File: `src/server/app.ts` (`handleManualJobSubmission`)

Bundles access control, scan lookup, session verification, tab resolution, evidence cap, URL/redirect allowlist checks, descriptor construction, route slug generation, lock acquisition, config assembly, encryption, enqueue, and lock-release-on-failure into one function with nested `try` blocks.

Suggested split (pure helpers + thin orchestrator):
- `buildTargetDescriptors(snapshot, session, parsed, allowedHosts)` → `{ targets, baseUrl } | { error }`
- `buildQueuedConfig(parsed, baseUrl, targets, execution)` (pure)
- `withProfileLock(store, session, jobId, fn)` to encapsulate acquire + release-on-throw

### 2. Duplicated enqueue + response logic between static and manual paths
File: `src/server/app.ts` — static `POST /jobs` path vs `handleManualJobSubmission`

Both call `randomUUID()`, build `{ jobId, config, createdAt }`, call `queue.add(...)` with identical `removeOnComplete`/`removeOnFail`, and return the same 202 envelope. Extract:
- `enqueueAuditJob(queue, encryptionKey, jobId, config): Promise<void>`
- `buildJobAcceptedResponse(jobId, queuePosition)`

Note: the static path does not catch enqueue failures; the shared helper would make that consistent.

### 3. `usedRoutes` Set built but never consulted (dead code)
File: `src/server/app.ts` — `buildManualRoute`

`usedRoutes` is populated but never read; the `NN-` index prefix is what actually guarantees uniqueness. Either consult `usedRoutes.has(route)` for collision handling or drop the Set and parameter entirely.

### 4. `isManualTabsRequest` narrowing is fragile / undocumented
File: `src/server/app.ts` — `isManualTabsRequest`

Relies on `"scanId" in config.manualChrome` to disambiguate request vs queued config shape. Either add a comment explaining the discriminant, or introduce a stronger discriminator field on the parsed type.

## Minor (optional, same review)
- Test queue stubs use `any` extensively — prefer `unknown` + a `QueueStub` helper type.
- `manualDisabledFormLogin` carries real-looking selectors despite `enabled: false` — use placeholder values or document why.
- `MANUAL_CHROME_UNOWNED` re-check branch is structurally unreachable in tests — add a defense-in-depth comment or drop it.
- `src/server/app.ts` exceeds the 800-line ceiling — finding #1's extraction into a `src/manual-chrome/job-submission.ts` module would bring it back under.
