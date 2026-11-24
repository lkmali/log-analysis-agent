# Claude SRE Platform

Watches application logs (AWS CloudWatch today), groups errors into incidents, detects PII/secrets in logs, and raises alerts to Slack/email. Everything is managed from a web dashboard.

It is **one Node.js service** (Next.js 15): the dashboard UI, the API, and the background scheduler all run in the same process, from one `package.json` and one database. `.env` holds only the database connection; every other setting is edited in the dashboard on the **Settings** page.

```text
app/                 Pages (dashboard, login, onboarding) and API routes (app/api/*)
components/          UI components
lib/                 Web-side helpers: session/auth, per-request DB access (RLS)
db/
  migrations/        SQL schema (0000 bootstrap, 0001 init, ...) + run-migrations.sh (npm run db:setup)
backend/
  db/                Everything database
    index.ts           pg pool, withTransaction, withUser (RLS)
    pools.ts           The two connection pools, built from the SQL_* settings
    types.ts           Row types for every table
    migrate.ts         Node migration runner   (npm run db:migrate)
    tests/             RLS isolation tests      (npm run db:test)
  validation.ts      zod request schemas used by API routes / server actions
  settings/          Platform settings: definitions + defaults, DB loader, .env import helper
  scheduler/         Background jobs: CloudWatch poll, ingest pipeline, alerts, maintenance
  ai/                AI agents (Claude Managed Agents): investigate incidents, open fix PRs
    agents.ts          Agent definitions: prompts + tools
    provision.ts       Create/update the agents (Settings → AI agents → Provision agents)
    workflow.ts        Incident -> log investigator -> PR author, and all state transitions
    job.ts             Scheduler job that picks up new incidents
    session.ts         Runs one agent session: tool dispatch, reconnects, timeouts, usage
    tools/             Host-side tools the agents call (logs, DB, opening PRs)
    github.ts          GitHub REST call for opening the draft PR
instrumentation.ts   Starts the scheduler when the Next.js server boots
middleware.ts        Redirects to /login when there is no session cookie
```

---

## Prerequisites

- **Node.js 22** (see `.nvmrc`; `>=20` works): `nvm use`
- **PostgreSQL 14+** and `psql` (`brew install postgresql@16`) or Docker
- **AWS credentials** with CloudWatch Logs read access (only needed to poll real logs)

```bash
npm install
```

---

## Database roles (read this first)

There is one database (`SQL_HOST` / `SQL_PORT` / `SQL_DATABASE`) and one login (`SQL_USER` / `SQL_PASSWORD`). The service opens **two connection pools** with it; the dashboard pool runs `set local role sre_app` in every transaction (`withUser` in `backend/db/index.ts`), so tenant isolation still applies.

| Role | Env var | Used by | Notes |
| --- | --- | --- | --- |
| `sre_owner` | `SQL_USER` / `SQL_PASSWORD` | scheduler, AI agents, migrations | Owns all tables, so it **bypasses RLS**. |
| `sre_app` | — | dashboard + API | `NOLOGIN` group role created by the migration; the owner switches to it per request. Reads only tenant rows (RLS) and calls `app.*` functions. |

---

## Local test server

The full stack runs on your machine: PostgreSQL (Docker or Homebrew) plus one `npm run dev` process that serves the dashboard and API and runs the scheduler. You only need AWS to ingest real CloudWatch logs; everything else works offline.

### 1. Start PostgreSQL

**Option A: Docker (recommended)**

```bash
docker run -d --name sre-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  -v sre-pgdata:/var/lib/postgresql/data \
  postgres:16
```

Then set the admin credentials in `.env` so the bootstrap script can create the role and database:

```dotenv
SQL_ADMIN_USER=postgres
SQL_ADMIN_PASSWORD=postgres
SQL_ADMIN_DATABASE=postgres
```

**Option B: Homebrew**

```bash
brew install postgresql@16
brew services start postgresql@16
# The admin user is your macOS user name, with no password:
#   SQL_ADMIN_USER=$(whoami)  SQL_ADMIN_PASSWORD=
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

The defaults in `.env.example` (`localhost:5432`, database `sre`, owner `sre_owner`) work for local use. Leave `SQL_SSLMODE` empty locally.

### 3. Create the database and schema

Run these three steps once, in order:

```bash
# a) Bootstrap: creates the sre_owner role and the sre database (connects as SQL_ADMIN_USER)
npm run db:setup

# b) Schema: applies 0001_init.sql, 0002_platform_settings.sql, ... as sre_owner
npm run db:migrate

