/**
 * Translators from the SDK's execution event streams to the structured
 * `LogEntry` rows the Logs tab renders. Used by runRegistry.ts.
 */
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventOf, AgentEventType } from 'lousho';
import type { FlowExecutionEvent, FlowExecutionEventOf } from 'lousho/flows';
import { CONNECTORS, INTEGRATION_SECRETS } from '../shared/profileWire';
import { RUN_SETUP_PREFIX } from '../shared/runSetup';
import type { LogEntry, RunSetup, RunSetupSkipped } from '../shared/wireTypes';

/** The event-specific part of a `LogEntry`; id/agentId/timestamp are added by the translators. */
type LogBody = Pick<LogEntry, 'level' | 'phase' | 'message'> & Partial<Pick<LogEntry, 'toolName' | 'detail'>>;

function truncate(text: string | undefined, max = 400): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toEntry(agentId: string, timestampSource: Date, body: LogBody): LogEntry {
  const timestamp = (timestampSource instanceof Date ? timestampSource : new Date()).toISOString();
  return { id: randomUUID(), agentId, timestamp, ...body };
}

type AgentLogBuilders = {
  [K in AgentEventType]?: (event: AgentEventOf<K>, agentId: string) => LogBody;
};

const AGENT_LOG_BUILDERS: AgentLogBuilders = {
  'run.start': (event, agentId) => ({
    level: 'info',
    phase: 'trigger',
    message: `Run started for agent '${event.agentName || agentId}'`,
  }),
  'text.done': (event) => ({
    level: 'info',
    phase: 'llm',
    message: event.text ? `LLM response: ${truncate(event.text)}` : 'LLM response received',
  }),
  'tool.start': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool call: ${event.toolName}`,
    detail: event,
  }),
  'tool.done': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool '${event.toolName}' result: ${truncate(JSON.stringify(event.result))}`,
    detail: event,
  }),
  'tool.error': (event) => ({
    level: 'error',
    phase: 'tool',
    toolName: event.toolName,
    message: `Tool '${event.toolName}' failed: ${event.error.message}`,
    detail: event,
  }),
  'run.done': (event) => ({
    level: 'info',
    phase: event.finishReason === 'awaiting-approval' ? 'approval' : 'trigger',
    message: `Run finished (${event.finishReason})`,
  }),
  error: (event) => ({ level: 'error', phase: 'trigger', message: event.error.message || 'Run failed' }),
};

/**
 * From the SDK's `AgentEvent`s: translates one run event into
 * zero or more structured `LogEntry` rows. `LogPhase` is a coarser regrouping
 * of the same events (e.g. both `run.start` and `run.done` map to phase
 * 'trigger', since those are this pipeline's entry/exit points) plus
 * 'sandbox'/'checkpoint'/'approval'/'debug' phases used by emitters
 * elsewhere for things with no dedicated event. A failed run's `run.done`
 * follows its `error`, so it is not logged again.
 */
export function toLogEntries(agentId: string, event: AgentEvent): LogEntry[] {
  if (event.type === 'run.done' && event.finishReason === 'error') return [];
  const build = AGENT_LOG_BUILDERS[event.type] as ((event: AgentEvent, agentId: string) => LogBody) | undefined;
  return build ? [toEntry(agentId, new Date(event.timestamp), build(event, agentId))] : [];
}

type FlowLogBuilders = {
  [K in FlowExecutionEvent['type']]?: (event: FlowExecutionEventOf<K>) => LogBody;
};

const FLOW_LOG_BUILDERS: FlowLogBuilders = {
  'flow-start': (event) => ({
    level: 'info',
    phase: 'trigger',
    message: `Flow run started (${event.data?.flowName ?? 'unnamed flow'})`,
  }),
  'llm-call': (event) => ({
    level: 'info',
    phase: 'llm',
    message: `LLM call (model: ${event.data?.model ?? 'unknown'})`,
  }),
  'llm-response': (event) => ({
    level: 'info',
    phase: 'llm',
    message: `LLM response: ${truncate(event.data?.text)}`,
  }),
  'tool-call': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.data?.tool,
    message: `Tool call: ${event.data?.tool ?? 'unknown'}`,
    detail: event.data,
  }),
  'tool-result': (event) => ({
    level: 'tool',
    phase: 'tool',
    toolName: event.data?.tool,
    message: `Tool '${event.data?.tool}' result: ${truncate(JSON.stringify(event.data?.result))}`,
    detail: event.data,
  }),
  'condition-evaluated': (event) => ({
    level: 'info',
    phase: 'debug',
    message: `Router branch condition '${event.data?.condition ?? '(default)'}' -> ${event.data?.result}`,
  }),
  'flow-complete': () => ({ level: 'info', phase: 'trigger', message: 'Flow run finished' }),
  'flow-error': (event) => ({
    level: 'error',
    phase: 'trigger',
    message: event.error?.message ?? 'Flow run failed',
  }),
};

