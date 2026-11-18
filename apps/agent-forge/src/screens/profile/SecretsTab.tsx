import { useState } from 'react';
import { CONNECTORS, GOOGLE_REFRESH_SECRET } from '../../../shared/profileWire';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { useToast } from '../../ui/Toast';
import { fmtWhen, useLoad } from './profileShared';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const OWNERS = new Map<string, string>([
  ...CONNECTORS.flatMap((c) => c.fields.map((f) => [f.secret, c.label] as [string, string])),
  [GOOGLE_REFRESH_SECRET, 'Google Workspace'],
]);

function ownerOf(name: string): string | undefined {
  if (name.startsWith('LOUSHO_INBOUND_')) return 'Inbound endpoint';
  return OWNERS.get(name);
}

export function SecretsTab() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => runtimeClient.listSecrets());
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const nameProblem = name !== '' && !NAME_RE.test(name) ? 'Letters, digits and underscores; start with a letter or underscore.' : undefined;

  const save = async () => {
    setPending(true);
    try {
      await runtimeClient.setSecret(name, value);
      toast.show({ message: `${name} saved`, tone: 'success' });
      setName('');
      setValue('');
      reload();
    } catch (cause) {
      toast.show({ message: 'Could not save the secret', description: errorMessage(cause), tone: 'error' });
    } finally {
      setPending(false);
    }
  };

  const secrets = (data ?? []).filter((s) => s.hasValue);

  return (
    <>
      <p className="profile-intro">
        Named secrets are what an agent&apos;s <code>{'{ secret: NAME }'}</code> references resolve to at run time. Values are encrypted on this
        machine and never shown again in full.
      </p>
      <Card title="Add or replace a secret">
        <form
          className="profile-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Name" error={nameProblem}>
            <Input value={name} placeholder="MY_API_KEY" spellCheck={false} onChange={(e) => setName(e.currentTarget.value.toUpperCase())} />
          </Field>
          <Field label="Value">
            <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={pending || name === '' || value.trim() === '' || nameProblem !== undefined}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </form>
      </Card>
      {error !== undefined && data === undefined ? (
        <div className="run-error" role="alert">
          {error}
        </div>
      ) : (
        <Card padding="none">
          {secrets.length === 0 ? (
            <EmptyState title="No secrets yet" hint="Connected accounts and secrets you add show up here." />
          ) : (
            <div className="profile-list">
              {secrets.map((secret) => (
                <div className="profile-row" key={secret.name}>
                  <div className="profile-row-icon" aria-hidden="true">
                    ••
                  </div>
                  <div className="profile-row-main">
                    <div className="profile-row-title">
                      <code>{secret.name}</code>
                      {ownerOf(secret.name) !== undefined && <span className="profile-badge">{ownerOf(secret.name)}</span>}
                    </div>
                    <div className="profile-row-meta">
                      {[secret.masked, secret.updatedAt && `updated ${fmtWhen(secret.updatedAt)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="profile-row-actions">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(secret.name)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={removing !== undefined}
        title={`Delete ${removing ?? ''}?`}
        description="Agents that reference this secret will fail to start until it is set again. This can't be undone."
        confirmLabel="Delete secret"
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          const target = removing;
          setRemoving(undefined);
          if (target === undefined) return;
          void runtimeClient
            .removeSecret(target)
            .then(reload)
            .catch((cause: unknown) => toast.show({ message: 'Could not delete', description: errorMessage(cause), tone: 'error' }));
        }}
      />
    </>
  );
}
