import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TriggerRegistry } from 'lousho/triggers';
import type { LegacyAgentStore } from '../../../src/persistence/AgentStore';
import type { RunManager } from '../../runRegistry';
import { AgentRepo } from '../../storage/agentRepo';
import { DraftStore } from '../../storage/draftStore';
import { StudioEventBus } from '../../events/eventBus';
import type { AgentHost } from '../../host/agentHost';
import { SuggestionStore } from '../../storage/suggestionStore';
import { VersionStore } from '../../storage/versionStore';
import { IdleVersioner } from '../../storage/idleVersioner';
import { singleWorkspace, type WorkspaceContext, type WorkspaceResolver } from '../context';
import { requestedWorkspaceId, workspaceMiddleware, workspaceOf } from '../middleware';

const emptyStore: LegacyAgentStore = {
  list: async () => [],
  load: async () => undefined,
  save: async () => {},
  remove: async () => {},
};

function ctx(id: string): WorkspaceContext {
  const repo = new AgentRepo(`/root/${id}`);
  return {
    ref: { id, name: id, root: `/root/${id}`, addedAt: 'a', lastOpenedAt: 'a' },
    repo,
    agentStore: emptyStore,
    versions: new VersionStore(repo),
    drafts: new DraftStore(repo),
    idleVersioner: new IdleVersioner({ capture: async () => {} }),
    suggestions: new SuggestionStore(repo),
    host: {} as AgentHost,
    runs: {} as RunManager,
    chatTriggers: new TriggerRegistry(),
    events: new StudioEventBus(),
  };
}

/** A bare app: the middleware, then one route echoing the resolved workspace id. */
function appWith(resolver: WorkspaceResolver) {
  const app = express();
  app.use(express.json());
  app.use(workspaceMiddleware(resolver));
  app.get('/echo', (req, res) => res.json({ id: workspaceOf(req).ref.id }));
  // Same fallback error shape app.ts uses.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const main = ctx('main-abc123');
const app = appWith(singleWorkspace(main));

describe('workspaceMiddleware (single workspace)', () => {

  it.each(['../x',])(
    'malformed id %s is a 400 LOUSHO_WORKSPACE_ID_INVALID',
    async (bad) => {
      const res = await request(app).get('/echo').set('x-lousho-workspace', bad);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid workspace id', code: 'LOUSHO_WORKSPACE_ID_INVALID' });
    }
  );
});

describe('requestedWorkspaceId', () => {
  it('prefers a non-empty trimmed header over the query', async () => {
    const seen: (string | undefined)[] = [];
    const probe = express();
    probe.get('/probe', (req, res) => {
      seen.push(requestedWorkspaceId(req));
      res.end();
    });
    await request(probe).get('/probe?ws=query-id').set('x-lousho-workspace', '  header-id  ');
    await request(probe).get('/probe?ws=query-id');
    await request(probe).get('/probe').set('x-lousho-workspace', '   ');
    expect(seen).toEqual(['header-id', 'query-id', undefined]);
  });
});
