import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Info, MessageSquare, Play, RefreshCw, Sparkles } from 'lucide-react';

import type { ChatSessionMeta } from '../../../../shared/wireTypes';
import { groupRunsByChat, type ChatRunGroup } from '../../../../shared/chatRuns';
import { runtimeClient } from '../../../runtime/runtimeClient';

import { agentTabPath } from '../../agents/agentTabs';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../../observe/format';
import { navigate } from '../../../router/router';
import { Card } from '../../../ui/Card';
import { DataTable, type Column } from '../../../ui/DataTable';
import { EmptyState } from '../../../ui/EmptyState';
import { RatingControl } from '../../../ui/RatingControl';
import { StatusBadge } from '../../../ui/StatusBadge';
import { statusKey } from '../../../ui/status';
import { useAgentDetail } from '../AgentDetailContext';
import { errorMessage } from '../../../components/errorMessage';
import { useSuggestFix } from '../../../state/useSuggestFix';
import { useToast } from '../../../ui/Toast';
import type { RunRow } from './runsModel';
import { useAgentRuns } from './useAgentRuns';
import './runs.css';

/** The Runs tab's columns, in order (PLAN §11: status, run, started, duration, tokens, cost, rating, open). */
const shortId = (id: string) => id.slice(0, 8);

const columnsFor = (
  agentId: string,
  onRated: () => void,
  suggest: { canSuggest: boolean; pendingTraceId: string | null; onSuggestFix(traceId: string): void }
): Column<RunRow>[] => [
  {
    key: 'status',
    header: 'Status',
    width: 92,
    render: (r) => <StatusBadge status={statusKey(r.status)} size="sm" />,
  },
  {
    key: 'name',
    header: 'Run',
    minWidth: 200,
    render: (r) => (
      <span className="runs-cell" title={r.traceId}>
        <span className="runs-name">{r.name}</span>
        <span className="runs-id">{shortId(r.traceId)}</span>
      </span>
    ),
  },
  { key: 'start', header: 'Started', width: 132, render: (r) => fmtStarted(r.startTime) },
  {
    key: 'duration',
    header: 'Duration',
    align: 'right',
    width: 88,
    hideBelow: 640,
    render: (r) => fmtDuration(r.durationMs),
  },
  {
    key: 'tokens',
    header: 'Tokens',
    align: 'right',
    width: 88,
    hideBelow: 720,
    render: (r) => fmtInt(r.inputTokens + r.outputTokens),
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    width: 72,
    hideBelow: 720,
    render: (r) => (r.costUsd == null ? '—' : fmtCost(r.costUsd)),
  },
  {
    key: 'rating',
    header: 'Rating',
    align: 'right',
    width: 168,
    hideBelow: 900,
    render: (r) => (
      <span className={r.rating == null ? 'dt-hover' : undefined}>
        <RatingControl agentId={agentId} traceId={r.traceId} value={r.rating} size="sm" onRated={onRated} />
      </span>
    ),
  },
  {
    key: 'actions',
    header: <span className="visually-hidden">Actions</span>,
    label: 'Actions',
    align: 'right',
    width: 48,
    render: (r) => (
      <span className="dt-actions dt-hover">
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          disabled={!suggest.canSuggest || suggest.pendingTraceId !== null}
          title={
            !suggest.canSuggest
              ? 'Suggestions need inline instructions'
              : suggest.pendingTraceId !== null
                ? 'Suggesting…'
                : 'Suggest a fix'
          }
          aria-label={`Suggest a fix for run ${shortId(r.traceId)}`}
          onClick={() => suggest.onSuggestFix(r.traceId)}
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </span>
    ),
  },
];

const chatColumns = (agentId: string): Column<ChatRunGroup<RunRow>>[] => [
  {
    key: 'status',
    header: 'Status',
    width: 92,
    render: (g) => (g.status === 'empty' ? <span className="runs-id">no runs</span> : <StatusBadge status={statusKey(g.status)} size="sm" />),
  },
  {
    key: 'chat',
    header: 'Chat',
    minWidth: 220,
    render: (g) => (
      <span className="runs-cell" title={g.preview || undefined}>
        <span className="runs-name">{g.preview || '(no messages)'}</span>
        <span className="runs-id">{shortId(g.chatId)}</span>
      </span>
    ),
  },
  { key: 'turns', header: 'Turns', align: 'right', width: 72, render: (g) => fmtInt(g.turns) },
  { key: 'activity', header: 'Last activity', width: 132, render: (g) => fmtStarted(g.lastActivity) },
  { key: 'tokens', header: 'Tokens', align: 'right', width: 88, hideBelow: 720, render: (g) => fmtInt(g.inputTokens + g.outputTokens) },
  { key: 'cost', header: 'Cost', align: 'right', width: 72, hideBelow: 720, render: (g) => (g.costUsd === undefined ? '—' : fmtCost(g.costUsd)) },
  {
    key: 'open',
    header: <span className="visually-hidden">Open chat</span>,
    label: 'Open chat',
    align: 'right',
    width: 48,
    render: (g) => (
      <span className="dt-actions" onClick={(e) => e.stopPropagation()}>
        <a
          className="btn btn-ghost btn-sm btn-icon"
          href={`#${agentTabPath(agentId, 'canvas')}?chat=${encodeURIComponent(g.chatId)}`}
          title="Open this chat and continue it"
          aria-label={`Open chat ${shortId(g.chatId)}`}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </span>
    ),
  },
];

