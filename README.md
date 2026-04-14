# Schulnetz Monitor

Automatically checks your Schul-Netz grades page and sends you an email when new grades appear.

## Setup

### 1. Copy the config template

```bash
cp .env.example .env
```

Open `.env` and fill in your details:

| Variable | What it is |
|---|---|
| `SN_USER` | Your Schul-Netz username |
| `SN_PASS` | Your Schul-Netz password |
| `TARGET_URL` | Your school's grades URL (copy it from your browser after logging in) |
| `SMTP_USER` | Gmail address to send notifications from |
| `SMTP_PASS` | Gmail **App Password** (not your real password) — create one at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) |
| `RECIPIENTS` | Comma-separated list of email addresses to notify |
| `CHECK_INTERVAL` | How often to check, in minutes (default: `15`) |

> Email notifications are **optional** — if you leave `SMTP_USER`, `SMTP_PASS`, and `RECIPIENTS` blank, the monitor still runs and logs changes to the console.

### 2. Run with Docker (recommended)

```bash
docker compose up -d
```

That's it. Grades are stored in `./data/grades.json`. The container restarts automatically.

### 3. Run without Docker

```bash
npm install
node index.js
```

Requires Node.js 18+.

## How it works

- Logs into Schul-Netz with your credentials
- Parses subject grades and individual test results
- Compares against the last saved state (`data/grades.json`)
- Emails you if anything changed
- Repeats every `CHECK_INTERVAL` minutes