/**
 * Translates one `FlowExecutionEvent` (`src/flows/FlowExecutor.ts`'s
 * own, unrelated event taxonomy - flow-start/step-start/llm-call/
 * llm-response/tool-call/tool-result/condition-evaluated/loop-iteration/
 * step-complete/flow-complete/flow-error, NOT `AgentExecutor`'s
 * `AgentEvent`) into `LogEntry` rows, the same way `toLogEntries()`
 * does for a normal run. This is the extent of debug-console observability
 * for a `FlowExecutor` run today: these land in the Logs tab, but NOT the
 * structured Trace tab (`emitSpan`/`makeTraceExporter` needs a real
 * `TraceExporter`/`Span` stream, which `FlowExecutor.execute()` has no
 * parameter for) or the step-debugger (`DebugSession`'s breakpoints hook
 * into `AgentExecutor`'s `preGenerate`/`postGenerate`/`preToolCall`/
 * `postToolCall` hook points via `hooks`/`sandbox` options that
 * `FlowExecutor.execute()` simply doesn't accept - see its signature). A
 * branching run is therefore only PARTIALLY observable in Agent Forge's
 * debug console: logs yes, trace graph and breakpoint stepping no. Noted
 * here rather than silently left blank; see the report for the full
 * writeup.
 */
export function toFlowLogEntries(agentId: string, event: FlowExecutionEvent): LogEntry[] {
  const build = FLOW_LOG_BUILDERS[event.type] as ((event: FlowExecutionEvent) => LogBody) | undefined;
  return build ? [toEntry(agentId, event.timestamp, build(event))] : [];
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const titled = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const providerLabel = (integration: string): string =>
  CONNECTORS.find((def) => def.id === INTEGRATION_SECRETS[integration]?.connector)?.label ?? titled(integration);

function skippedSentence({ integration, reason, missing }: RunSetupSkipped): string {
  return reason === 'off'
    ? `${providerLabel(integration)} is connected but switched off for this kind of run.`
    : `${providerLabel(integration)} is missing its ${(missing ?? []).join(', ')}.`;
}

export function runSetupLogEntry(agentId: string, setup: RunSetup): LogEntry {
  const parts = [RUN_SETUP_PREFIX.slice(0, 5)];
  const names = setup.accounts.map((account) => account.integration);
  if (setup.note !== undefined) parts.push(setup.note);
  else if (names.length > 0) parts.push(`${plural(names.length, 'connected account')} (${names.join(', ')})`);
  else if (setup.declared.length === 0 && setup.skipped.length === 0) parts.push('No connected accounts. Connect one in Profile → Connectors.');
  else parts.push('No connected accounts attached');
  if (setup.declared.length > 0) parts.push(`${plural(setup.declared.length, 'declared integration')} (${setup.declared.join(', ')})`);
  const profileMcp = setup.profileMcpServers ?? [];
  if (setup.mcpServers.length + profileMcp.length > 0) parts.push(plural(setup.mcpServers.length + profileMcp.length, 'MCP server'));
  if (setup.tools !== undefined) parts.push(plural(setup.tools, 'tool'));
  if (setup.workspaceRoot !== undefined) parts.push(`workspace ${setup.workspaceRoot}`);
  const lines = [
    ...setup.accounts.map(
      (account) =>
        `${account.integration}: ${account.tools.join(', ') || 'no tools'}${account.approvals.length > 0 ? ` (ask for approval: ${account.approvals.join(', ')})` : ''}`
    ),
    ...(profileMcp.length > 0 ? [`MCP servers from Profile: ${profileMcp.join(', ')} (every tool asks for approval)`] : []),
    ...new Set(setup.skipped.map(skippedSentence)),
  ];
  return toEntry(agentId, new Date(), {
    level: 'info',
    phase: 'trigger',
    message: parts.join(' · '),
    ...(lines.length > 0 && { detail: lines.join('\n') }),
  });
}
