# 0002-execution: where runs execute

## Summary

Every hosted run executes outside the service process: by default in its own Fly Machine (a small virtual machine started for one run and destroyed after), or on a local runner the customer installs. Both run the same `lousho runner` program, which fetches its run, executes it, streams events back and exits. A run that waits for approval saves a checkpoint and stops its machine, then resumes on a new one. Customers' model keys are stored encrypted and reach a machine only for its run.

## Decision

Add an execution driver seam with two drivers: `fly` (one Fly Machine per run, SaaS default) and `runner` (a registered local runner). Self hosted mode can configure either, or the existing in process path. The runner program is the same binary in both cases. Provider secrets use envelope encryption with a master key file on the server for the beta.

## Data model

| Table | Fields | Notes |
|---|---|---|
| run (existing run store, extended) | adds `org_id`, `executor` (`fly`, `runner`, `local`), `runner_id` (nullable), `trace_id`, `requested_by`, `queued_at` (reset on every requeue), `attempt`, `max_duration_ms`, `last_event_at`, `approval_expires_at` (nullable), `approved_by` (nullable), `approval_decision` (nullable JSON, the `approveRun` body) | Status is `RunState` plus `queued`; `runId` is globally unique (`run_` plus a random id) |
| `sandbox_session` | `id`, `org_id`, `run_id`, `attempt`, `fly_machine_id`, `region`, `status` (`starting`, `running`, `stopped`, `failed`), `started_at`, `stopped_at` | Unique (`run_id`, `attempt`); one per machine started |
| `runner` | `id`, `org_id`, `project_id`, `name`, `token_id`, `version`, `capabilities` (JSON), `last_heartbeat_at`, `created_by` | Online when the last heartbeat is under 90 seconds old |
| `provider_secret` | `id`, `org_id`, `project_id`, `name`, `ciphertext`, `iv`, `wrapped_data_key`, `key_version`, `created_by`, `created_at`, `updated_at` | Unique (`project_id`, `name`) |

## State transitions

`queued` → `running` → `ok` | `failed` | `timed-out` | `cancelled`
`running` → `timed-out` (the service, when `now - started_at > max_duration_ms`)
`running` → `needs-approval` (the runner reports it) → `queued` (on `approveRun`, `attempt` + 1, `queued_at` reset) or `cancelled` (when `approval_expires_at`, 7 days after the wait began, passes)
`running` → `interrupted` (no event or heartbeat for 120 seconds, or Fly reports the machine stopped) → `queued` (one automatic retry from the checkpoint, then it stays `interrupted` for a person to resume)
`queued` → `failed` (no runner claims it within 10 minutes of `queued_at`: `LOUSHO_RUNNER_UNAVAILABLE`, including after an approval; machine failed to start twice: `LOUSHO_SANDBOX_UNAVAILABLE`)

`max_duration_ms` is the page's `execution.limits` duration when set, else 60 minutes, and never more than the org's remaining sandbox minutes this month for `fly` runs. The 5 minute sweep applies every time based rule above.

## How a run executes

1. The service records the run as `queued` and enforces the org's limits.
2. For `fly`, the service creates a machine (size `FLY_MACHINE_SIZE`, default `shared-cpu-1x` with 512 MB, no restart policy) from the runner image in `FLY_REGION`, passing only `RUN_ID`, `LOUSHO_PUBLIC_URL` and a run token. A run token is random, stored hashed in `tokens` with roles `{run}`, valid for this attempt only, expires at `max_duration_ms` plus 10 minutes, and is revoked when the attempt ends. Secrets are never put in the machine config.
3. The runner calls `POST /internal/runs/:runId/bootstrap` with its run token and receives the revision tree, the effective policy, the decrypted provider secrets it is allowed, and an ingest token for its project with the same lifetime and revocation as the run token.
4. It runs the page with `createWorkspaceRuntime`, posts events to `POST /internal/runs/:runId/events` (an empty heartbeat batch at least every 30 seconds, which updates `last_event_at`), writes checkpoints through the service, and sends traces to the collector.
5. Outbound network from the machine is limited to the project policy's `network.allowHosts` plus the service and the model providers the policy names; everything else is blocked by the machine's egress rules.
6. On a final status or `needs-approval` it reports, then exits; the machine is created with auto destroy, and the service also destroys it explicitly.
7. A sweep every 5 minutes destroys any machine running longer than `max_duration_ms` plus 10 minutes, or whose run is final, so a stuck machine cannot keep billing.

For `runner`, steps 3, 4 and 6 are the same; the runner gets work by long polling `POST /api/runners/claim` with its runner token, receives the run id and its run token together, and sends a heartbeat every 30 seconds. Outbound limits on a runner are the customer's business. `local` (in the service process, as `lousho studio` does today) is accepted only when `LOUSHO_MODE=self`.

## API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/projects/:projectId/secrets` | GET | none | names, creator, timestamps | session, admin | 403 |
| `/api/projects/:projectId/secrets/:name` | PUT, DELETE | `value` (PUT) | name, timestamps | session, admin | 403, 422 |
| `/api/projects/:projectId/runners` | GET, POST | `name` (POST) | runners; POST returns a one time runner token | session, admin | 403, 429 |
| `/api/runners/:runnerId` | DELETE | none | ok (revokes its token) | session, admin | 403, 404 |
| `/api/runners/claim` | POST | `capabilities`, `version` | `{ runId, runToken }`, or 204 after 25 seconds | runner token | 401 |
| `/api/runners/heartbeat` | POST | `activeRunId` | ok | runner token | 401 |
| `/internal/runs/:runId/bootstrap` | POST | none | tree, policy, secrets, ingest token | run token | 401, 410 run final |
| `/internal/runs/:runId/events` | POST | event batch | ok | run token | 401, 410 |
| `/internal/runs/:runId/checkpoints` | PUT, GET | checkpoint | ok, checkpoint | run token | 401 |

