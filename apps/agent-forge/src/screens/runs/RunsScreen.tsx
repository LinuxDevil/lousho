import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, ListTree, MessageSquare, RefreshCw, Square } from 'lucide-react';

import type { RunListRow } from '../../../shared/wireTypes';
import { errorMessage } from '../../components/errorMessage';
import { fmtCost, fmtInt, fmtStarted } from '../../observe/format';
import { navigate } from '../../router/router';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { StatusBadge } from '../../ui/StatusBadge';
import { StatusPill } from '../../ui/StatusPill';
import { statusKey } from '../../ui/status';
import { useToast } from '../../ui/Toast';
import '../agentDetail/runs/runs.css';
import '../../ui/filterBar.css';

const POLL_MS = 4000;

type Filter = 'all' | 'live' | 'error';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'error', label: 'Failed' },
];

const rowKey = (r: RunListRow) => `${r.workspaceId}/${r.agentId}/${r.chatId ?? r.traceId ?? 'live'}`;

const agentHref = (r: RunListRow) => `#/w/${encodeURIComponent(r.workspaceId)}/agents/${encodeURIComponent(r.agentId)}/canvas`;

const chatHref = (r: RunListRow) => (r.chatId !== undefined ? `${agentHref(r)}?chat=${encodeURIComponent(r.chatId)}` : agentHref(r));

function useRuns() {
  const [rows, setRows] = useState<RunListRow[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      runtimeClient
        .listRuns()
        .then((runs) => {
          if (cancelled) return;
          setRows(runs);
          setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        });
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { rows, error, refresh };
}

export function RunsScreen(): JSX.Element {
  const { rows, error, refresh } = useRuns();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const act = useCallback(
    async (r: RunListRow) => {
      setBusy(rowKey(r));
      try {
        await runtimeClient.forWorkspace(r.workspaceId).abort(r.agentId, 'Stopped from the Runs screen');
        toast.show({ message: `Stopped ${r.agentName}`, tone: 'success' });
        refresh();
      } catch (cause) {
        toast.show({ message: errorMessage(cause), tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast]
  );

  const columns = useMemo<Column<RunListRow>[]>(
    () => [
      {
        key: 'status',
        header: 'Status',
        width: 120,
        render: (r) => (
          <span className="runs-status">
            {!r.live && r.turns === 0 ? <span className="runs-id">no runs</span> : <StatusBadge status={statusKey(r.status)} size="sm" />}
            {r.bypass === true && <StatusPill status="bypass" title="This run skips approvals" />}
          </span>
        ),
      },
      {
        key: 'chat',
        header: 'Chat',
        minWidth: 240,
        render: (r) => (
          <span className="runs-cell runs-cell-stack" title={r.preview || undefined}>
            <span className="runs-name">{r.preview || '(no messages)'}</span>
            <span className="runs-id">
              <a href={agentHref(r)} onClick={(e) => e.stopPropagation()}>
                {r.agentName}
              </a>
              {` · ${r.workspaceName}`}
            </span>
          </span>
        ),
      },
      {
        key: 'trigger',
        header: 'Trigger',
        width: 110,
        hideBelow: 720,
        render: (r) => (r.live ? (r.source === 'trigger' ? (r.triggerId ?? 'trigger') : 'manual') : '—'),
      },
      { key: 'turns', header: 'Turns', align: 'right', width: 72, render: (r) => fmtInt(r.turns ?? 0) },
      { key: 'activity', header: 'Last activity', width: 140, render: (r) => (r.lastActivity !== undefined ? fmtStarted(r.lastActivity) : '—') },
      {
        key: 'tokens',
        header: 'Tokens',
        align: 'right',
        width: 96,
        hideBelow: 720,
        render: (r) => (r.inputTokens !== undefined ? fmtInt(r.inputTokens + (r.outputTokens ?? 0)) : '—'),
      },
      { key: 'cost', header: 'Cost', align: 'right', width: 88, hideBelow: 800, render: (r) => (r.costUsd !== undefined ? fmtCost(r.costUsd) : '—') },
      {
        key: 'actions',
        header: <span className="visually-hidden">Actions</span>,
        label: 'Actions',
        align: 'right',
        width: 80,
        render: (r) => (
          <span className={r.live ? 'dt-actions' : 'dt-actions dt-hover'} onClick={(e) => e.stopPropagation()}>
            {r.live && (
              <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger-text" disabled={busy === rowKey(r)} onClick={() => void act(r)} title="Stop" aria-label={`Stop ${r.agentName}`}>
                <Square size={14} aria-hidden="true" />
              </button>
            )}
            {r.traceId !== undefined && (
              <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => navigate(`/traces/${r.traceId}`)} title="Open the latest trace" aria-label={`Open the latest trace of this ${r.agentName} chat`}>
                <ListTree size={14} aria-hidden="true" />
              </button>
            )}
          </span>
        ),
      },
    ],
    [act, busy]
  );

  const visible = (rows ?? []).filter((r) => filter === 'all' || (filter === 'live' ? r.live : r.status === 'error'));
  const liveCount = (rows ?? []).filter((r) => r.live).length;

  return (
    <div className="runs-tab">
      <div className="runs-toolbar">
        <div className="segmented" role="group" aria-label="Filter runs">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="seg-btn"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="runs-count">{`${visible.length} chats · ${liveCount} live`}</p>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {error !== undefined && rows === undefined ? (
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
        <Card padding="none">
          <DataTable
            id="all-runs"
            columns={columns}
            rows={visible}
            rowKey={rowKey}
            onRowOpen={(r) => navigate(chatHref(r).slice(1))}
            loading={rows === undefined}
            density="compact"
            empty={<EmptyState icon={MessageSquare} title="No runs yet" hint="Every chat with every agent shows here, one row per chat." />}
          />
        </Card>
      )}
    </div>
  );
}
