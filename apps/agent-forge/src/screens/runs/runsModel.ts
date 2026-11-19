import { DEFAULT_RUN_INPUT } from '../../../shared/runInput';
import { describeRunSetup } from '../../../shared/runSetup';
import type { ChatMessage, RunListRow, RunSetup } from '../../../shared/wireTypes';
import type { ToolCallState } from '../../ui/ToolCallRow';

export type RunFilter = 'all' | 'live' | 'error';

export interface RunCounts {
  all: number;
  live: number;
  error: number;
}

export interface RunRef {
  workspaceId: string;
  agentId: string;
  chatId: string;
}

export const WIDE_MIN_PX = 1000;

const PREVIEW_CHARS = 120;
const CLIP_CHARS = 600;
const CLIP_LINES = 12;

export const hasChat = (row: RunListRow): row is RunListRow & { chatId: string } => row.chatId !== undefined;

export const refOf = (row: RunListRow & { chatId: string }): RunRef => ({ workspaceId: row.workspaceId, agentId: row.agentId, chatId: row.chatId });

export const sameRun = (a: RunRef, b: RunRef): boolean => a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.chatId === b.chatId;

export const runPath = (ref: RunRef): string =>
  `/w/${encodeURIComponent(ref.workspaceId)}/runs/${encodeURIComponent(ref.agentId)}/${encodeURIComponent(ref.chatId)}`;

export const agentPath = (row: RunListRow): string => `/w/${encodeURIComponent(row.workspaceId)}/agents/${encodeURIComponent(row.agentId)}/canvas`;

export const chatPath = (row: RunListRow): string =>
  row.chatId !== undefined ? `${agentPath(row)}?chat=${encodeURIComponent(row.chatId)}` : agentPath(row);

export function countRuns(rows: readonly RunListRow[]): RunCounts {
  return { all: rows.length, live: rows.filter((r) => r.live).length, error: rows.filter((r) => r.status === 'error').length };
}

export function filterRuns<T extends RunListRow>(rows: readonly T[], filter: RunFilter): T[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => (filter === 'live' ? r.live : r.status === 'error'));
}

export const triggerLabel = (row: RunListRow): string => (row.source === 'trigger' ? (row.triggerId ?? 'trigger') : 'manual');

export const turnsLabel = (turns: number | undefined): string => `${turns ?? 0} ${turns === 1 ? 'turn' : 'turns'}`;

export function runDurationMs(row: RunListRow): number | undefined {
  if (row.live || row.startTime === undefined || row.lastActivity === undefined) return undefined;
  const ms = row.lastActivity - row.startTime;
  return ms > 0 ? ms : undefined;
}

export const lastLine = (row: RunListRow): string => row.lastMessage || row.preview || '(no messages)';

export function clipText(text: string): { shown: string; clipped: boolean } {
  const lines = text.split('\n');
  const byLines = lines.length > CLIP_LINES ? lines.slice(0, CLIP_LINES).join('\n') : text;
  const shown = byLines.length > CLIP_CHARS ? byLines.slice(0, CLIP_CHARS) : byLines;
  return { shown, clipped: shown.length < text.length };
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function previewValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function argPreview(rawArgs: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return rawArgs.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
  }
  const flat =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
          .map(([key, value]) => `${key}: ${previewValue(value)}`)
          .join(', ')
      : previewValue(parsed);
  return flat.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
}

export type StepKind = 'setup' | 'start' | 'message' | 'assistant' | 'tool' | 'end';
export type EndState = 'running' | 'waiting' | 'done' | 'error';

export interface ToolStepData {
  name: string;
  args: string;
  result?: string;
}

export interface TimelineStep {
  id: string;
  kind: StepKind;
  title: string;
  preview?: string;
  time?: string;
  body?: string;
  tool?: ToolStepData;
  toolState?: ToolCallState;
  endState?: EndState;
}

export interface TimelineInput {
  messages: readonly ChatMessage[];
  setup?: RunSetup;
  row: RunListRow;
  failure?: string;
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

function userStep(message: ChatMessage, first: boolean): TimelineStep {
  const isDefault = message.content === DEFAULT_RUN_INPUT;
  const title = message.source === 'steer' ? 'Steered' : first || message.source === 'run' ? 'Run started' : 'Message';
  const marker = isDefault && title === 'Run started';
  return {
    id: message.id,
    kind: title === 'Run started' ? 'start' : 'message',
    title,
    time: message.timestamp,
    ...(!marker && { preview: firstLine(message.content), body: message.content }),
  };
}

function toolState(hasResult: boolean, isError: boolean, row: RunListRow): ToolCallState {
  if (hasResult) return isError ? 'error' : 'done';
  if (row.status === 'paused') return 'waiting';
  return row.live ? 'running' : 'interrupted';
}

function endStep(row: RunListRow, failure: string | undefined): TimelineStep {
  const time = row.live || row.lastActivity === undefined ? undefined : new Date(row.lastActivity).toISOString();
  if (row.status === 'running') return { id: 'end', kind: 'end', title: 'Running…', endState: 'running' };
  if (row.status === 'paused') return { id: 'end', kind: 'end', title: 'Waiting for approval', endState: 'waiting' };
  if (row.status === 'error') return { id: 'end', kind: 'end', title: failure !== undefined ? `Failed: ${failure}` : 'Failed', endState: 'error', ...(time && { time }) };
  return { id: 'end', kind: 'end', title: 'Finished', endState: 'done', ...(time && { time }) };
}

export function buildTimeline({ messages, setup, row, failure }: TimelineInput): TimelineStep[] {
  const visible = messages.filter((m) => m.role !== 'system');
  const results = new Map<string, ChatMessage>();
  for (const m of visible) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m);
  const called = new Set(visible.flatMap((m) => (m.toolCalls ?? []).map((call) => call.id)));
  const steps: TimelineStep[] = [];
  if (setup !== undefined) {
    const { summary, detail } = describeRunSetup(setup);
    steps.push({ id: 'setup', kind: 'setup', title: summary, ...(visible[0] !== undefined && { time: visible[0].timestamp }), ...(detail !== undefined && { body: detail }) });
  }
  let seenUser = false;
  for (const m of visible) {
    if (m.role === 'user') {
      steps.push(userStep(m, !seenUser));
      seenUser = true;
    } else if (m.role === 'assistant') {
      if (m.content.trim() !== '') steps.push({ id: m.id, kind: 'assistant', title: firstLine(m.content), time: m.timestamp, body: m.content });
      for (const call of m.toolCalls ?? []) {
        const result = results.get(call.id);
        steps.push({
          id: `${m.id}:${call.id}`,
          kind: 'tool',
          title: call.function.name,
          preview: argPreview(call.function.arguments),
          time: result?.timestamp ?? m.timestamp,
          tool: {
            name: call.function.name,
            args: prettyJson(call.function.arguments),
            ...(result !== undefined && { result: prettyJson(result.content) }),
          },
          toolState: toolState(result !== undefined, result?.isError === true, row),
        });
      }
    } else if (m.role === 'tool' && !(m.toolCallId !== undefined && called.has(m.toolCallId))) {
      steps.push({
        id: m.id,
        kind: 'tool',
        title: m.toolName ?? m.name ?? 'tool result',
        time: m.timestamp,
        tool: { name: m.toolName ?? m.name ?? 'tool result', args: '', result: prettyJson(m.content) },
        toolState: m.isError === true ? 'error' : 'done',
      });
    }
  }
  steps.push(endStep(row, failure));
  return steps;
}
