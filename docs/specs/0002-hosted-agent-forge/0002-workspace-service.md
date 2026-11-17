# 0002-workspace-service: the hosted workspace service and multi project Studio

## Summary

The workspace service planned as P2 in `docs/workspaces.md` becomes the hosted backend: it stores workspaces in Postgres as revisions, serves the existing wire routes, and Studio talks to it as a client. Each workspace has one shared draft that the team edits; publishing freezes it as a numbered revision that runs pin to. Studio lists every project in the organization and has an "All projects" view, and the same code finishes W02a for self hosted Studio.

## Decision

Implement a `postgresSource` (a `WorkspaceSource` backed by the `workspace` and `workspace_revision` tables) and serve `WORKSPACE_ROUTES` from `src/workspaces/client/wire.ts` with the additive `lousho.wire/1.1` changes below, plus project routes beside them. The hosted Studio uses one shared draft per workspace. Self hosted Studio reads folders through `folderSource` and the same routes, which completes W02a.

## Data model

| Table | Fields | Notes |
|---|---|---|
| `project` | `id`, `org_id`, `name`, `slug`, `trace_retention_days` (default 30, 1 to 90), `created_at` | Unique (`org_id`, `slug`) |
| `workspace` | `id`, `org_id`, `project_id`, `slug`, `current_revision_id` (nullable), `draft_tree` (JSON `WorkspaceTree`), `draft_revision_no` (starts at 0), `base_revision_no` (the published `number` the draft started from, 0 before the first publish), `draft_updated_by`, `draft_updated_at` | Unique (`project_id`, `slug`) |
| `workspace_revision` | `id`, `org_id`, `workspace_id`, `number`, `tree` (JSON `WorkspaceTree`), `content_hash`, `published_by`, `published_at` | Unique (`workspace_id`, `number`); never updated after insert |

In hosted mode there is one shared draft per workspace. The editing routes of the wire contract (`applyOps`, `writeSharedFile`, `writeProfile`, `setPolicy`) write to that draft: their `expectedRevision` is compared with `draft_revision_no`, and each successful save adds 1 to `draft_revision_no`. The several drafts routes (`listDrafts`, `getDraft`, `applyDraft`, `rebaseDraft`, `discardDraft`) answer 405 in hosted mode; the contract keeps them for other hosts.

## State transitions

Draft: `clean` (`draft_tree` equals the tree of revision `base_revision_no`) → `dirty` (any save) → `clean` (publish, or `POST .../draft/discard` which copies the current revision's tree back). Publishing writes `workspace_revision` with `number = max(number) + 1`, sets `current_revision_id`, and sets `base_revision_no` to that number. `draft_revision_no` keeps counting and is never reset.

## Wire contract change

This child and the execution child change the wire contract additively, as `lousho.wire/1.1`: new routes `publishWorkspace` and `discardWorkspaceDraft`, an optional `executor` on `startPageRun` and `startWorkspaceRun`, and the `queued` run status in the run view schemas. No existing field changes meaning; clients of 1.0 keep working except that they may now see `queued`.

## API surface

The existing `WORKSPACE_ROUTES` (`/api/workspaces/...`) are served with the 1.1 changes above. Writes (`effect: 'write'`) carry `expectedRevision`. Added routes:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/projects` | GET | none | projects of the active org | session | none |
| `/api/projects` | POST | `name`, `slug` | project | session, admin | 409 slug taken, 429 limit |
| `/api/projects/:projectId` | PATCH, DELETE | `name`, `trace_retention_days` | project | session, admin | 404, 422 retention out of range |
| `/api/workspaces` (existing `listWorkspaces`) | GET | optional `projectId` query (omit for every project of the active org) | workspace summaries | session | 404 unknown project |
| `/api/workspaces` | POST | `projectId`, `slug`, optional template | workspace | session, member | 409, 404 |
| `/api/workspaces/:id/publish` | POST | `expectedRevision` | the new revision number | session, member | 409 `LOUSHO_REVISION_CONFLICT` |
| `/api/workspaces/:id/draft/discard` | POST | `expectedRevision` | ok | session, member | 409 |
| `/api/runs` | GET | optional `projectId`, `status`, `cursor` | runs across workspaces | session | 404 |

Every query parameter that names a project is `projectId` and takes the project id, never the slug. Run ids are globally unique (`run_` plus a random id), so `/internal/runs/:runId` and `/api/runs` need no workspace in the path; the wire routes keep their workspace segment and check that the run belongs to it.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| List workspaces | which projects | the active org (tenancy child); `projectId` query narrows it |
| Save the draft | the base revision | `expectedRevision` in the body, compared with `draft_revision_no` |
| Conflict reply | the current revision | `workspace.draft_revision_no` |
| Publish | next number | `max(number) + 1` for the workspace, inside the publish transaction |
| Start a run | the pinned revision | `workspace.current_revision_id` at start time, stored on the run |
| "All projects" view | the rows | `/api/runs` and the fleet route `/api/v1/agents`, each without `projectId` |

## Key invariants

- A revision row never changes after insert; `content_hash` is the hash of its canonical tree.
- Publishing takes a row lock on the workspace, so two publishes cannot get the same number.
- A run references a revision id, never the draft.
- Every workspace, revision and run row carries the same `org_id` as its project.

## Security model

Members read and edit; admins also create and delete projects (tenancy child table). Policy files keep the rule from `docs/workspaces.md` (R13): nothing in a workspace can grant a tool, secret, network host or sandbox setting beyond the project's policy limit.

## Critical test scenarios

- Happy path: create project and workspace, edit the draft, publish revision 1, start a run, publish revision 2; the run still reports revision 1. Verifies **AC-6**, **AC-7**.
- Conflict: two members load draft revision 3; the first save succeeds, the second returns 409 `LOUSHO_REVISION_CONFLICT` with the current number. Verifies **AC-6**.
- Studio: an org with three projects shows all three, and the "All projects" view lists runs from each. Verifies **AC-5**.
- Self hosted: Studio started on a machine with two registered folders serves both through `?ws=`. Verifies **AC-5**, **AC-18**.

## Build tasks

1. Migration for `project`, `workspace` and `workspace_revision` with `org_id` on each. Satisfies **AC-6**, **AC-7**.
2. `postgresSource` implementing `WorkspaceSource`, reading a revision tree or the draft. Satisfies **AC-7**.
3. Serve `WORKSPACE_ROUTES` from the service through `authorize`, using `createWorkspaceRuntime` with the Postgres host backend. Satisfies **AC-6**, **AC-7**.
4. Shared draft semantics: editing routes write the one draft, `expectedRevision` checks, the publish and discard routes with the row lock, 405 on the several drafts routes, and the `lousho.wire/1.1` schema changes. Satisfies **AC-6**.
5. Project routes and the project and workspace pickers in Studio, with org switching. Satisfies **AC-5**.
6. The "All projects" view for runs and fleet. Satisfies **AC-5**, **AC-13**.
7. Self hosted: route `?ws=` to every registered folder (W02a) through the same handlers. Satisfies **AC-5**, **AC-18**.

## Rationale

The wire contract, the run stores and the source abstraction already exist, so the hosted backend is an implementation of them rather than a new API. One shared draft keeps the editing model simple for small teams; the contract's support for several drafts stays available if that need appears (runner up: a draft per person, which needs a merge step on publish).
