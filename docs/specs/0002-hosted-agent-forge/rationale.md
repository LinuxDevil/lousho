# 0002. Run Agent Forge as a hosted service: rationale

## Context

> ⚠️ Premise note: this spans five independent decisions (tenancy and login, the hosted workspace service, execution, observability for many tenants, and deployment), so it is an umbrella with one child each. Two prerequisites have no finished implementation yet: the P1 workspace runtime (`createWorkspaceRuntime` is not in `src/workspaces/runtime/`) and an asynchronous observe store (`src/observe/store.ts` is synchronous on `node:sqlite`). Both are named as step 0 of the build plan rather than assumed.

> ⚠️ Premise note: the product line today is "runs in your own process, no hosted runtime" (`README.md`, `docs/comparison.md`). A Lousho run SaaS changes that promise. The engineer chose it knowingly; the open core split and the self hosted mode keep the original promise true for anyone who wants it.

Lousho agents run inside the user's own Node process, and Agent Forge (the studio) runs on the user's machine. Studio only serves the folder it was launched from: requests for any other registered workspace answer 404 until W02a (`apps/agent-forge/server/workspace/workspaceRoutes.ts:9`). Its login is a random token made at every launch (`src/cli/studio.ts:149`). The observe daemon can bind publicly with tokens, but its token check ignores the token's project (`src/observe/store.ts:697`), so any valid token reads every project.

The gap this leaves is the one competitors fill with a hosted dashboard: a team cannot sign in somewhere shared, build agents together, run them without a server of their own, and see every agent's runs in one place. Self hosting today means one person, one folder, one machine.

`docs/workspaces.md` already plans the shape a hosted product needs: a database backed `WorkspaceSource`, a long running HTTP and SSE service (P2), a typed wire contract (`src/workspaces/client/wire.ts`), and Agent Forge as one client of it. Run, thread and checkpoint stores already have a Postgres backend (`postgresHostBackend`, #1049).

Forces: a very small team, a single Hostinger KVM 2 server the engineer already runs, a free beta budget, EU customers (GDPR), traces that contain personal data, untrusted customer code running on shared infrastructure, and an MIT licensed SDK whose community values self hosting.

Not deciding leaves Lousho without a shared product surface, and every month the folder based Studio grows makes the later move to a service more expensive.

## Options considered

### Audience

**One team, self hosted.** Finish W02a, scope tokens, add a stable login and a Docker image. About 3 to 5 weeks.
Pros: small, mostly finishing started work; keeps the "your own process" promise.
Cons: no product for teams who will not run a server; no path to revenue.

**Several isolated teams, self hosted.** Per team isolation in one instance. About 2 to 3 months.
Pros: fits companies hosting one instance for many teams.
Cons: most of the SaaS tenancy cost without its reach.

**Lousho run SaaS (chosen).** Sign up, organizations, hosted runs.
Pros: reaches teams that will not self host; the same tenancy serves self hosters with many teams.
Cons: largest scope, needs P2, adds operations, GDPR duties and vendor dependencies.

### What launches first

**Hosted observability first.** A hosted collector and dashboard; agents still run at the customer.
Pros: needs no P2; closes the dashboard gap fastest.
Cons: no hosted building or running, the larger half of the product.

**Self hosted single team first.** Items 1 to 4 on today's Studio, SaaS later.
Pros: ships something in weeks.
Cons: auth and storage get rebuilt for SaaS.

**Full hosted Studio first (chosen).** Build P2 as the product.
Pros: one system for both modes; nothing built twice.
Cons: nothing ships until P1, P2 and tenancy all land.

The engineer first picked "ship on today's Studio", then chose SaaS with full hosted Studio first. The later answer governs; the folder based Studio stays as the local, single machine experience.

### Where runs execute

**Fly Machine per run (chosen as the default in SaaS).** Strong isolation, pay per second, fast start.
Cons: a second vendor; machines must be cleaned up or they bill.

**Customer's local runner (chosen as an option).** No customer code on Lousho servers; enables bring your own subscription coding agents (spec 0003).
Cons: nothing runs while the customer's machine is off.

**In process isolate.** Rejected for SaaS: spec 0001 sandboxing states `isolated-vm` is not a security boundary.

### Storage

**Postgres only to start (chosen).** One database for accounts, workspaces, runs and traces.
Cons: heavy trace analytics will outgrow it; ClickHouse is the planned next step.

**Postgres plus ClickHouse.** Rejected for the beta: two databases to run on one small server.

**SQLite per tenant.** Rejected: cross tenant jobs (retention, limits, deletion) and migrations get harder.

### Master key

**Key file on the VPS for the beta (chosen).** Cheapest, no new vendor.
Cons: a VPS compromise exposes all provider keys. Accepted only for a free beta, with KMS required before paid plans.

**AWS KMS standalone.** Recommended during the interview; deferred by the engineer to after the beta.

## Rationale

The hosted service is built as the P2 workspace service because the contracts already exist: a wire route table, a typed client, Postgres backed run and checkpoint stores, and a revision based source design. Building a separate hosted system would duplicate all of it and fork the product.

Organizations, projects and members with `org_id` on every row are designed in from the first migration because adding tenancy after launch means rewriting every query. Better Auth runs inside the service against the same Postgres, gives organizations, OAuth, magic links and SSO later without per user fees, and keeps personal data with Lousho rather than another vendor, which matters for an EU first beta.

A Fly Machine per run is the default because shared infrastructure runs untrusted customer code, and only a virtual machine boundary is safe for that. The same runner program runs inside the machine and on a customer's computer, so the local runner costs little extra and opens the door to spec 0003. Stopping the machine at an approval and resuming from a checkpoint uses durable execution the SDK already has and avoids paying for idle waits.

One Hostinger KVM 2 with Docker Compose fits a free, invite only beta whose heavy compute runs on Fly. The engineer accepted generous per org limits; the deploy child caps the number of beta orgs and defines when to grow the server, because 1M trace events a day per org into one Postgres on two cores is the first thing to break.
