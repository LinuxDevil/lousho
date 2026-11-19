import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CircleAlert, MessageSquare } from 'lucide-react';

import type { RunListRow } from '../../../shared/wireTypes';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { EmptyState } from '../../ui/EmptyState';
import { RunDetail, RunDetailSkeleton, RunMissing } from './RunDetail';
import { RunList, RunListSkeleton, RunListToolbar } from './RunList';
import { countRuns, filterRuns, hasChat, refOf, runPath, sameRun, WIDE_MIN_PX, type RunFilter, type RunRef } from './runsModel';
import { useRuns } from './useRunData';
import './runsScreen.css';

function useWide(ref: RefObject<HTMLElement>): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (width: number) => setWide(width >= WIDE_MIN_PX);
    measure(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

function useSelectedRef(): RunRef | undefined {
  const { path } = useRoute();
  const params = matchRoute(`#${path}`, ['/w/:ws/runs/:agentId/:chatId'])?.params;
  return params === undefined ? undefined : { workspaceId: params.ws, agentId: params.agentId, chatId: params.chatId };
}

export function RunsScreen(): JSX.Element {
  const { rows, error, refresh } = useRuns();
  const [filter, setFilter] = useState<RunFilter>('all');
  const selected = useSelectedRef();
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useWide(splitRef);

  const chats = useMemo(() => (rows ?? []).filter(hasChat), [rows]);
  const counts = useMemo(() => countRuns(chats), [chats]);
  const visible = useMemo(() => filterRuns(chats, filter), [chats, filter]);
  const current = selected !== undefined ? chats.find((row) => sameRun(refOf(row), selected)) : undefined;
  const first = visible[0];

  useEffect(() => {
    const measuredWide = (splitRef.current?.clientWidth ?? 0) >= WIDE_MIN_PX;
    if (wide && measuredWide && selected === undefined && first !== undefined) navigate(runPath(refOf(first)), { replace: true });
  }, [wide, selected, first]);

  const failedToLoad = error !== undefined && rows === undefined;
  const empty = rows !== undefined && chats.length === 0;

  let list: JSX.Element;
  if (failedToLoad) {
    list = (
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
    );
  } else if (rows === undefined) {
    list = <RunListSkeleton />;
  } else if (empty) {
    list = <EmptyState icon={MessageSquare} title="No runs yet" hint="Every chat with every agent shows here, one row per chat." />;
  } else if (visible.length === 0) {
    list = <p className="runs-none">No runs match this filter.</p>;
  } else {
    list = <RunList rows={visible} selected={selected} now={Date.now()} />;
  }

  let detail: JSX.Element | null = null;
  if (selected !== undefined) {
    if (rows === undefined) detail = failedToLoad ? null : <RunDetailSkeleton />;
    else if (current === undefined) detail = <RunMissing />;
    else detail = <RunDetail key={`${selected.workspaceId}/${selected.agentId}/${selected.chatId}`} row={current as RunListRow} target={selected} onStopped={refresh} />;
  } else if (wide && rows !== undefined && !empty) {
    detail = <p className="runs-none">Pick a run to read what it did.</p>;
  }

  return (
    <div className="runs-split" ref={splitRef}>
      <div className="runs-grid" data-detail={detail !== null} data-empty={empty}>
        <section className="runs-list-pane" aria-label="Run list">
          {!failedToLoad && !empty && rows !== undefined && <RunListToolbar filter={filter} counts={counts} onChange={setFilter} onRefresh={refresh} />}
          {list}
        </section>
        {detail !== null && (
          <section className="runs-detail-pane" aria-label="Run detail">
            {detail}
          </section>
        )}
      </div>
    </div>
  );
}
