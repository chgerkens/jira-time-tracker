# Jira Time Tracker

Local time tracker for **Jira Server / Data Center** with built-in proxy.

![Node.js](https://img.shields.io/badge/Node.js-≥18-green) ![Dependencies](https://img.shields.io/badge/Dependencies-0-blue) ![Auth](https://img.shields.io/badge/Auth-PAT%20(Bearer)-orange)

## Quickstart

```bash
node server.js https://jira.your-company.com
```

Open `http://localhost:3001`, enter your PAT — done.

## Features

- **Manual entry & timer** — Enter hours/minutes directly (default) or use the stopwatch
- **Editable entries** — Change ticket, description, start time, and duration after creation
- **Manual Jira sync** — Push individual entries or all at once; nothing is sent automatically
- **Import** — Load existing worklogs for a day from Jira
- **Ticket search** — Live search via JQL with issue summary displayed
- **Issue summary** — Jira issue title shown next to ticket key in the entry list
- **Favorites** — Save frequently used tickets with autocomplete
- **Calendar history** — Weekly calendar view grouped by ISO week with hour totals per day and week
- **Copy week** — Export a week's hours as tab-separated decimals (comma separator) for pasting into spreadsheets
- **Start & end time** — Optional start time per entry, end time auto-calculated
- **15-min increments** — Minute spinners step in quarter-hour intervals
- **Sync status** — Visible per entry (Local / ✓ Jira / ✗ Error) with retry; resets on edit
- **Responsive layout** — Adapts padding and card sizes to any window width

## Why a proxy?

Jira Server/DC validates the `Origin` header on write requests (XSRF protection). Browsers set this header automatically and JavaScript cannot override it. Requests from a different origin are rejected with `403 XSRF check failed`.

The built-in proxy solves this: `/rest/*` requests are forwarded server-side to Jira, stripping `Origin`/`Referer` headers and setting XSRF bypass headers.

## Configuration

```bash
# Required: Jira Server URL
node server.js https://jira.your-company.com

# Optional: Port (default: 3001)
node server.js https://jira.your-company.com 8080

# Alternatively via environment variables
JIRA_URL=https://jira.your-company.com PORT=8080 node server.js
```

### Docker

```bash
# Pull and run from GitHub Container Registry
docker run -p 3001:3001 ghcr.io/chgerkens/jira-time-tracker https://jira.your-company.com

# Or build and run locally
docker build -t jira-time-tracker .
docker run -p 3001:3001 jira-time-tracker https://jira.your-company.com
```

### Creating a PAT

1. Log in to Jira → Profile → **Personal Access Tokens**
2. Create a token
3. Enter it in the app under ⚙️ Settings

The PAT is stored only in the browser (`localStorage`), not on the server.

## Project structure

```
jira-time-tracker/
├── server.js          # Node.js server + Jira proxy
├── public/
│   └── index.html     # Single-file React app
├── package.json
├── CLAUDE.md          # Context for Claude Code
└── README.md
```

## Technology

- **Server:** Node.js (0 dependencies)
- **Frontend:** React 18 + Babel (via CDN, no build step)
- **Auth:** Bearer Token (PAT)
- **API:** Jira REST API v2
- **Storage:** Browser localStorage

## License

MIT
