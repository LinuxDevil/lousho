# 0002. Run Agent Forge as a hosted service

**Date**: 2026-11-11
**Status**: Accepted

## Summary

This spec turns Agent Forge into a hosted service that teams sign up for, while it stays self hostable. Customers sign in, create an organization, build agents in shared workspaces, run them in isolated cloud machines or on their own computers, and watch every run in one place. It launches as a free, invite only beta on one Hostinger server in the EU, with customers bringing their own model keys. The work builds on the workspaces service already planned in `docs/workspaces.md`, so that service, not a new system, becomes the hosted product.

## Structure

This is an umbrella spec. Each child is complete enough to build from on its own. Cross child rules live below under *Shared contracts*.

- [0002-tenancy-auth.md](0002-tenancy-auth.md): organizations, members, roles, sign in with Better Auth, invitations, and the one access check every route uses. Supports the tenancy and login decisions.
- [0002-workspace-service.md](0002-workspace-service.md): the hosted workspace service on Postgres, the shared draft and revisions, and Studio showing every project plus an "All projects" view (this also finishes W02a for self hosting). Supports the "full hosted Studio first" decision.
- [0002-execution.md](0002-execution.md): where runs execute (a Fly Machine per run by default, or the customer's local runner), checkpoint and resume on approval, provider keys with envelope encryption, and beta limits. Supports the execution and model keys decisions.
- [0002-observability-saas.md](0002-observability-saas.md): one trace store interface with SQLite and Postgres backends, tokens scoped by project and role, the central collector, fleet views, alert rules, retention and deletion. Supports the fleet and data decisions.
- [0002-deploy.md](0002-deploy.md): the Docker Compose stack on a Hostinger KVM 2, backups to Cloudflare R2, email through Resend, monitoring, capacity triggers, and the self hosted image. Supports the hosting decision.

## Requirements

**User stories**:
- As a developer, I want to sign up with GitHub, Google or an email link and get an organization, so that my team can build agents without running servers.
- As an org admin, I want to invite teammates with a role and manage projects, keys, model secrets and runners, so that access stays under my control.
- As a member, I want to edit a workspace with my team, publish it, and run it, so that we ship agents together without overwriting each other.
- As a member, I want every run to execute in isolation and pause for approvals without burning compute, so that runs are safe and cheap.
- As an operator of agents on many machines, I want them all to report to one place and alert me when something breaks, so that I can see the whole fleet.
- As a self hoster, I want the same product in one Docker image, so that I can run it on my own server with my own sandbox choice.

**Acceptance criteria** (the contract):
- **AC-1**: A person can sign in with GitHub, Google or a magic link email. On first sign in they create an organization and become its owner.
- **AC-2**: An owner or admin can invite someone by email with a role. The invitation expires after 7 days. Accepting it adds a member with that role.
- **AC-3**: Every read and write of organization data is limited to the caller's active organization. A member of org A asking for any resource of org B gets 404, never the resource and never 403.
- **AC-4**: A member can edit drafts, publish, start and cancel runs, approve run steps, and read traces. Only an admin or owner can manage projects, tokens, provider secrets, runners and invitations. Only the owner can delete the organization or transfer ownership. A member calling an admin route gets 403 with code `LOUSHO_FORBIDDEN`.
- **AC-5**: Studio lists every project and workspace of the active organization, and an "All projects" view lists runs and fleet agents across them. Switching organization switches everything shown.
- **AC-6**: Editing a workspace changes its one shared draft. A save carrying a stale `expectedRevision` is rejected with 409 and the current revision number. Publishing turns the draft into an immutable revision numbered one higher than the last.
- **AC-7**: A run is pinned to the published revision it started from. Later publishes do not change a run in flight or its record.
- **AC-8**: By default a cloud run executes in its own Fly Machine. Provider secrets reach that machine only for that run. The machine is destroyed when the run reaches any final status.
- **AC-9**: When a run needs an approval it checkpoints, its machine is destroyed, and its status becomes `needs-approval`. On approval a new machine resumes from the checkpoint. No machine runs while the run waits.
- **AC-10**: An admin can register a local runner for a project. A run started with executor `runner` goes to an online runner of that project. With no runner online, the run waits in `queued` for up to 10 minutes, then fails with `LOUSHO_RUNNER_UNAVAILABLE`.
- **AC-11**: Provider secrets are stored with envelope encryption. Plaintext never appears in the database, logs, traces or any API response; reads return the name, creator and timestamps only.
- **AC-12**: An ingest token can only write data for its own project. A read token can only read its own project; asking for another project's data returns 404. Studio reads with the signed in session, never a shared token.
- **AC-13**: Agents on any machine report to the central collector by setting `LOUSHO_OBSERVE` and `LOUSHO_OBSERVE_TOKEN`. The fleet view shows them per project and in the "All projects" view.
- **AC-14**: Each project can set alert thresholds (missed heartbeats before `down`, error rate percentage). Alerts are posted to the project's webhooks with a versioned payload `lousho.alert/1`. Agents silent for 7 days leave the fleet list; their traces stay until retention removes them.
- **AC-15**: Traces older than the project's `trace_retention_days` (default 30, at most 90 in the beta) are deleted by a daily job.
- **AC-16**: When an owner deletes the organization, it is disabled at once: members get 404 on its resources and its tokens get 401. After 7 days every row, trace, artifact and secret of the organization is removed. The owner can cancel during those 7 days.
- **AC-17**: Beta limits apply per organization. Going over a limit on an API call returns 429 with code `LOUSHO_LIMIT_EXCEEDED` naming the limit. Trace ingest over its limit drops events and counts them; it never blocks the agent.
- **AC-18**: The same image runs self hosted with `LOUSHO_MODE=self`: one organization, no Fly account needed, SQLite or Postgres, and any sandbox driver.
- **AC-19**: After a server restart, runs that were in flight show `interrupted` and can be resumed from their last checkpoint. A nightly backup restores into a fresh Postgres, proven by a restore drill.

## Decision

**Chosen option**: Hosted workspace service first, as open core, on one EU server for a free beta.

Build the planned P2 workspace service as the hosted product: Better Auth organizations on Postgres, Studio as its client, runs in a Fly Machine per run (or a customer's local runner), the observe collector on a shared store interface, and Docker Compose on a Hostinger KVM 2. Customers bring their own model keys.

### Shared contracts

- **Tenancy invariant.** Every tenant owned row carries `org_id` and, below the org level, `project_id`. The organization and project of a request come from the session or token, never from the request body or path alone. A lookup that finds a row of another organization answers 404.
- **One access check.** All routes go through one `authorize(actor, action, resource)` function (see the tenancy child). No route checks roles itself.
- **Two modes, one codebase.** `LOUSHO_MODE=saas` turns on sign up, organizations, Fly sandboxes and beta limits. `LOUSHO_MODE=self` creates one organization at first start and uses whatever sandbox driver is configured. Both modes run the same routes and the same `authorize`.
- **Run status vocabulary.** Runs use the existing `RunState` from `src/workspaces/runtime/stores.ts` (`running`, `ok`, `failed`, `timed-out`, `cancelled`, `needs-approval`, `interrupted`) plus one new state, `queued`. No second status list exists. Run ids become globally unique (`run_` plus a random id).
- **Wire contract 1.1.** Adding `queued`, an optional `executor`, and the publish and discard routes is an additive change to `src/workspaces/client/wire.ts`, versioned `lousho.wire/1.1` (workspace service child). In hosted mode the several drafts routes answer 405.
- **Project parameters.** Every query parameter naming a project is `projectId` and takes the id.
- **Open core boundary.** Everything in this spec is MIT in this repo, except the SaaS operations package (admin console, beta limit management screens, abuse controls, later billing), which lives in a private package and plugs in through a `CloudExtensions` object passed at service start.
- **Error codes.** New codes follow `docs/errors.md`: `LOUSHO_FORBIDDEN`, `LOUSHO_LIMIT_EXCEEDED`, `LOUSHO_RUNNER_UNAVAILABLE`, `LOUSHO_SANDBOX_UNAVAILABLE`, `LOUSHO_SECRET_UNAVAILABLE`, `LOUSHO_REVISION_CONFLICT`.

## Build plan

No build approach is recorded for this repo, so this plan assumes thin end to end slices (Tracer Bullet): the first slice runs one real run through every layer, later slices widen it. Detailed tasks live in each child; this is the order across them.

0. **Prerequisites, not part of this spec but blocking it.** The P1 workspace runtime (`createWorkspaceRuntime`, the `single` engine) from `docs/workspaces.md`, and making the observe store asynchronous behind an interface (observability child, task 1). Neither changes behavior for local users. Satisfies **AC-7**, **AC-13**.
1. **Thin thread.** GitHub sign in, one organization, one project, a database backed workspace, publish, one run in a Fly Machine, its trace visible in Studio. Tasks: tenancy 1 to 3, workspace service 1 to 3, execution 1 to 3, observability 2 to 3, deploy 1. Satisfies **AC-1**, **AC-6**, **AC-7**, **AC-8**, **AC-13**.
2. **Real tenancy.** Google and magic link sign in, invitations, roles, cross org isolation tests, org switching. Tenancy 4 to 7. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**.
3. **Team editing and multi project Studio.** Draft conflicts, revision history, the project list and "All projects" view, the same code serving self hosted W02a. Workspace service 4 to 7. Satisfies **AC-5**, **AC-6**.
4. **Safe, cheap execution.** Envelope encrypted secrets, checkpoint and resume on approval, the leaked machine sweep, the local runner, beta limits. Execution 4 to 9. Satisfies **AC-8**, **AC-9**, **AC-10**, **AC-11**, **AC-17**.
5. **Fleet and data rules.** Token roles, fleet views, alert rules, retention and deletion jobs. Observability 4 to 9. Satisfies **AC-12**, **AC-13**, **AC-14**, **AC-15**, **AC-16**.
6. **Operate it.** Backups and a restore drill, uptime checks, dogfooded monitoring, capacity alarms, the self hosted image and guide. Deploy 2 to 6. Satisfies **AC-18**, **AC-19**.

## Consequences

**Positive**:
- The "no hosted dashboard" gap closes with a product, and the same code gives self hosters a real multi project, multi member Studio.
- The planned P2 service is built once and serves both modes; no parallel hosted system.
- Runs are isolated per machine, so one customer's code cannot touch another's.

**Negative / tradeoffs**:
- This is the largest item on the roadmap: it waits on the P1 runtime and an async observe store, and is months of work before the first outside user.
- It reverses the public line "Lousho has no hosted runtime" (`README.md`, `docs/comparison.md`). Both pages need rewording before launch.
- One VPS is a single point of failure: a Hostinger outage takes the whole beta down until it returns or a backup is restored elsewhere.
- The master key sits in a file on that same VPS for the beta, so a compromise of the server exposes every customer's provider keys. Moving to a KMS is required before any paid plan.
- Customer data now includes prompts and outputs, which often hold personal data; GDPR duties (a privacy policy, a processor list, erasure within the stated window) become real obligations.
- Audit logs are required for this compliance scope: admin actions (role changes, secret writes, token creation, deletion requests) must be recorded and kept, see the tenancy child.

**Neutral**:
- Two database backends (SQLite and Postgres) must stay in step; one contract test suite runs against both.
- Fly.io becomes a second vendor in the critical path for cloud runs.

## Migration plan

**Strategy**: strangler. Local and self hosted users keep today's behavior while the hosted mode grows beside it.
**Phases**:
1. Refactor the observe store to an async interface over SQLite; add nullable `org_id`, `project_id` and token `role` columns with defaults. Ship to everyone; nothing changes for local users.
2. Add the Postgres backend and the hosted service behind `LOUSHO_MODE=saas`; deploy only to the beta server.
3. Ship the self hosted image (`LOUSHO_MODE=self`) once slice 3 lands; the folder based `lousho studio` keeps working for single machine use.
**Rollback**: phase 1 is reversible by reverting its release (the new columns are nullable and ignored by older code). Phases 2 and 3 are new deployments; rolling back means stopping the beta service, with no effect on local users.
**Risks**: the async store refactor touches every daemon route and the eval workers; the existing daemon tests must pass unchanged before phase 2 starts.

## Follow-up

- [ ] Move the master key from the VPS file to a KMS (AWS KMS in an EU region is the planned target) before any paid plan.
- [ ] Reword the "no hosted runtime" lines in `README.md` and `docs/comparison.md` before the beta opens.
- [ ] Write the privacy policy and processor list (Hostinger, Fly.io, Resend, Cloudflare R2, the auth providers), and sign data processing agreements with Fly.io and Resend, before inviting the first outside org.
- [ ] GDPR features not in this spec: export of an org's data, erasure of one user's personal data without deleting the org, and optional redaction of prompt and output text in traces.
- [ ] Spec 0003: orchestrating external coding agents (Claude Code, Codex, OpenCode and others) over ACP through the local runner, with each user's own subscription.
- [ ] Decide billing (Stripe, what is metered) once the beta shows real usage.
- [ ] Revisit ClickHouse for traces when the capacity triggers in the deploy child fire.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).
