import { Check, CircleAlert, Loader2 } from 'lucide-react';
import type { AuthorToolPart } from '../../shared/authorWire';
import { activityLabelFor, activityStateOf, type ActivityState } from './activityLabels';

const ICONS: Record<ActivityState, typeof Check> = {
  busy: Loader2,
  done: Check,
  failed: CircleAlert,
};

/**
 * The quiet one-line row a tool call gets when no card claims it (Wakeel's
 * "Activity" line): a spinning loader while busy, a check when done, an
 * alert when it failed - with copy like "Reading the agent…". Anything
 * richer (proposal, secret, success cards) comes from the AA16/AA17
 * renderers, not this row.
 */
const REASON_MAX = 200;

function failureReason(part: AuthorToolPart): string | undefined {
  const error = (part.output as { error?: unknown } | undefined)?.error;
  if (typeof error !== 'string' || error.trim() === '') return undefined;
  const text = error.trim();
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX)}…`;
}

export function ActivityLine({ part }: { part: AuthorToolPart }): JSX.Element {
  const state = activityStateOf(part);
  const Icon = ICONS[state];
  const label = activityLabelFor(part.name, state);
  const reason = state === 'failed' ? failureReason(part) : undefined;
  return (
    <div className="author-activity" data-state={state}>
      <Icon className="author-activity-icon" size={14} strokeWidth={1.75} aria-hidden="true" />
      <span>{state === 'busy' ? `${label}…` : label}</span>
      {reason !== undefined && <span className="author-activity-reason">{reason}</span>}
    </div>
  );
}
