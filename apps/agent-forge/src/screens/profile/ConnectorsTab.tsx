import { useEffect, useState } from 'react';
import { CONNECTORS, type ConnectorDef, type ConnectorStatus } from '../../../shared/profileWire';
import { relativeTime } from '../../components/formatTime';
import { errorMessage } from '../../components/errorMessage';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { CopyValue, fmtWhen, useLoad } from './profileShared';

const CHECKED = new Set<string>(['github', 'atlassian', 'slack', 'figma', 'jenkins', 'email']);

const googleCallback = () => `${window.location.origin}/settings/connectors/google/callback`;

function ConnectSheet({ def, status, onClose, onSaved }: { def: ConnectorDef; status: ConnectorStatus | undefined; onClose: () => void; onSaved: (s: ConnectorStatus) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const filled = new Set(status?.filled ?? []);

  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      const result = await runtimeClient.connectConnector(def.id, values);
      if (result.authUrl !== undefined) {
        window.location.href = `${result.authUrl}?origin=${encodeURIComponent(window.location.origin)}`;
        return;
      }
      onSaved(result.status);
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
      title={`${status?.connected ? 'Reconnect' : 'Connect'} ${def.label}`}
      description={def.description}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`connect-${def.id}`} className="btn btn-primary" disabled={pending}>
            {pending ? 'Checking…' : def.oauth ? 'Save and sign in with Google' : 'Check and connect'}
          </button>
        </>
      }
    >
      <form
        id={`connect-${def.id}`}
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="profile-help">{def.help}</p>
        {def.oauth && (
          <Field label="Authorized redirect URI" hint="Add this exact URL to the OAuth client in Google Cloud Console.">
            <CopyValue value={googleCallback()} label="Redirect URI" />
          </Field>
        )}
        {def.fields.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            required={field.required}
            hint={filled.has(field.key) ? 'Saved. Leave empty to keep the current value.' : undefined}
          >
            <Input
              type={field.sensitive ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={filled.has(field.key) ? '••••••••' : field.placeholder}
              value={values[field.key] ?? ''}
              onChange={(e) => { const value = e.currentTarget.value; setValues((v) => ({ ...v, [field.key]: value })); }}
            />
          </Field>
        ))}
        <p className="profile-help">
          Stored encrypted as the named secrets {def.fields.map((f) => f.secret).join(', ')}. Agents use them through the integration&apos;s
          &quot;Use connected account&quot; button.
        </p>
        {error !== undefined && (
          <div className="run-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Sheet>
  );
}

export function ConnectorsTab() {
  const toast = useToast();
  const route = useRoute();
  const { data, error, setData, reload } = useLoad(() => runtimeClient.listConnectors());
  const [editing, setEditing] = useState<ConnectorDef | undefined>(undefined);
  const [removing, setRemoving] = useState<ConnectorDef | undefined>(undefined);

  useEffect(() => {
    const connected = route.query.get('connected');
    const failed = route.query.get('error');
    if (connected === null && failed === null) return;
    if (connected !== null) toast.show({ message: 'Google Workspace connected', tone: 'success' });
    if (failed !== null) toast.show({ message: 'Could not connect', description: failed, tone: 'error' });
    navigate('/profile/connectors', { replace: true });
    reload();
  }, [route.query]);

  const [verifying, setVerifying] = useState<string | undefined>(undefined);

  const statusOf = (id: string) => data?.find((s) => s.id === id);
  const replace = (next: ConnectorStatus) => setData((data ?? []).map((s) => (s.id === next.id ? next : s)));

  const verify = (def: ConnectorDef) => {
    setVerifying(def.id);
    void runtimeClient
      .verifyConnector(def.id)
      .then(replace)
      .catch((cause: unknown) => toast.show({ message: 'Could not verify', description: errorMessage(cause), tone: 'error' }))
      .finally(() => setVerifying(undefined));
  };

  return (
    <>
      <p className="profile-intro">
        Connect the accounts your agents act as. Each connection is checked against the service, then saved as encrypted named secrets on this
        Studio.
      </p>
      {error !== undefined && data === undefined && (
        <div className="run-error" role="alert">
          {error}
        </div>
      )}
      <Card padding="none">
        <div className="profile-list">
          {CONNECTORS.map((def) => {
            const status = statusOf(def.id);
            const partial = !status?.connected && (status?.filled.length ?? 0) > 0;
            return (
              <div className="profile-row" key={def.id}>
                <div className="profile-row-icon" aria-hidden="true">
                  {def.label.slice(0, 2)}
                </div>
                <div className="profile-row-main">
                  <div className="profile-row-title">
                    {def.label}
                    {status?.connected && status.error !== undefined ? (
                      <span className="profile-badge bad">Check failed</span>
                    ) : status?.connected ? (
                      <span className="profile-badge on">Connected</span>
                    ) : partial ? (
                      <span className="profile-badge warn">{def.oauth ? 'Sign-in needed' : 'Incomplete'}</span>
                    ) : null}
                  </div>
                  <div className="profile-row-meta">
                    {status?.connected && status.error !== undefined
                      ? status.error
                      : status?.connected && status.verifiedAt !== undefined
                        ? [status.account, `verified ${relativeTime(status.verifiedAt)}`].filter(Boolean).join(' · ')
                        : status?.connected
                          ? [status.account, status.connectedAt && `connected ${fmtWhen(status.connectedAt)}`].filter(Boolean).join(' · ') || 'Connected'
                          : def.description}
                  </div>
                  {status?.connected && status.scopes && status.scopes.length > 0 && (
                    <div className="profile-scopes">
                      {status.scopes.map((scope) => (
                        <span className="profile-scope" key={scope}>
                          {scope}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="profile-row-actions">
                  {status?.connected && CHECKED.has(def.id) && (
                    <button type="button" className="btn btn-sm btn-ghost" disabled={verifying === def.id} onClick={() => verify(def)}>
                      {verifying === def.id ? 'Verifying…' : 'Verify'}
                    </button>
                  )}
                  {(status?.connected || partial) && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(def)}>
                      Disconnect
                    </button>
                  )}
                  <button type="button" className={`btn btn-sm${status?.connected ? '' : ' btn-primary'}`} onClick={() => setEditing(def)}>
                    {status?.connected ? 'Reconnect' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {editing !== undefined && (
        <ConnectSheet
          def={editing}
          status={statusOf(editing.id)}
          onClose={() => setEditing(undefined)}
          onSaved={(next) => {
            replace(next);
            setEditing(undefined);
            toast.show({ message: `${editing.label} connected`, tone: 'success' });
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        title={`Disconnect ${removing?.label ?? ''}?`}
        description="Its saved secrets are deleted. Agents that use them will fail until you connect again."
        confirmLabel="Disconnect"
        tone="danger"
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          const def = removing;
          setRemoving(undefined);
          if (def === undefined) return;
          void runtimeClient
            .disconnectConnector(def.id)
            .then(replace)
            .catch((cause: unknown) => toast.show({ message: 'Could not disconnect', description: errorMessage(cause), tone: 'error' }));
        }}
      />
    </>
  );
}
