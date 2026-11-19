import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, CircleAlert, Copy, ExternalLink, MessageSquare, Square } from 'lucide-react';

import type { RunListRow } from '../../../shared/wireTypes';
import { errorMessage } from '../../components/errorMessage';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { runtimeClient } from '../../runtime/runtimeClient';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { StatusPill } from '../../ui/StatusPill';
import { statusKey } from '../../ui/status';
import { useToast } from '../../ui/Toast';
import { RunTimeline } from './RunTimeline';
import { agentPath, buildTimeline, chatPath, runDurationMs, triggerLabel, turnsLabel, type RunRef } from './runsModel';
import { useFailureReason, useTranscript } from './useRunData';

export function BackLink() {
  return (
    <a className="btn btn-ghost btn-sm run-back" href="#/runs">
      <ArrowLeft size={14} aria-hidden="true" />
      Back to runs
    </a>
  );
}

export function RunMissing() {
  return (
    <div className="run-detail">
      <BackLink />
      <EmptyState icon={CircleAlert} title="This run no longer exists" hint="It may have been deleted, or the link names a chat this Studio does not have. Pick another run from the list." />
    </div>
  );
}

export function RunDetailSkeleton() {
  return (
    <div className="run-detail" aria-busy="true">
      <span role="status" className="visually-hidden">
        Loading
      </span>
      <Skeleton width="40%" height={22} />
      <Skeleton width="70%" height={14} />
      <Skeleton width="100%" height={32} />
      <Skeleton width="100%" height={32} />
      <Skeleton width="100%" height={32} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="runs-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const toast = useToast();
  const copy = useCallback(() => {
    const write = navigator.clipboard?.writeText(id) ?? Promise.reject(new Error('Clipboard unavailable'));
    write.then(
      () => toast.show({ message: 'Run id copied', tone: 'success' }),
      () => toast.show({ message: 'Could not copy the run id', tone: 'error' })
    );
  }, [id, toast]);
  return (
    <span className="run-id">
      <code>{id}</code>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={copy} title="Copy run id" aria-label="Copy run id">
        <Copy size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

function StopButton({ row, onStopped }: { row: RunListRow; onStopped: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const stop = async () => {
    setBusy(true);
    try {
      await runtimeClient.forWorkspace(row.workspaceId).abort(row.agentId, 'Stopped from the Runs screen');
      toast.show({ message: `Stopped ${row.agentName}`, tone: 'success' });
      onStopped();
    } catch (cause) {
      toast.show({ message: errorMessage(cause), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void stop()}>
      <Square size={14} aria-hidden="true" />
      Stop
    </button>
  );
}

export function RunDetail({ row, target: runRef, onStopped }: { row: RunListRow; target: RunRef; onStopped: () => void }) {
  const { state, retry } = useTranscript(runRef, row.live, row.lastActivity);
  const failure = useFailureReason(runRef, row.status === 'error');
  const record = state.status === 'ready' ? state.record : null;
  const steps = useMemo(
    () => (state.status === 'ready' ? buildTimeline({ messages: record?.messages ?? [], setup: record?.setup, row, failure }) : []),
    [state.status, record, row, failure]
  );
  const duration = runDurationMs(row);
  const tokens = row.inputTokens !== undefined ? fmtInt(row.inputTokens + (row.outputTokens ?? 0)) : '—';

  return (
    <div className="run-detail">
      <BackLink />
      <header className="run-head">
        <div className="run-head-top">
          <h2 className="run-title">
            <a href={`#${agentPath(row)}`}>{row.agentName}</a>
          </h2>
          <StatusBadge status={statusKey(row.status)} />
          {row.bypass === true && <StatusPill status="bypass" title="This run skips approvals" />}
        </div>
        <dl className="runs-facts">
          <Fact label="Run id">
            <CopyId id={runRef.chatId} />
          </Fact>
          <Fact label="Trigger">{triggerLabel(row)}</Fact>
          <Fact label="Started">{row.startTime !== undefined ? fmtStarted(row.startTime) : '—'}</Fact>
          <Fact label="Duration">{duration !== undefined ? fmtDuration(duration) : '—'}</Fact>
          <Fact label="Turns">{turnsLabel(row.turns)}</Fact>
          <Fact label="Tokens">{tokens}</Fact>
          <Fact label="Cost">{row.costUsd !== undefined ? fmtCost(row.costUsd) : '—'}</Fact>
        </dl>
        <div className="run-actions">
          <a className="btn btn-sm" href={`#${chatPath(row)}`}>
            <MessageSquare size={14} aria-hidden="true" />
            Open chat
          </a>
          {row.traceId !== undefined && (
            <a className="btn btn-sm" href={`#/traces/${encodeURIComponent(row.traceId)}`}>
              <ExternalLink size={14} aria-hidden="true" />
              Open trace
            </a>
          )}
          {row.live && <StopButton row={row} onStopped={onStopped} />}
        </div>
      </header>
      <section className="run-timeline-section" aria-labelledby="run-timeline-title">
        <h3 id="run-timeline-title" className="runs-section-title">
          Timeline
        </h3>
        {state.status === 'loading' && <RunTimelineSkeleton />}
        {state.status === 'error' && (
          <EmptyState
            icon={CircleAlert}
            title="Could not load this run"
            hint={state.message}
            action={
              <button type="button" className="btn" onClick={retry}>
                Retry
              </button>
            }
          />
        )}
        {state.status === 'ready' && <RunTimeline steps={steps} />}
      </section>
    </div>
  );
}

function RunTimelineSkeleton() {
  return (
    <div className="run-timeline-skeleton" aria-busy="true">
      <span role="status" className="visually-hidden">
        Loading the timeline
      </span>
      <Skeleton width="100%" height={32} />
      <Skeleton width="100%" height={32} />
      <Skeleton width="100%" height={32} />
    </div>
  );
}
