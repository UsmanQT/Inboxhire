# Inboxhire

Inboxhire automatically tracks your job applications by reading your Gmail inbox. When you receive a confirmation email after applying for a job, Inboxhire extracts the company name and job title using AI and saves it to your personal dashboard — no manual entry required.

---

## How It Works

```
Gmail Inbox
    → Gmail Poller (fetches job-related emails every 5 minutes)
        → Parser Service (extracts company + job title using Claude AI)
            → API Service (saves to Postgres database)
                → Frontend Dashboard (view and manage your applications)
```

---

## Services

| Service | Description | Port |
|---|---|---|
| `gmail-poller` | Polls Gmail for job application emails and sends them to the parser | — |
| `parser` | Extracts company name and job title using pattern matching + Claude AI | 3001 |
| `api` | REST API for storing and retrieving applications from Postgres | 3002 |
| `frontend` | Nginx-served dashboard to view and update application statuses | 80 |
| `db` | Postgres database for storing all job applications | 5432 |

---

## Prerequisites

- Docker and Docker Compose installed
- A Gmail account
- Google Cloud project with Gmail API enabled
- Anthropic API key (for Claude AI parsing)

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/UsmanQT/Inboxhire.git
cd Inboxhire
```

### 2. Set up Gmail API credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project called `inboxhire`
3. Enable the **Gmail API**
4. Go to **APIs & Services → Credentials → Create OAuth Client ID**
5. Choose **Desktop App**, download the credentials JSON
6. Rename it to `credentials.json` and place it in `services/gmail-poller/`

### 3. Authenticate with Gmail

```bash
cd services/gmail-poller
npm install
node index.js
```

Follow the OAuth URL printed in the terminal. After approving, a `token.json` file will be saved automatically.

### 4. Create the root `.env` file

Create a `.env` file in the project root:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
DB_USER=admin
DB_PASSWORD=password
DB_NAME=jobtracker
POLL_INTERVAL_MS=300000
```

> Never commit this file. It is already in `.gitignore`.

### 5. Run with Docker Compose

```bash
docker-compose up --build
```

This starts all 5 services. On first run the Gmail Poller will fetch all historical job application emails.

---

## Accessing the Dashboard

Open your browser and go to:

```
http://localhost:80
```

You will see all your job applications with company name, job title, status, and date applied. You can update the status of each application using the dropdown.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Docker Compose Network              │
│                                                     │
│  ┌──────────────┐     ┌──────────────┐              │
│  │ gmail-poller │────▶│    parser    │              │
│  └──────┬───────┘     └──────────────┘              │
│         │                                           │
│         ▼                                           │
│  ┌──────────────┐     ┌──────────────┐              │
│  │     api      │────▶│      db      │              │
│  └──────────────┘     └──────────────┘              │
│                                                     │
│  ┌──────────────┐                                   │
│  │   frontend   │ ◀── browser hits localhost:80     │
│  └──────────────┘                                   │
└─────────────────────────────────────────────────────┘
```

---

## Useful Commands

```bash
# Start all services
docker-compose up

# Start in background
docker-compose up -d

# View logs for a specific service
docker-compose logs -f gmail-poller

# Stop all services
docker-compose down

# Stop and remove volumes (wipes database)
docker-compose down -v

# Rebuild images after code changes
docker-compose up --build
```

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for AI parsing | `sk-ant-...` |
| `DB_USER` | Postgres username | `admin` |
| `DB_PASSWORD` | Postgres password | `password` |
| `DB_NAME` | Postgres database name | `jobtracker` |
| `POLL_INTERVAL_MS` | How often to poll Gmail (milliseconds) | `300000` (5 min) |

---

## How Parsing Works

Inboxhire uses a two-step parsing strategy to minimize API costs:

1. **Pattern matching (free)** — regex patterns extract company and job title from the email subject and sender for common formats like `"Thank you for applying to Vanta!"`
2. **Claude AI fallback** — only used when pattern matching fails or can't find the job title. Passes the email body to Claude for accurate extraction.

This means roughly 80% of emails are parsed for free, with Claude only called for complex or ambiguous emails.