/**
 * The Runs tab (A11, PLAN §11): this agent's runs newest first in a
 * DataTable, each row opening its trace (`#/traces/:id`), with the human
 * `rating` column joined from the observe daemon - which degrades to "—"
 * plus a note when the daemon is down.
 */
export function RunsTab(): JSX.Element {
  const { record } = useAgentDetail();
  const { rows, loading, error, ratingsUnavailable, refresh } = useAgentRuns(record.id);
  const testPaneHref = `#${agentTabPath(record.id, 'canvas')}?test=1`;
  const toast = useToast();
  const suggestFix = useSuggestFix();
  const [pendingTraceId, setPendingTraceId] = useState<string | null>(null);
  // The pass only edits inline instructions - a `{ file }` ref disables the button.
  const canSuggest = typeof record.spec.instructions === 'string';
  const onSuggestFix = useCallback(
    (traceId: string) => {
      setPendingTraceId(traceId);
      suggestFix(record.id, traceId).catch((cause: unknown) => {
        toast.show({ message: errorMessage(cause), tone: 'error' });
        setPendingTraceId(null);
      });
    },
    [record.id, suggestFix, toast]
  );
  const columns = useMemo(
    () => columnsFor(record.id, refresh, { canSuggest, pendingTraceId, onSuggestFix }),
    [record.id, refresh, canSuggest, pendingTraceId, onSuggestFix]
  );
  const [chats, setChats] = useState<ChatSessionMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    runtimeClient
      .listChats(record.id)
      .then((list) => {
        if (!cancelled) setChats(list);
      })
      .catch(() => {
        if (!cancelled) setChats([]);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, rows]);
  const groups = useMemo(() => groupRunsByChat(record.id, chats, rows ?? []), [record.id, chats, rows]);
  const [selectedChat, setSelectedChat] = useState<string | undefined>(undefined);
  const selected = groups.find((g) => g.chatId === selectedChat) ?? groups[0];
  const chatCols = useMemo(() => chatColumns(record.id), [record.id]);

  return (
    <div className="runs-tab">
      <div className="runs-toolbar">
        <p className="runs-count">{`${groups.length} chats · ${rows?.length ?? 0} runs`}</p>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {ratingsUnavailable && (
        <p className="runs-note" role="status">
          <Info size={14} aria-hidden="true" />
          Ratings need the observe daemon (lousho observe). Runs still show.
        </p>
      )}
      {error !== undefined ? (
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Could not load runs"
            hint={error}
            action={
              <button type="button" className="btn" onClick={refresh}>
                Retry
              </button>
            }
          />
        </Card>
      ) : (
        <>
          <Card padding="none">
            <DataTable
              id="agent-chats"
              columns={chatCols}
              rows={groups}
              rowKey={(g) => g.chatId}
              onRowOpen={(g) => setSelectedChat(g.chatId)}
              loading={loading}
              density="compact"
              empty={
                <EmptyState
                  icon={Play}
                  title="No runs yet"
                  hint="Run it from the Test pane."
                  action={
                    <a className="btn btn-primary btn-sm" href={testPaneHref}>
                      Open the Test pane
                    </a>
                  }
                />
              }
            />
          </Card>
          {selected !== undefined && selected.traces.length > 0 && (
            <section className="runs-chat-traces" aria-label="Runs in this chat">
              <h3 className="runs-chat-title">
                {`Runs in this chat · ${selected.preview || shortId(selected.chatId)}`}
              </h3>
              <Card padding="none">
                <DataTable
                  id="agent-runs"
                  columns={columns}
                  rows={selected.traces}
                  rowKey={(r) => r.traceId}
                  onRowOpen={(r) => navigate(`/traces/${r.traceId}`)}
                  density="compact"
                  empty={null}
                />
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}