# c) First superadmin account (later accounts are added from the dashboard's Users page)
npm run user:create -- --email you@example.com --superadmin
```

If you don't have `psql` on the host, `db:setup` runs it inside a throwaway Docker container.

- `npm run db:setup` runs `db/migrations/run-migrations.sh`. It applies the files in its `SCRIPTS` array (only `0000_create_database.sql` by default) with `psql`, or with a throwaway Docker `postgres` image if `psql` isn't installed. Pass file names to run specific files: `db/migrations/run-migrations.sh 0002_platform_settings.sql`.
- `npm run db:migrate` applies every `db/migrations/*.sql` file not yet recorded in `public.schema_migrations`, each in its own transaction. Run it again whenever you pull a new migration.

### 4. Start the dev server

```bash
npm run dev
```

1. Create the first superadmin: `npm run user:create -- --email you@example.com --superadmin` (prompts for the password). Open http://localhost:3000, sign in, and create your organization in onboarding. There is no public sign-up: superadmins add everyone else on the **Users** page.
2. Look for `"scheduler started"` in the terminal.
3. Open **Settings** to configure alerts, AWS and AI, then add log sources and repositories in the UI.

To run only the dashboard without background jobs, set `SCHEDULER_ENABLED=false` in `.env` and restart.

### 5. Optional: run the production build locally

This runs the same standalone server that production uses. It's a good check before a release.

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
set -a; source .env; set +a
NODE_ENV=production PORT=3000 node .next/standalone/server.js
```

In production mode session cookies are `secure`, and browsers only send them over HTTPS or to `localhost`. To test from another device, put the server behind HTTPS (for example `caddy reverse-proxy --from <name>.localhost --to :3000`).

### 6. Optional: test with real CloudWatch logs

1. Configure local AWS credentials (`aws configure --profile sre-dev`) with `logs:FilterLogEvents` permission (plus `logs:CreateLogGroup`, `logs:CreateLogStream` and `logs:PutLogEvents` to write the test logs).
2. In **Settings → AWS**, set *Credentials profile* to `sre-dev` and the region you use.
3. Create a test log group and add it under **Log sources**:
   ```bash
   export AWS_PROFILE=sre-dev AWS_REGION=ap-south-1
   aws logs create-log-group  --log-group-name /sre/local-test
   aws logs create-log-stream --log-group-name /sre/local-test --log-stream-name smoke
   ```
4. Write an error, and an error that contains PII:
   ```bash
   now=$(($(date +%s) * 1000))
   aws logs put-log-events --log-group-name /sre/local-test --log-stream-name smoke --log-events \
     "timestamp=$now,message=ERROR TypeError: Cannot read properties of undefined (reading 'id') at handler (/app/src/orders.ts:42)" \
     "timestamp=$now,message=ERROR payment failed for jane.doe@example.com phone +1-555-010-9999"
   ```
5. Within about `CW_TICK_SECONDS + CW_LAG_SECONDS` (30 s with the defaults), the incident appears under **Incidents** and the PII event appears under **PII** and **Alerts**. **System** shows each job run and any errors.
6. Delete the test log group when you're done: `aws logs delete-log-group --log-group-name /sre/local-test`.

### Reset the local database

To delete all data but keep the schema and roles (the next sign-up becomes superadmin again):

```bash
npm run db:reset                      # asks you to type the database name to confirm
npm run db:reset -- --keep-settings   # keep Settings page values and secrets (API keys, tokens)
```

To remove the database completely:

```bash
docker rm -f sre-postgres && docker volume rm sre-pgdata   # Docker
# or: dropdb sre && dropuser sre_owner  # Homebrew
```

Then repeat steps 1 and 3.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `relation "..." does not exist` | You ran `db:setup` but not `db:migrate`. |
| `permission denied to create role` during migrate | The owner needs `CREATEROLE`. `0000_create_database.sql` grants it; for an existing role run `alter role sre_owner createrole;` as admin. |
| `permission denied to set role "sre_app"` | Run `npm run db:migrate` (0004 grants `sre_app` to the owner). |
| No incidents from CloudWatch | Check **System** for poll errors, the profile and region in **Settings → AWS**, and that the log line matches an error pattern (`ERROR`, `*Error`, `*Exception`, `FATAL`, JSON `level: error`, …). |
| Port 3000 in use | `PORT=3001 npm run dev` |

## Configuration


**`.env`** holds only the database connection and three process switches (see `.env.example`):

| Variable | Description |
| --- | --- |
| `SQL_HOST`, `SQL_PORT`, `SQL_DATABASE` | The one database everything uses |
| `SQL_USER`, `SQL_PASSWORD` | Owner role: scheduler, AI agents, migrations |
| `SQL_SSLMODE` | Optional, e.g. `require` for a remote database |
| `SQL_ADMIN_*` | Only used by `npm run db:setup` to create the role and database |
| `SESSION_TTL_SECONDS` | Session lifetime, default 7 days |
| `SCHEDULER_ENABLED` | `false` runs the dashboard without background jobs |

**Everything else is on the Settings page** (`/settings`): scheduler polling and retention, alert rules and channels (Slack, SMTP), AWS profile and region, and the AI agents (Anthropic key, GitHub token, model, budgets, thresholds). The full list with defaults and limits is in `backend/settings/definitions.ts`.

- **Superadmin can edit.** The first account created becomes superadmin, and a superadmin can promote others on the same page. Everyone else sees a read-only view.
- **Secrets are write-only.** API keys, tokens and the Slack/SMTP URLs are stored in the `private` schema. The dashboard role can't read them; the page only shows *Configured* or *Not set*.
- **No restart needed.** The scheduler and agents re-read settings before every run, so changes apply on the next run.
- **Moving from an old `.env`:** put the old lines in `.env.settings-import` and run `npm run settings:import` once.

---

## AI agents

New incidents are investigated and, where possible, fixed **by AI agents only**. A human only reviews the result. The agents run on [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) (beta): Anthropic hosts the agent loop and, for the PR author, an isolated cloud sandbox. Our backend decides which incidents to hand over, executes the tools that need our credentials, and records everything.

```text
incident (severity >= AI_INVESTIGATE_MIN_SEVERITY, status new)
  └─ ai-investigate job claims it                      workflow_state INVESTIGATING
      └─ Log investigator agent
           tools (run by our backend, scoped to the incident's org):
             get_incident, list_incident_events, search_logs (CloudWatch, redacted), submit_investigation
           → investigations.summary / root_cause / confidence / analysis
      └─ fixable in code + repo identified + confidence >= AI_MIN_FIX_CONFIDENCE + GITHUB_TOKEN?
           no  → NEEDS_HUMAN_REVIEW
           yes → PR author agent                        workflow_state PATCH_PROPOSED
                   sandbox: repo cloned at /workspace/repo, bash/read/edit/grep, package registries only
                   reads get_investigation, fixes the code, runs the repo's test_commands,
                   pushes branch ai/incident-<id>-…, calls open_pull_request (our backend opens a DRAFT PR)
                   → code_changes, validation_runs, pull_requests     workflow_state AWAITING_APPROVAL
```

Guardrails:

- **Secrets stay out of the agents.** AWS, database and PR creation run in our backend as custom tools. The GitHub token reaches the sandbox only through Anthropic's git proxy, so code in the container can't read it.
- **Logs are redacted.** Log text goes through the same PII/secret redaction as ingestion before an agent sees it, and the prompts treat it as untrusted data.
- **PRs are always drafts.** The branch prefix is enforced, there is one PR per investigation, and nothing is ever merged automatically.
- **Unattended runs.** A sandbox command that the server pauses for approval is denied.
- **Limits.** Each session has a hard dollar budget (set on the Settings page) and a wall-clock timeout. Token usage and estimated cost go to `agent_runs` and `model_usage_events`.

### Set up

1. As a superadmin, open **Settings → AI agents** and save the Anthropic API key. Add a GitHub token (fine-grained, Contents + Pull requests read/write on your repos) if you want PRs.
2. Click **Provision agents**. This creates the sandbox environment and the two agents in your Anthropic account and saves their ids. After changing the model, or the prompts and tools in `backend/ai/agents.ts`, click **Update agents**. It updates the agents in place (a new version) and doesn't create new ones.
3. Register repositories in the dashboard with their `test_commands`, and map them to log sources/services so the investigator can pick the right repo.

Every session logs a link to its trace in the Claude Console (the *Claude Console workspace* setting). Managed Agents bills sandbox running time on top of tokens and keeps session history until deleted. Untick *Investigate incidents automatically* to stop automatic investigations.

---

## Testing

```bash
npm run typecheck      # whole project, including the scheduler
npm run db:test        # RLS isolation tests (runs in a transaction, rolls back)
npm run build          # production build
curl http://localhost:3000/api/health   # → {"status":"ok","time":"..."}
```

Manual end-to-end check (see [Test with real CloudWatch logs](#6-optional-test-with-real-cloudwatch-logs) for the commands):

1. Sign in as a superadmin (created with `npm run user:create`) and create an organization.
2. Add a CloudWatch log source under **Log sources**.
3. Write an error to that log group. Within about `CW_TICK_SECONDS` + `CW_LAG_SECONDS` it appears under **Incidents**. Errors that contain an email address or phone number also appear under **PII** and **Alerts**.
4. **System** shows scheduler job runs and errors.
5. With AI configured: an incident at or above the investigation severity moves to `INVESTIGATING`, then to `NEEDS_HUMAN_REVIEW` or `AWAITING_APPROVAL` (draft PR) on **Pull requests**.

---

## Deployment plan

### Target architecture

```text
            HTTPS
 users ───────────▶  ALB / Caddy / nginx  (TLS termination)
                          │  :3000
                          ▼
              EC2 (or any always-on Node host)
              ┌──────────────────────────────────┐
              │ node server.js  (systemd: sre)    │
              │  ├─ dashboard + API (Next.js)     │
              │  └─ scheduler (CloudWatch poll,   │
              │      alerts, maintenance, AI)     │
              └──────────────┬───────────────────┘
          instance role      │ TLS              outbound HTTPS
   ┌──────────────┐          ▼                ┌──────────────────────────┐
   │ CloudWatch   │◀── PostgreSQL 14+ (RDS)   │ Anthropic API, GitHub,   │
   │ Logs (+ STS) │    private subnet         │ Slack, SMTP              │
   └──────────────┘                           └──────────────────────────┘
```

The scheduler runs inside the server process, so deploy to a **long-running** host. Serverless platforms like Vercel freeze the process between requests, which stops the jobs. (The original Vercel + Supabase + workers design in [IMPLEMENTATION_PLAN_UPDATED.md](IMPLEMENTATION_PLAN_UPDATED.md) was replaced by this single service.)

### Environments

| Environment | Host | Database | Purpose |
| --- | --- | --- | --- |
| **Local** | `npm run dev` on a laptop | Docker / Homebrew Postgres | Development and the [local test server](#local-test-server) |
| **Staging** | Small EC2 instance (e.g. `t3.small`) | Separate RDS instance or database | Test migrations and releases against real CloudWatch logs; Slack alerts go to a test channel |
| **Production** | EC2 (`t3.medium` or larger), one or more instances | RDS PostgreSQL, Multi-AZ, automated backups | Live monitoring |

Each environment has its own database, its own `/etc/sre.env`, and its own settings (configured on its Settings page). Never point staging at the production database.

### Rollout phases

1. **Infrastructure.** VPC with the database in a private subnet; security groups: the load balancer can reach the app on 3000, and the app can reach Postgres on 5432. Create the RDS instance (TLS on, automated backups), the EC2 instance role (IAM below), and a DNS record and TLS certificate.
2. **Database.** Bootstrap the roles and schema (step 1 below) and run `npm run db:test` against it.
3. **Staging deploy.** Deploy the build to staging, create the first superadmin with `npm run user:create -- --email ... --superadmin`. Configure Settings and add one real log source. Verify the end-to-end check from [Testing](#testing).
4. **Alerts.** Connect Slack/SMTP to a test channel and trigger an error and a PII event.
5. **AI agents (optional).** Save the Anthropic key and GitHub token, click **Provision agents**, register one repository, and confirm a draft PR is opened for a test incident. Set conservative budgets first.
6. **Production deploy.** Repeat steps 1–5 for production with real channels. Watch the **System** page and `journalctl -u sre` for the first 24 hours.
7. **Scale and harden.** Add instances behind the load balancer if needed (jobs are lock-protected), set up the monitoring and backups below, and tune the polling and retention settings.

### Step-by-step: EC2 + systemd

**1. Database.** Create PostgreSQL 14+ (private, TLS). From a machine that can reach it, with a `.env` that points to it (`SQL_SSLMODE=require`):

```bash
npm ci
npm run db:setup        # creates sre_owner + database (uses SQL_ADMIN_* = the RDS master user)
npm run db:migrate      # schema
npm run user:create -- --email you@example.com --superadmin   # first account
npm run db:test         # RLS isolation tests
```

Re-run `npm run db:migrate` on every release that adds a migration. Migrations are forward-only, so take a snapshot before releases that change the schema.

**2. IAM.** Attach an instance profile with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["logs:FilterLogEvents", "logs:DescribeLogStreams"], "Resource": "arn:aws:logs:*:<account-id>:log-group:*" },
    { "Effect": "Allow", "Action": "logs:DescribeLogGroups", "Resource": "*" },
    { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/<cross-account-role-name>" }
  ]
}
```

You only need `sts:AssumeRole` when log sources are in other AWS accounts. The target role must trust this instance role and require the `ExternalId` shown in the dashboard. Leave *Credentials profile* empty in **Settings → AWS** so the instance role is used.

**3. Prepare the host** (Amazon Linux 2023 / Ubuntu):

```bash
# Node 22
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs git   # Amazon Linux
# curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git   # Ubuntu

sudo useradd --system --create-home --shell /usr/sbin/nologin sre
sudo mkdir -p /opt/loger-agents/releases && sudo chown -R sre:sre /opt/loger-agents

# Database settings only: the SQL_* values, SCHEDULER_ENABLED, SESSION_TTL_SECONDS
sudo install -m 600 -o root -g root /dev/null /etc/sre.env
sudo nano /etc/sre.env
```

**4. Build a release.** `output: "standalone"` produces a self-contained server. Each release goes in its own directory, so you can roll back by switching a symlink:

```bash
REL=/opt/loger-agents/releases/$(date +%Y%m%d%H%M%S)
sudo -u sre git clone --depth 1 <repo-url> "$REL" && cd "$REL"
sudo -u sre npm ci
sudo -u sre npm run build
sudo -u sre cp -r .next/static .next/standalone/.next/static
```

**5. Run under systemd.** Create `/etc/systemd/system/sre.service`:

```ini
[Unit]
Description=Claude SRE (web + API + scheduler)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/loger-agents/current/.next/standalone
EnvironmentFile=/etc/sre.env
Environment=NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
TimeoutStopSec=70
User=sre

[Install]
WantedBy=multi-user.target
```

Use `HOSTNAME=0.0.0.0` instead when an ALB connects to the instance directly. The scheduler handles `SIGTERM`/`SIGINT` and finishes in-flight work; `TimeoutStopSec=70` gives it time to do so.

```bash
sudo ln -sfn "$REL" /opt/loger-agents/current
sudo systemctl daemon-reload
sudo systemctl enable --now sre
journalctl -u sre -f        # look for "scheduler started"
```

**6. HTTPS.** Session cookies are `secure` in production, so the dashboard must be served over HTTPS. Either use an ALB with an ACM certificate (target group on port 3000, health check path `/api/health`), or run Caddy on the instance:

```caddyfile
# /etc/caddy/Caddyfile
sre.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**7. First login.** Create the first superadmin with `npm run user:create -- --email you@example.com --superadmin`, then sign in. Add other users from the **Users** page. Configure everything else on the **Settings** page.

**Scaling:** you can run several instances behind the load balancer. Each job takes a PostgreSQL advisory lock, and alert dispatch uses `FOR UPDATE SKIP LOCKED`, so a job never runs on two instances at once. Make sure RDS `max_connections` covers both pools on every instance.

### Release checklist

1. `npm run typecheck && npm run build` pass locally / in CI.
2. Deploy to **staging** first: build the release (step 4) and run `npm run db:migrate` there.
3. `npm run db:test` passes against staging; the end-to-end check passes.
4. Production: snapshot RDS if the release contains a migration.
5. Build the release on the production host and run `npm run db:migrate` from the release directory.
6. `sudo ln -sfn "$REL" /opt/loger-agents/current && sudo systemctl restart sre`
7. Check `curl -fsS https://<host>/api/health`, the logs (`journalctl -u sre`), and the dashboard's **System** page.
8. Keep the last 3 release directories and delete older ones.

### Rollback

```bash
PREV=$(ls -1d /opt/loger-agents/releases/* | tail -2 | head -1)
sudo ln -sfn "$PREV" /opt/loger-agents/current && sudo systemctl restart sre
```

Migrations are forward-only. If a release added a migration that the previous code can't work with, restore the pre-release RDS snapshot (or write a fix-forward migration) instead of only switching the symlink.

### Operations

- **Health:** `GET /api/health` returns `{"status":"ok"}` while the process is up. Point the load balancer and an uptime monitor at it.
- **Job health:** the **System** page shows every scheduler run and its errors. Alert on repeated failures.
- **Logs:** `journalctl -u sre`. Optionally ship them to CloudWatch with the CloudWatch agent.
- **Backups:** RDS automated backups (7+ days) and a manual snapshot before each schema change.
- **Secrets:** `/etc/sre.env` holds only the database credentials (`chmod 600`). API keys, tokens and webhook URLs live in the database `private` schema and are managed on the Settings page.
- **AI cost:** per-session budgets are on the Settings page, and usage is recorded in `agent_runs` and `model_usage_events`. Untick *Investigate incidents automatically* to pause the agents.
- **Upgrades:** OS and Node patch updates via a new release plus a restart; RDS minor versions in the maintenance window.
