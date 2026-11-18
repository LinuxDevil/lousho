import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Play, RefreshCw, Square } from 'lucide-react';

import type { RunListRow } from '../../../shared/wireTypes';
import { errorMessage } from '../../components/errorMessage';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
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

const rowKey = (r: RunListRow) => `${r.workspaceId}/${r.agentId}/${r.live ? 'live' : r.traceId}`;

const agentHref = (r: RunListRow) => `#/w/${encodeURIComponent(r.workspaceId)}/agents/${encodeURIComponent(r.agentId)}/canvas`;

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
    async (r: RunListRow, action: 'stop' | 'run') => {
      setBusy(rowKey(r));
      try {
        const client = runtimeClient.forWorkspace(r.workspaceId);
        if (action === 'stop') await client.abort(r.agentId, 'Stopped from the Runs screen');
        else await client.runSaved(r.agentId, 'Run the agent.');
        toast.show({ message: action === 'stop' ? `Stopped ${r.agentName}` : `Started ${r.agentName}`, tone: 'success' });
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
            <StatusBadge status={statusKey(r.status)} size="sm" />
            {r.bypass === true && <StatusPill status="bypass" title="This run skips approvals" />}
          </span>
        ),
      },
      {
        key: 'agent',
        header: 'Agent',
        minWidth: 200,
        render: (r) => (
          <span className="runs-cell">
            <a className="runs-name" href={agentHref(r)} onClick={(e) => e.stopPropagation()}>
              {r.agentName}
            </a>
            <span className="runs-id">{r.workspaceName}</span>
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
      { key: 'start', header: 'Started', width: 140, render: (r) => (r.startTime !== undefined ? fmtStarted(r.startTime) : '—') },
      { key: 'duration', header: 'Duration', align: 'right', width: 96, hideBelow: 640, render: (r) => (r.durationMs !== undefined ? fmtDuration(r.durationMs) : '—') },
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
        width: 56,
        render: (r) => (
          <span className={r.live ? 'dt-actions' : 'dt-actions dt-hover'} onClick={(e) => e.stopPropagation()}>
            {r.live ? (
              <button type="button" className="btn btn-ghost btn-sm btn-icon btn-danger-text" disabled={busy === rowKey(r)} onClick={() => void act(r, 'stop')} title="Stop" aria-label={`Stop ${r.agentName}`}>
                <Square size={14} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={busy === rowKey(r)} onClick={() => void act(r, 'run')} title="Run again" aria-label={`Run ${r.agentName} again`}>
                <Play size={14} aria-hidden="true" />
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
        <p className="runs-count">{`${visible.length} runs · ${liveCount} live`}</p>
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
            onRowOpen={(r) => (r.traceId !== undefined ? navigate(`/traces/${r.traceId}`) : undefined)}
            loading={rows === undefined}
            density="compact"
            empty={<EmptyState icon={Play} title="No runs yet" hint="Runs of every agent in every workspace show here." />}
          />
        </Card>
      )}
    </div>
  );
}
