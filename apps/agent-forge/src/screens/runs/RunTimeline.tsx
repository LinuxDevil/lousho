import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, Hourglass, LoaderCircle, MessageSquare, Play, Settings2, Sparkles, type LucideIcon } from 'lucide-react';

import { formatTime } from '../../components/formatTime';
import { ToolCallRow } from '../../ui/ToolCallRow';
import { clipText, type EndState, type StepKind, type TimelineStep } from './runsModel';

const KIND_ICONS: Record<Exclude<StepKind, 'tool' | 'end'>, LucideIcon> = {
  setup: Settings2,
  start: Play,
  message: MessageSquare,
  assistant: Sparkles,
};

const END_ICONS: Record<EndState, LucideIcon> = {
  running: LoaderCircle,
  waiting: Hourglass,
  done: CircleCheck,
  error: CircleAlert,
};

export function ClippedMono({ text, label }: { text: string; label: string }) {
  const [all, setAll] = useState(false);
  const { shown, clipped } = clipText(text);
  return (
    <div className="run-mono-wrap">
      <pre className="run-mono">{all || !clipped ? text : `${shown}…`}</pre>
      {clipped && (
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={all} aria-label={`${all ? 'Show less' : 'Show all'} of the ${label}`} onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function StepRow({ icon: Icon, title, preview, time, tone, children }: { icon: LucideIcon; title: string; preview?: string; time?: string; tone?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const expandable = children != null;
  const at = time !== undefined ? formatTime(time) : '';
  return (
    <div className={`run-step${tone ? ` run-step-${tone}` : ''}`}>
      <button type="button" className="run-step-toggle" aria-expanded={expandable ? open : undefined} aria-controls={expandable && open ? bodyId : undefined} disabled={!expandable} onClick={() => setOpen((v) => !v)}>
        <span className="run-step-icon">
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="run-step-title" title={title}>{title}</span>
        {preview !== undefined && preview !== '' && <span className="run-step-preview">{preview}</span>}
        {at !== '' && (
          <time className="run-step-time" dateTime={time}>
            {at}
          </time>
        )}
        {expandable && <ChevronRight size={14} strokeWidth={1.75} className="run-step-chevron" aria-hidden="true" />}
      </button>
      {expandable && open && (
        <div className="run-step-body" id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}

function ToolStep({ step }: { step: TimelineStep }) {
  const tool = step.tool;
  if (tool === undefined || step.toolState === undefined) return null;
  return (
    <ToolCallRow name={tool.name} summary={step.preview} state={step.toolState} at={step.time}>
      {tool.args !== '' && (
        <div className="run-tool-section">
          <h4 className="run-tool-label">Arguments</h4>
          <ClippedMono text={tool.args} label={`${tool.name} arguments`} />
        </div>
      )}
      {tool.result !== undefined && (
        <div className="run-tool-section">
          <h4 className="run-tool-label">Result</h4>
          <ClippedMono text={tool.result} label={`${tool.name} result`} />
        </div>
      )}
      {tool.result === undefined && <p className="run-tool-note">No result recorded for this call.</p>}
    </ToolCallRow>
  );
}

function Step({ step }: { step: TimelineStep }) {
  if (step.kind === 'tool') return <ToolStep step={step} />;
  if (step.kind === 'end') return <StepRow icon={END_ICONS[step.endState ?? 'done']} title={step.title} time={step.time} tone={step.endState} />;
  const Icon = KIND_ICONS[step.kind];
  return (
    <StepRow icon={Icon} title={step.title} preview={step.kind === 'setup' ? undefined : step.preview} time={step.time}>
      {step.kind === 'setup' ? (step.body !== undefined ? <pre className="run-setup-detail">{step.body}</pre> : undefined) : step.body !== undefined && step.body !== step.title ? <ClippedMono text={step.body} label={step.title} /> : undefined}
    </StepRow>
  );
}

export function RunTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="run-timeline" aria-label="Run timeline">
      {steps.map((step) => (
        <li key={step.id}>
          <Step step={step} />
        </li>
      ))}
    </ol>
  );
}
