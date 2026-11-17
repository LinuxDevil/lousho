# 0002-deploy: one EU server, backups and the self hosted image

## Summary

The beta runs as a Docker Compose stack on the engineer's Hostinger KVM 2 in an EU data center: Caddy for HTTPS, the service, a separate collector container from the same image, and Postgres. Backups go to Cloudflare R2 every night with continuous WAL archiving, and a restore is practiced before launch. The service watches itself through its own collector and an outside uptime check. The same image, in `self` mode, is what self hosters run.

## Decision

Docker Compose on one Hostinger KVM 2, EU data center, with Fly Machines in the nearest Fly EU region for runs. One image, `lousho/server`, started with different commands for the service and the collector. Backups with `wal-g` (a Postgres backup tool) to Cloudflare R2 with EU jurisdiction. Email through Resend's EU region. Monitoring by dogfooding plus an outside uptime check.

## The stack

| Container | Image | Role | Memory limit |
|---|---|---|---|
| `caddy` | caddy | HTTPS with automatic certificates, routes `/api/v1/ingest` to `collector`, everything else to `service` | 128 MB |
| `service` | `lousho/server` (`serve`) | auth, workspace service, run control, Studio static files, observe reads | 1.5 GB |
| `collector` | `lousho/server` (`collect`) | trace ingest, sweep, alerts, retention and deletion jobs | 768 MB |
| `postgres` | postgres 17 | all data; `shared_buffers` 1.5 GB | 3 GB |
| `backup` | `wal-g` | WAL archiving and the nightly base backup to R2 | 256 MB |

That totals under 6 GB, leaving about 2 GB of the KVM 2's 8 GB for the operating system and page cache. The collector runs separately so a burst of trace ingest cannot slow Studio. Both read the same Postgres.

Caddy proxy timeouts are 60 seconds for `/api/runners/claim` (its long poll answers within 25 seconds) and unlimited read time for the SSE route `/api/workspaces/:id/runs/:runId/events`. Fly Machines and runners reach the service only through `LOUSHO_PUBLIC_URL`; `/internal/runs/*` is served on that same address and authenticated by run tokens.

`GET /health` answers 200 with `{ db: "ok", masterKey: "loaded", version }` when Postgres answers a query within 2 seconds and the master key is loaded, and 503 otherwise.

## Configuration required

- `LOUSHO_MODE`: `saas` or `self`.
- `LOUSHO_PUBLIC_URL`: the public https address, used in links and OAuth callbacks.
- `DATABASE_URL`: Postgres connection string.
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`: session signing secret and base URL.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: OAuth apps.
- `RESEND_API_KEY`, `LOUSHO_MAIL_FROM`: magic link and invitation mail.
- `LOUSHO_MASTER_KEY_FILE`: path to the 32 byte master key file (mode 0400, owned by the service user, outside the repo and outside backups).
- `FLY_API_TOKEN`, `FLY_APP_NAME`, `FLY_REGION`, `FLY_MACHINE_SIZE`: the sandbox app, the EU region nearest the VPS, and the machine size (default `shared-cpu-1x`, 512 MB). Required in `saas` mode; in `self` mode only when `LOUSHO_EXECUTOR=fly`.
- `LOUSHO_EXECUTOR`: `self` mode only; `local`, `runner` or `fly`.
- `WALG_S3_PREFIX`, `AWS_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: R2 bucket for backups.
- `LOUSHO_BETA_MAX_ORGS`: how many organizations may exist during the beta (default 10).
- `LOUSHO_OPS_WEBHOOK`: where the service's own alerts go (the engineer's Telegram bot).

## Backups and restore

- WAL archiving runs continuously; a full base backup runs nightly at 03:00 UTC; backups are kept 14 days.
- The privacy policy states that deleted data leaves backups within 14 days of the hard delete.
- The master key file is backed up separately (offline, encrypted), never with the database; a database backup without it cannot reveal secrets.
- A restore drill (fresh Postgres from R2, start the service, sign in, open a trace) runs before launch and then monthly. Satisfies **AC-19**.
- Every restore, drill or real, ends by running the org deletion job for every org deleted since the backup was taken (the job reads a small `deleted_orgs` list kept in R2 beside the backups), so a restore never brings back erased data.

## Monitoring the service

- The service and collector send their own traces to the collector under an internal org.
- Ops alerts (container down, disk over 80%, backup older than 26 hours, Fly API errors) post to `LOUSHO_OPS_WEBHOOK`.
- An outside uptime check (Better Stack or UptimeRobot free tier) calls `/health` every minute.

## Capacity triggers

The KVM 2 is enough for a small invite only beta. Act when any of these holds for a week:
- Postgres CPU above 70%, or `observations` above 50 GB: move to a larger Hostinger plan first, and partition `observations` by day so retention drops whole partitions.
- Trace queries in Studio slower than 2 seconds at p95 after that: move `observations` to ClickHouse (a follow up spec).
- More orgs wanted than `LOUSHO_BETA_MAX_ORGS`: raise it only after the two checks above look healthy.

## Self hosted image

The same `lousho/server` image runs with `LOUSHO_MODE=self`. A second compose file, `deploy/self-hosted/compose.yaml`, starts `caddy`, `service`, `collector` and Postgres (or SQLite with `DATABASE_URL=sqlite:/data/lousho.db`), with the sandbox driver chosen by `LOUSHO_EXECUTOR` (`local`, `runner` or `fly`). The guide extends `docs/hostinger-vps.md`. Satisfies **AC-18**.

## Critical test scenarios

- Restart: `docker compose restart service` during a run; afterwards the run shows `interrupted` and resumes from its checkpoint. Verifies **AC-19**.
- Restore: the drill above completes and a trace from before the backup is visible. Verifies **AC-19**.
- Self hosted: the self hosted compose file starts on a clean VPS, the first sign in becomes owner, a run completes with `LOUSHO_EXECUTOR=local`. Verifies **AC-18**.

## Build tasks

1. The `lousho/server` image with `serve` and `collect` commands, the SaaS compose file and Caddy config. Satisfies **AC-8**, **AC-13**.
2. `wal-g` archiving and nightly backups to R2. Satisfies **AC-19**.
3. The restore drill script and its first run. Satisfies **AC-19**.
4. Ops alerts and the uptime check. Satisfies **AC-19**.
5. `/health`, Caddy timeouts, and the `deleted_orgs` list written by the deletion job. Satisfies **AC-16**, **AC-19**.
6. The self hosted compose file and guide. Satisfies **AC-18**.

Interrupted run detection on service start is built in the execution child (task 6); the beta org cap in the tenancy child (task 1).

## Rationale

The engineer already runs a Hostinger KVM 2, and the heavy work (agent runs) happens on Fly, so one server with Compose is enough for a free beta and costs nothing new (runner up: Fly for the service too, which removes the single server risk but adds cost and a second place to operate). Running the collector in its own container from the same image isolates ingest load without a second codebase. R2 has no egress fees, so restores are cheap to practice.
