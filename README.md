# Lighthouse Audit Tool

Internal web app for running median-of-N Lighthouse audits across routes and exporting one Excel workbook.

## What Is Implemented

- React + Vite configuration form with optional Basic Auth and form login.
- Fastify API with CSRF protection, request validation, rate limiting, encrypted credentials, SSE progress, and one-time JWT download tokens.
- BullMQ worker with `concurrency: 1`, fresh Chrome per run, form-login cookie preservation via `disableStorageReset`, and `computeMedianRun`.
- ExcelJS workbook with `Summary`, per-route sheets, `Diagnostics`, and `Run Configuration`.
- Docker packaging with Chrome stable, non-root user, Redis AOF via compose, `dumb-init`, and `/healthz`.

## Local Development

```bash
corepack enable
pnpm install
pnpm run dev
pnpm run dev:worker
pnpm run dev:web
```

The Vite UI runs on `http://localhost:5173` and proxies API calls to `http://localhost:3000`.

To run the built tool on `http://localhost:3000`, start both the API server and worker:

```bash
pnpm run build
pnpm start
```

Use `pnpm run start:server` only when you intentionally want the API/static server without processing Lighthouse jobs.

For local development, missing secrets are replaced with dev-only process secrets. Production requires `ENCRYPTION_KEY` and `DOWNLOAD_TOKEN_SECRET`.

## Docker

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up --build
```

Run the container with `--init` and `--shm-size=2g` when not using compose.

## Manual Chrome Tabs (authenticated / OTP pages)

The static flow launches a fresh headless Chrome per run, which cannot reach pages behind OTP or user-specific verification. The `Manual Chrome Tabs` mode instead audits tabs you have already authenticated in a dedicated, app-owned Chrome profile.

**Security model — local single-user only.** This mode is disabled unless explicitly enabled, and the API and worker only accept loopback callers. Keep it disabled on shared, tunneled, reverse-proxied, or production deployments. The server ignores `X-Forwarded-*` headers for this decision, so a proxy cannot grant access.

**Setup:**

1. Set `MANUAL_CHROME_ENABLED=true` and a non-empty `ALLOWED_HOSTS` (only these hosts may be audited — initial URLs and every redirect hop are checked).
2. Run the API and worker against the same Redis. The API generates a random boot identity on startup and stores it in Redis; the worker reads it from there. There is no shared instance-id env var, and restarting the API invalidates any open profile (see recovery below).
3. The dedicated profile lives in `MANUAL_CHROME_PROFILE_DIR` (default `.lh-audit/chrome-profile`) on the CDP port `MANUAL_CHROME_PORT` (default `9222`).
4. By default the API auto-launches the dedicated profile during startup. Set `MANUAL_CHROME_AUTO_OPEN=false` to require an explicit `Open Chrome profile` click in the UI instead. Auto-launch failures (port in use, Chrome missing, startup timeout) are logged and do not crash the server.

**Usage:**

1. In the UI, switch to `Manual Chrome Tabs` and click `Open Chrome profile`. The backend launches the dedicated profile (it never attaches to a Chrome it did not launch).
2. Complete OTP / login / verification manually in each tab on an allowed host, and leave those pages open.
3. Click `Scan tabs`, select the tabs to audit, choose shared Lighthouse settings, and run. Chrome stays open after scans and audits so the verified state is reusable.

**Privacy:**

- The UI, reports, workbook, logs, and `meta.json` use sanitized display URLs (`origin + pathname`); query strings and fragments are never persisted in plaintext. Raw audit URLs live only inside the encrypted queued job config.
- Do not audit URLs containing OTPs, password-reset tokens, or one-time session tokens in the query string or fragment.
- HTML evidence is off by default. Enabling it requires an explicit consent checkbox because authenticated page content (screenshots, DOM, network URLs) is written to disk and served through tokenized evidence links. Per-file byte and total file-count limits apply (`MANUAL_CHROME_MAX_EVIDENCE_BYTES`, `MANUAL_CHROME_MAX_EVIDENCE_FILES`).
- Lighthouse may reload or navigate the selected tab during measurement; pages that depend on transient in-memory state may need to be re-prepared.

**Recovery:** If the server restarts while Chrome remains open, the browser is treated as unowned and manual operations fail closed — close that Chrome and click `Open Chrome profile` again. If the configured port is already in use by another Chrome, the backend returns an error instead of attaching; close it or change `MANUAL_CHROME_PORT`.

## Verification

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Full acceptance still requires a staging run with Redis and Chrome:

- 3 paths x 2 form factors x 5 runs against `https://example.com`.
- Basic Auth success/failure smoke.
- Dummy form-login fixture smoke.
- One killed Chrome run to verify degraded report output.
- 24-hour cleanup verification.

Set `ALLOWED_HOSTS=staging.example.com,example.com` to restrict submitted base URLs.