`startPageRun` and `startWorkspaceRun` in the wire contract gain an optional `executor` (`fly` or `runner`, plus `local` in self mode; default `fly` in SaaS, `LOUSHO_EXECUTOR` in self mode). This is part of `lousho.wire/1.1` (workspace service child). `approveRun` keeps its body; the service stores it as `approval_decision` with `approved_by`.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| Start a run | executor | request `executor`, else the mode default |
| Bootstrap | revision tree | `workspace_revision.tree` for the run's pinned revision |
| Bootstrap | allowed secrets | the project's `provider_secret` rows named by the effective policy's `secrets` |
| Bootstrap | ingest token | a token with roles `{ingest}` for the run's project, created per attempt |
| Machine | region | `FLY_REGION` |
| Limits | today's run count, this month's sandbox minutes | count of runs since UTC midnight; sum of `stopped_at - started_at` for the org this UTC month |
| Runner online | status | `now - last_heartbeat_at < 90 seconds` |
| Run limit | `max_duration_ms` | page `execution.limits`, else 60 minutes, capped by remaining sandbox minutes |
| Interrupted | lost run | `now - last_event_at > 120 seconds`, or the Fly machine state |
| Approval expiry | `approval_expires_at` | the time the run entered `needs-approval` plus 7 days |

## Beta limits (defaults for each new org)

20 members, 10 projects, 5 runners, 1,000 runs a day, 3,000 sandbox minutes a month, 1,000,000 trace events a day. Stored in `usage_limit` (with `max_runners` added) and changeable per org by the operator.

## Key invariants

- A secret's plaintext exists only in the service's memory while encrypting or answering a bootstrap, and in the runner's memory during its run.
- Each secret has its own random data key (AES-256-GCM). The data key is wrapped with a per org key derived from the master key with HKDF (salt: the `org_id`), so code handling one org can never unwrap another org's data keys. `key_version` allows master key rotation by rewrapping data keys.
- Run and ingest tokens issued for a run never outlive it.
- A run token works for one run attempt only and is revoked when that attempt ends.
- At most one machine or runner holds a run attempt; `claim` uses `SELECT ... FOR UPDATE SKIP LOCKED`.

## Security model

Machines have no inbound ports and reach only the hosts allowed above. Customer code inside a machine can still read the secrets given to its run; that is accepted because those keys belong to the customer, and the egress limit stops them being sent elsewhere. Runners connect out only. Admins manage secrets and runners; members choose the executor when starting runs. A runner token belongs to one project and can claim only that project's runs. Secret writes and runner registration are audited.

## Critical test scenarios

- Happy path: a run starts a machine, bootstraps, finishes `ok`, and the machine is gone within a minute. Verifies **AC-8**.
- Approval: a run reaches an approval step, its machine is destroyed, status is `needs-approval`; approving starts attempt 2 on a new machine that continues from the checkpoint. Verifies **AC-9**.
- Runner: with no runner online, a runner run waits, then fails at 10 minutes with `LOUSHO_RUNNER_UNAVAILABLE`; with one online it is claimed within one poll. Verifies **AC-10**.
- Secrets: after `PUT` a secret, no database column, log line, trace or API reply contains its value. Verifies **AC-11**.
- Limits: the 1,001st run of the day returns 429 `LOUSHO_LIMIT_EXCEEDED` naming `max_runs_per_day`. Verifies **AC-17**.
- Leak sweep: a machine whose run is final is destroyed by the next sweep. Verifies **AC-8**.

## Build tasks

1. The `lousho runner` program: bootstrap, run with `createWorkspaceRuntime`, post events and checkpoints, exit. Satisfies **AC-8**.
2. The `fly` driver: create and destroy a machine through the Machines API, the runner image, machine size, egress limits, the `sandbox_session` table. Satisfies **AC-8**.
3. Run token issue, check, expiry and revocation, the per run ingest token, and the `/internal/runs/*` routes. Satisfies **AC-8**, **AC-11**.
4. Envelope encryption with per org derived keys for `provider_secret`, and the secret routes. Satisfies **AC-11**.
5. Approval: checkpoint, destroy, store the decision, requeue as a new attempt, resume, and the 7 day expiry. Satisfies **AC-9**.
6. Interrupted runs: heartbeats through the events route, detection on the sweep and on service start, one automatic retry from the checkpoint; the `timed-out` rule. Satisfies **AC-19**.
7. The leaked machine sweep. Satisfies **AC-8**.
8. Local runner registration, claim by long poll, heartbeat, the 10 minute queue timeout. Satisfies **AC-10**.
9. `usage_limit` defaults and checks on run start, member, project and runner creation, and the sandbox minutes cap on `max_duration_ms`. Satisfies **AC-17**.

## Rationale

A virtual machine per run is the only boundary that is safe for untrusted code on shared servers; `isolated-vm` is explicitly not one (spec 0001 sandboxing). Fly Machines start fast and bill per second (runner up: E2B, less work but another vendor holding customer code). Making the cloud sandbox and the local runner the same program means one execution path to test, and the runner is the foundation for spec 0003. Passing secrets through an authenticated bootstrap call instead of machine environment keeps them out of Fly's machine configuration.
