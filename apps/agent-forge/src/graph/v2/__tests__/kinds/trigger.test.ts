import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, TriggerSpec } from '../../specTypes';
import type { Graph, Problem, TriggerNodeData } from '../../types';
import { validateGraph } from '../../validateGraph';
import { TRIGGER_VIEW } from '../../../../canvas/kinds/trigger';

/** The ticket's worked example: one trigger of each type. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
triggers:
  - { id: t1, type: chat }
  - { id: t2, type: cron, cron: '0 9 * * 1-5', timezone: Europe/Amsterdam, prompt: Post the daily summary }
  - { id: t3, type: webhook, path: /hooks/zendesk, secret: { secret: zendesk-hmac }, promptTemplate: 'New ticket: {{event.body.subject}}' }
  - { id: t4, type: channel, channel: slack, secrets: { signingSecret: { secret: slack-signing }, botToken: { env: SLACK_BOT_TOKEN } } }
  - { id: t5, type: agent, after: triage, on: done, promptTemplate: 'Follow up: {{run.resultText}}' }
`;

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(triggers: TriggerSpec[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ triggers }));
}

function nodeById(graph: Graph, id: string): TriggerNodeData {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node.data as TriggerNodeData;
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('specToGraph: trigger worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec);

  it('gives each trigger its card title and chip', () => {
    const [t1, t2, t3, t4, t5] = graph.nodes.slice(1) as Array<
      Extract<Graph['nodes'][number], { kind: 'trigger' }>
    >;
    expect(TRIGGER_VIEW.title(t1)).toBe('Chat');
    expect(TRIGGER_VIEW.title(t2)).toBe('Schedule');
    expect(TRIGGER_VIEW.chip?.(t2)).toBe('0 9 * * 1-5');
    expect(TRIGGER_VIEW.title(t3)).toBe('Webhook');
    expect(TRIGGER_VIEW.chip?.(t3)).toBe('/hooks/zendesk');
    expect(TRIGGER_VIEW.title(t4)).toBe('Slack');
    expect(TRIGGER_VIEW.chip?.(t4)).toBe('slack');
    expect(TRIGGER_VIEW.title(t5)).toBe('After triage');
    expect(TRIGGER_VIEW.chip?.(t5)).toBe('on done');
  });

  it('clips the prompt and template rows to their first line and 40 characters', () => {
    const g = graphOf([
      { id: 't2', type: 'cron', cron: '* * * * *', prompt: `${'p'.repeat(45)}\nmore` },
      { id: 't3', type: 'webhook', path: '/h', promptTemplate: 'line one\nline two' },
      { id: 't5', type: 'agent', after: 'a', on: 'done', promptTemplate: 'q'.repeat(40) },
    ] as TriggerSpec[]);
    const [t2, t3, t5] = g.nodes.slice(1) as Array<Extract<Graph['nodes'][number], { kind: 'trigger' }>>;
    expect(TRIGGER_VIEW.rows(t2)).toEqual([{ k: 'prompt', v: `${'p'.repeat(39)}…` }]);
    expect(TRIGGER_VIEW.rows(t3)).toEqual([{ k: 'template', v: 'line one' }]);
    expect(TRIGGER_VIEW.rows(t5)).toEqual([{ k: 'template', v: 'q'.repeat(40) }]);
  });
});

describe('triggerRules.validate', () => {

  it('rejects an unknown time zone', () => {
    const graph = graphOf([
      { id: 't1', type: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus', prompt: 'go' },
    ]);
    expect(validateGraph(graph)).toStrictEqual([
      error('trigger:t1', "Unknown time zone 'Mars/Olympus'", 'triggers[0].timezone'),
    ]);
  });

  it('flags two webhook triggers sharing a path, on both', () => {
    const graph = graphOf([
      { id: 't1', type: 'webhook', path: '/hooks/x', promptTemplate: 'a' },
      { id: 't2', type: 'webhook', path: '/hooks/x', promptTemplate: 'b' },
    ]);
    expect(validateGraph(graph)).toStrictEqual([
      error('trigger:t1', "Two webhooks use the path '/hooks/x'", 'triggers[0].path'),
      error('trigger:t2', "Two webhooks use the path '/hooks/x'", 'triggers[1].path'),
    ]);
  });

  it('rejects an agent trigger that follows nobody', () => {
    const graph = graphOf([{ id: 't1', type: 'agent', after: '', on: 'done', promptTemplate: 'x' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('trigger:t1', 'Pick the agent this follows', 'triggers[0].after'),
    ]);
  });

  it('lets the core check flag two triggers sharing an id', () => {
    const graph = graphOf([
      { id: 't1', type: 'chat' },
      { id: 't1', type: 'chat' } as TriggerSpec,
    ]);
    const messages = validateGraph(graph).map((p) => `${p.nodeId}: ${p.message}`);
    expect(messages).toContain("trigger:t1: Two triggers use the id 't1'");
    expect(messages).toContain("trigger:t1#2: Two triggers use the id 't1'");
  });
});

describe('triggerRules.duplicateData', () => {

  it('suffixes a webhook copy\'s path with -copy', () => {
    const g = graphOf([{ id: 't1', type: 'webhook', path: '/hooks/x', promptTemplate: 'a' }]);
    const dup = duplicateNode(g, 'trigger:t1');
    expect(dup.nodeId).toBe('trigger:t2');
    expect(nodeById(dup.graph, 'trigger:t2').item).toStrictEqual({
      id: 't2',
      type: 'webhook',
      path: '/hooks/x-copy',
      promptTemplate: 'a',
    });
  });
});
