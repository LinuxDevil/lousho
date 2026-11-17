# 0002-tenancy-auth: organizations, roles and sign in

## Summary

People sign in with GitHub, Google or an email link, belong to organizations with a role, and every request is checked by one function that knows who may do what. Better Auth (a TypeScript sign in library that runs inside the service) owns users, sessions and organizations in Postgres. Admin actions are written to an audit log.

## Decision

Use Better Auth with its organization plugin inside the hosted service, on the same Postgres. Roles are `owner`, `admin` and `member`. One `authorize(actor, action, resource)` function decides every access; routes never check roles themselves. Sign in methods at launch: GitHub OAuth, Google OAuth, magic link email through Resend.

## Data model

Better Auth owns `user`, `session`, `account`, `verification`, `organization`, `member` and `invitation`. Lousho adds:

| Table | Fields | Notes |
|---|---|---|
| `organization` (Better Auth, extended) | `delete_after` timestamp, nullable | Set when the owner requests deletion; null otherwise |
| `member` (Better Auth) | `org_id`, `user_id`, `role` (`owner`, `admin`, `member`) | Unique (`org_id`, `user_id`); exactly one `owner` per org |
| `invitation` (Better Auth) | `org_id`, `email`, `role`, `status`, `expires_at`, `inviter_id` | `expires_at` is creation plus 7 days |
| `usage_limit` | `org_id` (PK), `max_members`, `max_projects`, `max_runners`, `max_runs_per_day`, `max_sandbox_minutes_month`, `max_trace_events_day` | Created in the same transaction as the org, with the defaults in the execution child |
| `audit_event` | `id`, `org_id`, `actor_user_id` (nullable for system), `action`, `target_type`, `target_id`, `at`, `details` (JSON, never a secret value) | Append only; kept 1 year or until the org is deleted, whichever comes first; readable by admins and the owner |
| `waitlist` | `email` (PK), `created_at` | Filled when sign up is refused because the beta is full |

## Permissions

| Action | member | admin | owner |
|---|---|---|---|
| Read workspaces, runs, traces, fleet | yes | yes | yes |
| Edit the draft, publish, start, cancel, approve runs | yes | yes | yes |
| Create, rename, delete projects | no | yes | yes |
| Create and revoke tokens, provider secrets, runners | no | yes | yes |
| Invite, change roles, remove members | no | yes (not the owner) | yes |
| Delete the org, cancel deletion, transfer ownership | no | no | yes |

`LOUSHO_MODE=self` uses the same table. Its first account becomes owner of the single org; `LOUSHO_SELF_SIGNUP=false` (the default) makes later sign ins need an invitation.

## Flows

- **First sign in.** If the person has a pending invitation for their verified email, accepting it is offered first. Otherwise they create an org; when `LOUSHO_BETA_MAX_ORGS` orgs already exist, creation returns 429 `LOUSHO_LIMIT_EXCEEDED` (limit `beta_orgs`), their email goes on the `waitlist`, and Studio shows a waitlist page.
- **Invitations** match the invitee's verified email (the address on the GitHub or Google account, or the magic link address), never an address typed later. Someone already in another org can accept; accepting switches their active org to the new one.
- **Ownership transfer** makes the new member `owner` and the old owner `admin`, in one transaction. The owner cannot leave the org or delete their account while they own it; they transfer first, or delete the org.
- **Leaving and removal.** A member can leave; an admin or owner can remove a member. Both are audited, and the removed member's sessions lose access to that org at once.
- **Sessions** last 30 days, renewed on use, and end after 7 days without use.

## API surface

Better Auth mounts its own routes under `/api/auth/*` (OAuth callbacks, magic link, sessions, organization and invitation calls). Lousho adds:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/orgs/active` | PUT | `orgId` | the active org and role | session | 404 not a member |
| `/api/orgs/:orgId/delete` | POST | none | `deleteAfter` | session, owner | 403 |
| `/api/orgs/:orgId/delete/cancel` | POST | none | ok | session, owner | 403, 409 not pending |
| `/api/orgs/:orgId/transfer` | POST | `userId` | new roles | session, owner | 403, 404 |
| `/api/orgs/:orgId/audit` | GET | `cursor`, `limit` | events | session, admin | 403 |

## Value sourcing

| Action | Value | Source |
|---|---|---|
| Any request | acting user | Better Auth session cookie |
| Any request | active org | `session.activeOrganizationId`, set by `PUT /api/orgs/active`; never from the path alone |
| Any request | role | `member.role` for (active org, user) |
| Any resource read | the resource's org | the row's `org_id`, or through its `project_id` |
| Invitation | expiry | creation time plus 7 days |
| Deletion | `delete_after` | request time plus 7 days |

## Key invariants

- `authorize` compares the resource's `org_id` with the session's active org before checking the role. A mismatch is 404.
- An org always has exactly one owner; removing or demoting the owner is refused (409) unless ownership is transferred first.
- While `delete_after` is set, every member request for that org answers 404 and every token of its projects answers 401.
- Audit events never contain secret values or tokens, only ids and names.

## Security model

Sessions are HTTP only, `Secure`, `SameSite=Lax` cookies. Every state changing request (any method but GET, HEAD, OPTIONS) needs Better Auth's CSRF check and an `Origin` equal to `LOUSHO_PUBLIC_URL`; no GET route changes state, and the SSE stream only reads. CORS allows no other origin. OAuth state and magic links are single use; magic links expire after 15 minutes. Sign in and magic link sends are rate limited per IP and per email. Compliance scope is GDPR: the organization is the controller, Lousho the processor; audit events cover role changes, invitations, member removal and leaving, token, secret and runner changes, deletion requests and ownership transfers.

## Critical test scenarios

- Happy path: GitHub sign in, create org, invite a second user by email, they accept and appear as `member`. Verifies **AC-1**, **AC-2**.
- Isolation: a member of org A requests a workspace, run, trace and token id of org B by guessing ids; every call returns 404. Verifies **AC-3**.
- Permission: a `member` calls token creation and receives 403 `LOUSHO_FORBIDDEN`. Verifies **AC-4**.
- Deletion: the owner deletes the org; a member's next request returns 404 and an ingest token returns 401; cancel within 7 days restores both. Verifies **AC-16**.

## Build tasks

1. Add Better Auth with the organization plugin on Postgres, GitHub OAuth only, session lifetimes, CSRF and origin checks, and create the org with its `usage_limit` row on first sign in, with the beta cap and waitlist. Satisfies **AC-1**, **AC-17**.
2. Implement `authorize(actor, action, resource)` with the permissions table and the 404 rule; wire it into every service route through one middleware. Satisfies **AC-3**, **AC-4**.
3. Add `PUT /api/orgs/active` and make every query filter by the active org. Satisfies **AC-3**, **AC-5**.
4. Add Google OAuth and magic link through Resend. Satisfies **AC-1**.
5. Invitations with roles, verified email matching, the 7 day expiry, and leaving and removal. Satisfies **AC-2**.
6. The `audit_event` table and writes for every admin action. Satisfies **AC-4**.
7. Org deletion request, cancel and ownership transfer; the disabled state checks. Satisfies **AC-16**.

## Rationale

Better Auth keeps users and organizations in the service's own Postgres, adds organizations and SSO through plugins, and has no per user fee, which suits an EU first, free beta (runner up: WorkOS, stronger enterprise SSO but another processor and per connection pricing). Returning 404 rather than 403 across organizations avoids confirming that another org's ids exist.
