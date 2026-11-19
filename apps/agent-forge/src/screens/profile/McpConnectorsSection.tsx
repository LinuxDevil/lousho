import { useState } from 'react';
import { MCP_CONNECTOR_NAME, mcpConnectorUrlProblem, type McpConnectorStatus } from '../../../shared/profileWire';
import { relativeTime } from '../../components/formatTime';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { useLoad } from './profileShared';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function AddSheet({ existing, onClose, onSaved }: { existing: McpConnectorStatus[]; onClose: () => void; onSaved: (s: McpConnectorStatus) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState(false);

  const nameProblem = !MCP_CONNECTOR_NAME.test(name)
    ? 'Use 1-32 lowercase letters, digits or dashes, starting with a letter.'
    : existing.some((s) => s.name === name)
      ? 'A connector with this name already exists.'
      : undefined;
  const urlProblem = mcpConnectorUrlProblem(url.trim());

  const submit = async () => {
    setTouched(true);
    if (nameProblem !== undefined || urlProblem !== undefined) return;
    setPending(true);
    setError(undefined);
    try {
      onSaved(await runtimeClient.connectMcpConnector(name, { url: url.trim(), ...(token.trim() !== '' && { token: token.trim() }) }));
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
      title="Add MCP server"
      description="A remote MCP server over HTTP."
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="connect-mcp" className="btn btn-primary" disabled={pending}>
            {pending ? 'Checking…' : 'Check and add'}
          </button>
        </>
      }
    >
      <form
        id="connect-mcp"
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" required hint="Tools appear to agents as <name>__<tool>." error={touched ? nameProblem : undefined}>
          <Input autoComplete="off" spellCheck={false} placeholder="docs" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Server URL" required error={touched ? urlProblem : undefined}>
          <Input autoComplete="off" spellCheck={false} placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        </Field>
        <Field label="Bearer token" hint="Optional. Stored encrypted as a named secret.">
          <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.currentTarget.value)} />
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

export function McpConnectorsSection() {
  const toast = useToast();
  const { data, error, setData } = useLoad(() => runtimeClient.listMcpConnectors());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpConnectorStatus | undefined>(undefined);
  const [verifying, setVerifying] = useState<string | undefined>(undefined);

  const rows = data ?? [];
  const upsert = (next: McpConnectorStatus) =>
    setData([...rows.filter((s) => s.name !== next.name), next].sort((a, b) => a.name.localeCompare(b.name)));

  const verify = (row: McpConnectorStatus) => {
    setVerifying(row.name);
    void runtimeClient
      .verifyMcpConnector(row.name)
      .then(upsert)
      .catch((cause: unknown) => toast.show({ message: 'Could not verify', description: errorMessage(cause), tone: 'error' }))
      .finally(() => setVerifying(undefined));
  };

  return (
    <>
      <Card
        title="MCP connectors"
        description="Agents use these by default unless their configuration already has a server with the same name."
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            Add MCP server
          </button>
        }
        padding="none"
      >
        {error !== undefined && data === undefined && (
          <div className="run-error" role="alert">
            {error}
          </div>
        )}
        <div className="profile-list">
          {rows.map((row) => (
            <div className="profile-row" key={row.name}>
              <div className="profile-row-icon" aria-hidden="true">
                {row.name.slice(0, 2)}
              </div>
              <div className="profile-row-main">
                <div className="profile-row-title">
                  {row.name}
                  {row.error !== undefined && <span className="profile-badge bad">Check failed</span>}
                </div>
                <div className="profile-row-meta">
                  {row.error ?? [hostOf(row.url), `${row.toolCount ?? 0} ${row.toolCount === 1 ? 'tool' : 'tools'}`, row.verifiedAt !== undefined && `verified ${relativeTime(row.verifiedAt)}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="profile-row-actions">
                <button type="button" className="btn btn-sm btn-ghost" disabled={verifying === row.name} onClick={() => verify(row)}>
                  {verifying === row.name ? 'Verifying…' : 'Verify'}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(row)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      {adding && (
        <AddSheet
          existing={rows}
          onClose={() => setAdding(false)}
          onSaved={(next) => {
            upsert(next);
            setAdding(false);
            toast.show({ message: `${next.name} added`, tone: 'success' });
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removing?.name ?? ''}?`}
        description="Its token is deleted and agents stop getting this server."
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          const row = removing;
          setRemoving(undefined);
          if (row === undefined) return;
          void runtimeClient
            .removeMcpConnector(row.name)
            .then(() => setData(rows.filter((s) => s.name !== row.name)))
            .catch((cause: unknown) => toast.show({ message: 'Could not remove', description: errorMessage(cause), tone: 'error' }));
        }}
      />
    </>
  );
}
