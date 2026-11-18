import { useState } from 'react';
import type { AgentTarget, AutomationKey } from '../../../shared/profileWire';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { ShownOnce, TargetPicker, fmtWhen, targetLabel, useAgentOptions, useLoad } from './profileShared';

const triggerUrl = () => `${window.location.origin}/hooks/_trigger`;

function example(key: AutomationKey | undefined, token: string | undefined): string {
  const target = key?.targets[0];
  return [
    `curl -X POST ${triggerUrl()} \\`,
    `  -H "Authorization: Bearer ${token ?? 'lsk_…'}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ agentId: target?.agentId ?? 'my-agent', workspaceId: target?.workspaceId, input: 'Summarise yesterday’s alerts' })}'`,
  ].join('\n');
}

function CreateKeySheet({ onClose, onCreated }: { onClose: () => void; onCreated: (key: AutomationKey, token: string) => void }) {
  const [name, setName] = useState('');
  const [targets, setTargets] = useState<AgentTarget[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      const created = await runtimeClient.createAutomationKey({ name, targets });
      onCreated(created.key, created.token);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="New automation key"
      description="A key lets a script, CI job or another service start the agents you pick."
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-automation-key" className="btn btn-primary" disabled={pending || name.trim() === '' || targets.length === 0}>
            {pending ? 'Creating…' : 'Create key'}
          </button>
        </>
      }
    >
      <form
        id="create-automation-key"
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" required>
          <Input value={name} maxLength={80} placeholder="Nightly CI" onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Agents this key may start" required>
          <TargetPicker value={targets} onChange={setTargets} />
        </Field>
        {error !== undefined && (
          <div className="run-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Sheet>
  );
}

export function AutomationKeysTab() {
  const toast = useToast();
  const options = useAgentOptions();
  const { data, error, reload } = useLoad(() => runtimeClient.listAutomationKeys());
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ key: AutomationKey; token: string } | undefined>(undefined);
  const [revoking, setRevoking] = useState<AutomationKey | undefined>(undefined);

  const rotate = (key: AutomationKey) =>
    void runtimeClient
      .rotateAutomationKey(key.id)
      .then((created) => {
        setFresh(created);
        reload();
      })
      .catch((cause: unknown) => toast.show({ message: 'Could not rotate', description: errorMessage(cause), tone: 'error' }));

  return (
    <>
      <p className="profile-intro">
        Automation keys start agents from outside Studio. Send <code>POST /hooks/_trigger</code> with the key as a bearer token. Studio keeps only a
        hash of each key.
      </p>
      {fresh !== undefined && (
        <Card title={`Key "${fresh.key.name}"`} actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => setFresh(undefined)}>Done</button>}>
          <div className="profile-form">
            <ShownOnce value={fresh.token} label="Key" />
            <pre className="profile-pre">{example(fresh.key, fresh.token)}</pre>
          </div>
        </Card>
      )}
      <Card
        padding="none"
        title="Keys"
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            New key
          </button>
        }
      >
        {error !== undefined && data === undefined ? (
          <div className="run-error" role="alert">
            {error}
          </div>
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="No automation keys" hint="Create one to start agents from a script, CI or another service." />
        ) : (
          <div className="profile-list">
            {(data ?? []).map((key) => (
              <div className="profile-row" key={key.id}>
                <div className="profile-row-icon" aria-hidden="true">
                  ⚿
                </div>
                <div className="profile-row-main">
                  <div className="profile-row-title">
                    {key.name}
                    <code className="profile-scope">{key.prefix}…</code>
                  </div>
                  <div className="profile-row-meta">{key.targets.map((t) => targetLabel(t, options)).join(', ')}</div>
                  <div className="profile-row-meta">
                    Created {fmtWhen(key.createdAt)} · last used {fmtWhen(key.lastUsedAt)}
                  </div>
                </div>
                <div className="profile-row-actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => rotate(key)}>
                    Rotate
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRevoking(key)}>
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {creating && (
        <CreateKeySheet
          onClose={() => setCreating(false)}
          onCreated={(key, token) => {
            setCreating(false);
            setFresh({ key, token });
            reload();
          }}
        />
      )}
      <ConfirmDialog
        open={revoking !== undefined}
        title={`Revoke "${revoking?.name ?? ''}"?`}
        description="Anything using this key stops working at once. This can't be undone."
        confirmLabel="Revoke key"
        onCancel={() => setRevoking(undefined)}
        onConfirm={() => {
          const key = revoking;
          setRevoking(undefined);
          if (key === undefined) return;
          void runtimeClient
            .removeAutomationKey(key.id)
            .then(() => {
              if (fresh?.key.id === key.id) setFresh(undefined);
              reload();
            })
            .catch((cause: unknown) => toast.show({ message: 'Could not revoke', description: errorMessage(cause), tone: 'error' }));
        }}
      />
    </>
  );
}
