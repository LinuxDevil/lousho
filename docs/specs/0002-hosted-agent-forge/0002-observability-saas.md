# 0002-observability-saas: one collector for every tenant

## Summary

The observe daemon's store moves behind an asynchronous interface with two backends: SQLite, as today, for local and self hosted use, and Postgres for the hosted service. Every row carries the organization and project, taken from the token that sent it. Tokens get roles (send data, read data, runner, run) and work only for their project. Agents anywhere report to one central collector, the fleet view filters by project or shows all of them, alerts become per project rules with a versioned payload, and daily jobs apply retention and deletion.

## Decision

Introduce an `ObserveStore` interface covering every read and write in `src/observe/store.ts`, implemented by `sqliteObserveStore` (wrapping today's synchronous code) and `postgresObserveStore`. Ingest derives `org_id` and `project_id` from the bearer token. Studio reads through the session and `authorize`, never with a shared token.

## Data model

- Every existing observe table (`agents`, `sessions`, `observations`, `scores`, `prompts`, `prompt_uses`, `hub_entries`, `rollups`, `agent_instances`, `prompt_labels`, `datasets`, `dataset_examples`, `evaluator_rules`, `annotation_queues`, `annotation_items`, `score_regressions`) gains `org_id` and `project_id`. In SQLite they are nullable and default to the single org and project of self hosted mode; in Postgres they are required. Every index used for reads leads with `project_id`.
- The existing `project TEXT` columns are replaced by `project_id`. The migration runs in this order: create the single org of self mode (or, in SaaS, there is no old data), create one `project` row per distinct old name (plus `default` for null), then fill `project_id` and `org_id`.
- `tokens` gains `org_id`, `project_id`, `roles` (a set drawn from `ingest`, `read`, `runner`, `run`; `runner` and `run` never combine with any other role), `name`, `last_used_at`, `expires_at` (nullable). Each existing token keeps its row and gets `roles = {ingest, read}` for its project. The token routes create only `ingest`, `read` or `ingest, read` tokens; `runner` tokens come from runner registration and `run` tokens from run start.
- New `alert_rule`: `id`, `org_id`, `project_id`, `down_factor` (default 5, replacing `FRESHNESS_DOWN_FACTOR`; the `stale` tier stays at 2 intervals plus 10 seconds), `error_rate_threshold` (0 to 1, null for off), `error_rate_min_runs` (default 10), `webhooks` (JSON array of https URLs), `webhook_secret` (for signing), `updated_by`, `updated_at`. One row per project, created with the project.
- New `alert_event`: `id`, `org_id`, `project_id`, `type`, `agent_id`, `payload` (the sent JSON), `created_at`, `delivered_at` (nullable), `attempts`. Kept with the project's trace retention.
- `agents` gains `pruned_at` (nullable).
- No partitioning in the beta: retention deletes by the `ts` index. Revisit partitions at the deploy child's 50 GB trigger.

## API surface

The daemon routes keep their paths under `/api/v1/*`. Changes:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/v1/ingest` | POST | envelope batch | accepted, dropped counts | token with `ingest` | 401, 413 |
| `/api/v1/traces`, `/agents`, `/insights`, `/scores`, ... | GET | existing filters plus optional `projectId` (a read token is always limited to its own project) | as today | token with `read`, or session through Studio | 401, 404 other project |
| `/api/projects/:projectId/tokens` | GET, POST | `name`, `roles`, `expiresAt` | tokens; POST returns the key once | session, admin | 403 |
| `/api/tokens/:tokenId` | DELETE | none | ok | session, admin | 403, 404 |
| `/api/projects/:projectId/alerts` | GET, PUT | rule fields | rule | session, admin for PUT | 403, 422 bad URL |

`lousho observe token create --project <slug> --roles ingest` and `lousho observe token rotate <tokenId>` work against either backend.

## Alert payload `lousho.alert/1`

```json
{
  "schema": "lousho.alert/1",
  "id": "alt_01J...",
  "type": "agent.status",
  "org": { "id": "org_...", "slug": "acme" },
  "project": { "id": "prj_...", "slug": "support" },
  "agent_id": "support-bot",
  "at": "2026-11-11T10:00:00Z",
  "details": { "from": "healthy", "to": "down" },
  "links": { "studio": "https://.../projects/support/fleet/support-bot" }
}
```

`type` keeps the values of today's `AlertEvent`. Mapping from `AlertEvent`: `type`, `agent_id`, `at` and `details` copy across; `project` becomes `{ id, slug }` from the `project` row; `org` comes from Better Auth's `organization` (`id`, `slug`); `id` is the `alert_event` id; `links.studio` is `LOUSHO_PUBLIC_URL` plus `/p/<projectId>/fleet/<agentId>`. New fields are only added, never renamed; a breaking change becomes `lousho.alert/2`.

Each POST carries `X-Lousho-Signature: sha256=<HMAC of the body with webhook_secret>` and `X-Lousho-Alert-Id`. Delivery retries 3 times (after 10 seconds, 1 minute, 5 minutes), records `attempts` and `delivered_at`, and never blocks the sweep. An error rate alert fires at most once per agent per UTC day, and only once the agent has `error_rate_min_runs` runs that day. Self hosted `alerts.json` keeps working and seeds the default project's rule.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| Ingest | `org_id`, `project_id` | the token row; any project in the payload is ignored |
| Ingest over limit | dropped count | `usage_limit.max_trace_events_day` against today's accepted count for the org |
| Fleet status | `down` | no heartbeat for `down_factor` times the agent's heartbeat interval |
| Error rate alert | rate | today's (UTC) errored runs over today's runs from `rollups`, against `error_rate_threshold`, when runs reach `error_rate_min_runs` |
| Prune | silent 7 days | `now - last_heartbeat > 7 days` sets `pruned_at`; a deregistered agent is hidden at once as today |
| Retention | cut off | `now - project.trace_retention_days`, applied to `sessions`, `observations`, `scores`, `rollups`, `prompt_uses`, `annotation_items`, `score_regressions` and `alert_event`; `prompts`, `datasets`, `dataset_examples`, `evaluator_rules`, `hub_entries` and `annotation_queues` live as long as the project |
| Org deletion | rows to remove | every row whose `org_id` has `delete_after < now` |
| Schedules | job times | retention at 02:00 UTC, org deletion at 02:30 UTC, prune with the existing sweep; all before the 03:00 UTC backup |

## Key invariants

- Ingest never blocks an agent: over a limit, events are dropped and counted, and the reply is still 2xx.
- A token never reads or writes outside its `project_id`.
- Retention and deletion jobs are idempotent; running one twice removes nothing extra.
- Pruned agents disappear from fleet lists only; their traces follow retention.

## Security model

Tokens are stored as sha256 hashes, shown once at creation, and audited on create, rotate and revoke. Webhook URLs must be https. Traces may hold personal data; access follows the tenancy rules, and retention keeps them no longer than 90 days in the beta.

## Critical test scenarios

- Isolation: an ingest token for project A posts a batch claiming project B; the rows land in A. A read token for A asking for B's traces gets 404. Verifies **AC-12**.
- Fleet: agents on two machines with the same project token both appear in that project's fleet and in "All projects". Verifies **AC-13**.
- Alerts: an agent stays silent past its down threshold; each project webhook gets one signed `lousho.alert/1` with `to: "down"`, and a failing webhook is retried 3 times. Verifies **AC-14**.
- Retention: with retention 30, a 31 day old observation is gone after the daily job; a 29 day old one stays. Verifies **AC-15**.
- Deletion: 7 days after an owner's request, a count of every observe table for that org returns zero. Verifies **AC-16**.
- Backends: the existing daemon test suite passes against both `sqliteObserveStore` and `postgresObserveStore`. Verifies **AC-18**.

## Build tasks

1. Define `ObserveStore` and move `store.ts` behind it as `sqliteObserveStore`, making callers async; all daemon tests pass unchanged. Satisfies **AC-18**.
2. `postgresObserveStore` with the same contract tests. Satisfies **AC-13**.
3. Ingest takes org and project from the token. Satisfies **AC-12**, **AC-13**.
4. Token roles, project scoped reads, token routes and the rotate command. Satisfies **AC-12**.
5. Studio reads through the session and `authorize` instead of `LOUSHO_OBSERVE_TOKEN`. Satisfies **AC-12**.
6. Fleet views per project and "All projects". Satisfies **AC-13**.
7. `alert_rule`, `alert_event`, the versioned and signed payload, retries, the daily error rate dedupe, and the 7 day prune. Satisfies **AC-14**.
8. Daily retention job. Satisfies **AC-15**.
9. Org deletion job across every table and the artifact store. Satisfies **AC-16**.

## Rationale

One interface with two backends keeps local use a single file while the hosted service gets a server database, and the shared contract tests stop them drifting (runner up: Postgres everywhere, which would make every local user run a database). Taking the tenant from the token rather than the payload means a leaked or buggy agent can never write into another project.
