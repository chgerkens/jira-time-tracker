# Jira Time Tracker

Local Jira time tracker for Jira Server/Data Center.

## Architecture

- **`server.js`** — Node.js server (zero dependencies), serves the web app on `/` and proxies `/rest/*` to the configured Jira server. Strips Origin/Referer headers and sets XSRF bypass headers.
- **`public/lib.js`** — Pure date/time helpers (plain JS, no JSX). Loaded by `index.html` as a classic script (globals) and `require`d by the unit tests. Put testable logic here.
- **`test/`** — `node:test` suites (`npm test`, no install needed): `lib.test.js` (helpers, run across several time zones), `server.test.js` (spawns `server.js` against a fake Jira; proxy, request guard, cookies, binding, TLS). `helpers.js` is shared with the e2e tests.
- **`e2e/`** — Playwright browser tests (`npm run test:e2e`) against a stateful fake Jira (`fake-jira.js`). Fixed clock (Wed 2026-10-07 09:00) and time zone (Europe/Berlin). Locate inputs via their `aria-label`s and entries via `data-testid="entry"`.
- **`public/index.html`** — Single-file React app (React 18 via CDN + Babel Standalone). All UI, state management, and Jira API logic in one file.

## Technical Details

- **Auth:** Bearer Token (Personal Access Token, requires Jira DC 8.14+) — stored only in browser localStorage, not on the server. PAT page: `/secure/ViewProfile.jspa#!/personal-access-tokens`
- **API:** Jira REST API v2 (`/rest/api/2/*`)
- **Storage:** Browser localStorage for entries, favorites, and settings
- **Proxy:** Required due to XSRF validation on Jira Server/DC — browser requests from a different origin are rejected
- **TLS:** Jira certificates are verified against Node's CAs plus the OS trust store (`tls.getCACertificates("system")`, Node ≥ 22.15). `node server.js --export-ca <URL>` prints Jira's root CA as PEM (for Docker + `NODE_EXTRA_CA_CERTS`). CI job `trust-store` installs a generated test CA (`test/certs.js`) into the macOS/Windows/Linux trust store and runs the TLS tests with `JTT_OS_TRUSTS_TEST_CA=1`.
- **Node:** ≥ 22 (`engines`, `.nvmrc` = 24). Unit/server tests run on ubuntu, macOS and Windows in CI.
- **No build step:** No runtime dependencies, no bundler (Playwright is a dev dependency for e2e tests only). `node server.js <JIRA_URL>` starts everything.

## Features

- Manual time entry (default tab) and timer mode
- Live ticket search via JQL with issue summary displayed
- Issue summary shown next to ticket key in entry list
- Editable entries: ticket, description, start time, hours/minutes — sync status resets on change
- Optional start time for entries, end time auto-calculated
- Manual sync: worklogs are only pushed to Jira on explicit "Push" action
- Bulk sync: "Push all to Jira" button for unsynced entries
- Import: load existing worklogs for a day from Jira
- Favorite tickets with autocomplete
- Calendar-sheet history view grouped by ISO week with weekly hour totals
- Copy week hours: tab-separated decimal hours per day (Mon–Fri), comma as decimal separator
- Minute inputs in 15-minute increments
- Sync status per entry (Local/Synced/Error) with retry
- Responsive layout: padding and card sizes adapt to window width

## Getting Started

```bash
node server.js https://jira.your-company.com
# or with a custom port:
node server.js https://jira.your-company.com 8080
```

Then open `http://localhost:3001` and enter your PAT.
