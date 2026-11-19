import { RefreshCw } from 'lucide-react';

import type { RunListRow } from '../../../shared/wireTypes';
import { relativeTime } from '../../components/formatTime';
import { SkeletonRows } from '../../ui/Skeleton';
import { StatusDot } from '../../ui/StatusBadge';
import { StatusPill } from '../../ui/StatusPill';
import { STATUS_CONFIG, statusKey } from '../../ui/status';
import { onRovingKeyDown } from '../rovingKeys';
import { lastLine, refOf, runPath, sameRun, triggerLabel, turnsLabel, type RunCounts, type RunFilter, type RunRef } from './runsModel';

const FILTERS: { value: RunFilter; label: string; count: keyof RunCounts }[] = [
  { value: 'all', label: 'All', count: 'all' },
  { value: 'live', label: 'Live', count: 'live' },
  { value: 'error', label: 'Failed', count: 'error' },
];

export function RunFilterChips({ filter, counts, onChange }: { filter: RunFilter; counts: RunCounts; onChange: (next: RunFilter) => void }) {
  return (
    <div className="runs-chips" role="group" aria-label="Filter runs">
      {FILTERS.map((f) => (
        <button key={f.value} type="button" className={`chip runs-chip${filter === f.value ? ' on' : ''}`} aria-pressed={filter === f.value} onClick={() => onChange(f.value)}>
          {`${f.label} ${counts[f.count]}`}
        </button>
      ))}
    </div>
  );
}

export function RunListToolbar({ filter, counts, onChange, onRefresh }: { filter: RunFilter; counts: RunCounts; onChange: (next: RunFilter) => void; onRefresh: () => void }) {
  return (
    <div className="runs-list-toolbar">
      <RunFilterChips filter={filter} counts={counts} onChange={onChange} />
      <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onRefresh} title="Refresh" aria-label="Refresh runs">
        <RefreshCw size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function RunRow({ row, selected, now }: { row: RunListRow & { chatId: string }; selected: boolean; now: number }) {
  const key = row.live || row.turns !== 0 ? statusKey(row.status) : 'unknown';
  const when = row.lastActivity !== undefined ? relativeTime(new Date(row.lastActivity).toISOString(), now) : '';
  return (
    <a className="runs-row" href={`#${runPath(refOf(row))}`} data-roving aria-current={selected ? 'true' : undefined}>
      <span className="runs-row-top">
        <StatusDot status={key} title={STATUS_CONFIG[key].label} />
        <span className="runs-row-agent">{row.agentName}</span>
        {row.bypass === true && <StatusPill status="bypass" title="This run skips approvals" />}
        <span className="runs-row-time">{when}</span>
      </span>
      <span className="runs-row-meta">{`${triggerLabel(row)} · ${turnsLabel(row.turns)}`}</span>
      <span className="runs-row-last">{lastLine(row)}</span>
    </a>
  );
}

export function RunList({ rows, selected, now }: { rows: (RunListRow & { chatId: string })[]; selected: RunRef | undefined; now: number }) {
  return (
    <ul className="runs-rows" aria-label="Runs" onKeyDown={onRovingKeyDown}>
      {rows.map((row) => (
        <li key={`${row.workspaceId}/${row.agentId}/${row.chatId}`}>
          <RunRow row={row} selected={selected !== undefined && sameRun(selected, refOf(row))} now={now} />
        </li>
      ))}
    </ul>
  );
}

export function RunListSkeleton() {
  return (
    <div className="runs-rows-skeleton">
      <SkeletonRows rows={6} cols={1} />
    </div>
  );
}
