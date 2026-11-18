import { Copy } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentTarget } from '../../../shared/profileWire';
import { targetKey } from '../../../shared/profileWire';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Checkbox } from '../../ui/controls';
import { useToast } from '../../ui/Toast';
import { useWorkspacesMaybe } from '../../workspace/WorkspacesProvider';
import '../../ui/form.css';

export function useLoad<T>(load: () => Promise<T>): { data: T | undefined; error: string | undefined; reload: () => void; setData: (data: T) => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload, setData };
}

export interface AgentOption extends AgentTarget {
  agentName: string;
  workspaceName: string;
}

export function useAgentOptions(): AgentOption[] | undefined {
  const workspaces = useWorkspacesMaybe();
  const { data } = useLoad(() => runtimeClient.listAllAgentItems());
  return useMemo(() => {
    if (data === undefined) return undefined;
    const names = new Map((workspaces?.list ?? []).map((w) => [w.id, w.name]));
    return data.items
      .filter((item): item is Extract<typeof item, { kind: 'workspace' }> => item.kind === 'workspace')
      .map((item) => ({
        workspaceId: item.workspaceId,
        agentId: item.id,
        agentName: item.name,
        workspaceName: names.get(item.workspaceId) ?? item.workspaceId,
      }));
  }, [data, workspaces?.list]);
}

export function targetLabel(target: AgentTarget, options: AgentOption[] | undefined): string {
  const found = options?.find((o) => targetKey(o) === targetKey(target));
  return found ? `${found.agentName} · ${found.workspaceName}` : `${target.agentId} · ${target.workspaceId}`;
}

export function TargetPicker({ value, onChange }: { value: AgentTarget[]; onChange: (next: AgentTarget[]) => void }) {
  const options = useAgentOptions();
  const selected = new Set(value.map(targetKey));
  if (options === undefined) return <p className="profile-help">Loading agents…</p>;
  if (options.length === 0) return <p className="profile-help">No agents yet. Create one first.</p>;
  const groups = [...new Set(options.map((o) => o.workspaceName))];
  return (
    <div className="profile-targets">
      {groups.map((group) => (
        <div key={group}>
          <p className="profile-target-group">{group}</p>
          {options
            .filter((o) => o.workspaceName === group)
            .map((o) => (
              <Checkbox
                key={targetKey(o)}
                label={o.agentName}
                description={o.agentId !== o.agentName ? o.agentId : undefined}
                checked={selected.has(targetKey(o))}
                onChange={(e) =>
                  onChange(
                    e.currentTarget.checked
                      ? [...value, { workspaceId: o.workspaceId, agentId: o.agentId }]
                      : value.filter((t) => targetKey(t) !== targetKey(o)),
                  )
                }
              />
            ))}
        </div>
      ))}
    </div>
  );
}

export function CopyValue({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <div className="profile-code">
      <code>{value}</code>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(value)
            .then(() => toast.show({ message: `${label} copied`, tone: 'success' }))
            .catch(() => toast.show({ message: 'Could not copy', tone: 'error' }))
        }
      >
        <Copy size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ShownOnce({ value, label }: { value: string; label: string }) {
  return (
    <div className="profile-once" role="status">
      <p>
        <strong>Copy this {label.toLowerCase()} now.</strong> Studio stores only a hash or an encrypted copy and will not show it again.
      </p>
      <CopyValue value={value} label={label} />
    </div>
  );
}

export function fmtWhen(iso: string | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
