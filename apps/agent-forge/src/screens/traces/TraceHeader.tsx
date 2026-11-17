import { Bot, CalendarClock, Coins, Cpu, FlaskConical, MessagesSquare, Timer, Wallet } from 'lucide-react';

import { fmtCost, fmtDateTime, fmtDuration, fmtInt } from '../../observe/format';
import type { ObserveObservationRow } from '../../observe/types';
import { StatusPill } from '../../ui/StatusPill';
import { CopyLinkButton, Fact, FactUnit, HeaderCard } from '../../ui/HeaderCard';
import { displayName, displayStatus, elapsedMs, playgroundHref } from '../../ui/run/rows';
import { AddToDataset } from './AddToDataset';
import { AddToQueue } from './AddToQueue';
import { RatingControl } from '../../ui/RatingControl';

/** The latest `end` over every observation, or `undefined` when none has ended. */
function latestEnd(rows: ObserveObservationRow[]): number | undefined {
  let latest: number | undefined;
  for (const row of rows) if (row.end !== null && (latest === undefined || row.end > latest)) latest = row.end;
  return latest;
}

type Metered = 'usage_input_tokens' | 'usage_output_tokens' | 'cost_usd';

/** One metered column the daemon's way: the root's rolled-up value, else the sum over generations. */
function metered(rows: ObserveObservationRow[], column: Metered): number | null {
  const root = rows.find((row) => row.parent_obs_id === null);
  if (root && root[column] !== null) return root[column];
  let total: number | null = null;
  for (const row of rows) if (row.kind === 'generation' && row[column] !== null) total = (total ?? 0) + (row[column] ?? 0);
  return total;
}

/** Trace-wide totals, counting each model call once like the daemon's trace list. */
export function traceTotals(rows: ObserveObservationRow[]): { tokens: number | null; cost: number | null } {
  const input = metered(rows, 'usage_input_tokens');
  const output = metered(rows, 'usage_output_tokens');
  return { tokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0), cost: metered(rows, 'cost_usd') };
}

/** The root's own model, else the first generation's. */
function traceModel(root: ObserveObservationRow, rows: ObserveObservationRow[]): string | null {
  return root.model ?? rows.find((row) => row.kind === 'generation' && row.model)?.model ?? null;
}

/** The generation "Open in Playground" loads: the selected step when it is one, else the earliest generation. */
function playgroundTarget(rows: ObserveObservationRow[], selectedObsId: string | null | undefined): ObserveObservationRow | undefined {
  const selected = rows.find((row) => row.obs_id === selectedObsId);
  if (selected?.kind === 'generation') return selected;
  let first: ObserveObservationRow | undefined;
  for (const row of rows) if (row.kind === 'generation' && (first === undefined || row.start < first.start)) first = row;
  return first;
}

interface TraceHeaderProps {
  root: ObserveObservationRow;
  observations: ObserveObservationRow[];
  agentName: string | undefined;
  now: number;
  /** The selected step: "Open in Playground" loads it when it is a generation. */
  selectedObsId?: string | null;
  /** The trace's latest human `rating` score (R04b), `null` when unrated. */
  rating?: number | null;
  /** Refetches the trace detail after a rating saves. */
  onRated?: () => void;
}

/**
 * The trace screen's header card, from the root observation: the name and status, the actions - copy link (the
 * current URL, `?obs=` included), "Add to dataset", "Add to queue" and, when
 * the trace has a generation, "Open in Playground" - then metric chips:
 * duration (counting to `now` while running), tokens, cost, model, start,
 * agent (to the agent-filtered trace list) and session (to its thread). A
 * chip whose value the trace does not have is left out, not shown as a dash.
 */
export function TraceHeader({ root, observations, agentName, now, selectedObsId, rating = null, onRated }: TraceHeaderProps) {
  const { tokens, cost } = traceTotals(observations);
  const model = traceModel(root, observations);
  const playground = playgroundTarget(observations, selectedObsId);
  const status = displayStatus(root);
  return (
    <HeaderCard
      className="trace-header"
      title={displayName(root)}
      status={<StatusPill status={status} live={status === 'running'} />}
      actions={
        <>
          <CopyLinkButton />
          <AddToDataset traceId={root.trace_id} />
          <AddToQueue traceId={root.trace_id} />
          {root.agent_id && (
            <RatingControl agentId={root.agent_id} traceId={root.trace_id} value={rating} onRated={onRated} />
          )}
          {playground && (
            <a className="btn" href={playgroundHref(playground.trace_id, playground.obs_id)}>
              <FlaskConical aria-hidden="true" />
              Open in Playground
            </a>
          )}
        </>
      }
      facts={
        <>
          <Fact icon={Timer} label="Duration">
            {fmtDuration(elapsedMs(root, now, latestEnd(observations)))}
          </Fact>
          {tokens !== null && (
            <Fact icon={Coins} label="Tokens">
              {fmtInt(tokens)}
              <FactUnit>tokens</FactUnit>
            </Fact>
          )}
          {cost !== null && (
            <Fact icon={Wallet} label="Cost">
              {fmtCost(cost)}
            </Fact>
          )}
          {model && (
            <Fact icon={Cpu} label="Model">
              <code>{model}</code>
            </Fact>
          )}
          <Fact icon={CalendarClock} label="Start">
            {fmtDateTime(root.start)}
          </Fact>
          {root.agent_id && (
            <Fact icon={Bot} label="Agent">
              <a href={`#/traces?agent=${encodeURIComponent(root.agent_id)}`}>{agentName ?? root.agent_id}</a>
            </Fact>
          )}
          {root.session_id && (
            <Fact icon={MessagesSquare} label="Session">
              <a href={`#/threads/${encodeURIComponent(root.session_id)}`}>{root.session_id}</a>
            </Fact>
          )}
        </>
      }
    />
  );
}
