import { useState } from 'react';
import type { AgentTarget, InboundEndpoint, InboundMode } from '../../../shared/profileWire';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import { Input, Select, Textarea } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { CopyValue, ShownOnce, TargetPicker, fmtWhen, targetLabel, useAgentOptions, useLoad } from './profileShared';

const MODES: { value: InboundMode; label: string }[] = [
  { value: 'hmac', label: 'Signed (HMAC): GitHub, Slack or Lousho signature' },
  { value: 'token', label: 'Token: a bearer token, x-lousho-token header or ?token=' },
];

const urlOf = (endpoint: InboundEndpoint) => `${window.location.origin}${endpoint.path}`;

const OUTCOME_CLASS: Record<string, string> = { started: 'on', busy: 'warn', disabled: 'warn', missing: 'bad', error: 'bad' };

function HowToSend({ endpoint, secret }: { endpoint: InboundEndpoint; secret?: string }) {
  if (endpoint.mode === 'token') {
    return <pre className="profile-pre">{`curl -X POST ${urlOf(endpoint)} \\\n  -H "Authorization: Bearer ${secret ?? '<secret>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`}</pre>;
  }
  return (
    <p className="profile-help">
      Use the secret as the webhook secret in GitHub (<code>X-Hub-Signature-256</code>) or as a Slack app&apos;s signing secret. For your own
      senders, send <code>X-Lousho-Timestamp</code> (Unix seconds) and <code>X-Lousho-Signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + body)</code>.
    </p>
  );
}

function CreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (endpoint: InboundEndpoint, secret: string) => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<InboundMode>('hmac');
  const [targets, setTargets] = useState<AgentTarget[]>([]);
  const [template, setTemplate] = useState('');
  const [expires, setExpires] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      const created = await runtimeClient.createInbound({
        name,
        mode,
        targets,
        ...(template.trim() !== '' && { promptTemplate: template }),
        ...(expires !== '' && { expiresAt: new Date(`${expires}T23:59:59`).toISOString() }),
      });
      onCreated(created.endpoint, created.secret);
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
      title="New inbound endpoint"
      description="One URL that any service can post events to. Every event starts the agents you pick."
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-inbound" className="btn btn-primary" disabled={pending || name.trim() === '' || targets.length === 0}>
            {pending ? 'Creating…' : 'Create endpoint'}
          </button>
        </>
      }
    >
      <form
        id="create-inbound"
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" required>
          <Input value={name} maxLength={80} placeholder="GitHub pushes" onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="How senders prove who they are">
          <Select value={mode} options={MODES} onChange={(e) => setMode(e.currentTarget.value as InboundMode)} />
        </Field>
        <Field label="Agents to start" required>
          <TargetPicker value={targets} onChange={setTargets} />
        </Field>
        <Field label="Prompt" hint="What each agent receives. {{event}} is the body, {{event.action}} a field, {{headers.x-github-event}} a header.">
          <Textarea value={template} rows={4} placeholder={'An event arrived:\n\n{{event}}'} onChange={(e) => setTemplate(e.currentTarget.value)} />
        </Field>
        <Field label="Expires" hint="Optional. After this day the endpoint answers 410.">
          <Input type="date" value={expires} onChange={(e) => setExpires(e.currentTarget.value)} />
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

function DeliveriesSheet({ endpoint, onClose }: { endpoint: InboundEndpoint; onClose: () => void }) {
  const options = useAgentOptions();
  const { data, error, reload } = useLoad(() => runtimeClient.listInboundDeliveries(endpoint.id));
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Deliveries · ${endpoint.name}`}
      description="The last 50 events this endpoint received, newest first."
      size="lg"
      footer={
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      }
    >
      {error !== undefined ? (
        <div className="run-error" role="alert">
          {error}
        </div>
      ) : data === undefined ? (
        <p className="profile-help">Loading…</p>
      ) : data.length === 0 ? (
        <EmptyState title="No deliveries yet" hint="Events posted to this endpoint show up here." />
      ) : (
        <div className="profile-deliveries">
          {data.map((d) => (
            <div className="profile-delivery" key={d.id}>
              <div className="profile-delivery-head">
                <span className={`profile-badge ${d.accepted ? 'on' : 'bad'}`}>{d.accepted ? 'Accepted' : 'Rejected'}</span>
                <span>{fmtWhen(d.at)}</span>
                <span>{d.bytes} bytes</span>
                {d.reason !== undefined && <span>{d.reason}</span>}
              </div>
              {d.runs.map((run) => (
                <div key={`${run.workspaceId}/${run.agentId}`} className="profile-delivery-head">
                  <span className={`profile-badge ${OUTCOME_CLASS[run.outcome] ?? ''}`}>{run.outcome}</span>
                  <span>{targetLabel(run, options)}</span>
                  {run.detail !== undefined && <span>{run.detail}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function InboundTab() {
  const toast = useToast();
  const options = useAgentOptions();
  const { data, error, reload } = useLoad(() => runtimeClient.listInbound());
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ endpoint: InboundEndpoint; secret: string } | undefined>(undefined);
  const [viewing, setViewing] = useState<InboundEndpoint | undefined>(undefined);
  const [removing, setRemoving] = useState<InboundEndpoint | undefined>(undefined);

  const rotate = (endpoint: InboundEndpoint) =>
    void runtimeClient
      .rotateInbound(endpoint.id)
      .then(setFresh)
      .catch((cause: unknown) => toast.show({ message: 'Could not rotate', description: errorMessage(cause), tone: 'error' }));

  return (
    <>
      <p className="profile-intro">
        Inbound endpoints receive events from other services (GitHub, Slack, monitoring, your own apps) and start one or more agents with them. Every
        delivery is logged, accepted or not.
      </p>
      {fresh !== undefined && (
        <Card title={`Endpoint "${fresh.endpoint.name}"`} actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => setFresh(undefined)}>Done</button>}>
          <div className="profile-form">
            <Field label="URL">
              <CopyValue value={urlOf(fresh.endpoint)} label="URL" />
            </Field>
            <ShownOnce value={fresh.secret} label="Secret" />
            <HowToSend endpoint={fresh.endpoint} secret={fresh.secret} />
          </div>
        </Card>
      )}
      <Card
        padding="none"
        title="Endpoints"
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            New endpoint
          </button>
        }
      >
        {error !== undefined && data === undefined ? (
          <div className="run-error" role="alert">
            {error}
          </div>
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="No inbound endpoints" hint="Create one to let other services start your agents." />
        ) : (
          <div className="profile-list">
            {(data ?? []).map((endpoint) => {
              const expired = endpoint.expiresAt !== undefined && Date.parse(endpoint.expiresAt) < Date.now();
              return (
                <div className="profile-row" key={endpoint.id}>
                  <div className="profile-row-icon" aria-hidden="true">
                    ⇣
                  </div>
                  <div className="profile-row-main">
                    <div className="profile-row-title">
                      {endpoint.name}
                      <span className="profile-badge">{endpoint.mode === 'hmac' ? 'Signed' : 'Token'}</span>
                      {expired && <span className="profile-badge bad">Expired</span>}
                    </div>
                    <div className="profile-row-meta">{urlOf(endpoint)}</div>
                    <div className="profile-row-meta">
                      {endpoint.targets.map((t) => targetLabel(t, options)).join(', ')}
                      {endpoint.expiresAt !== undefined && ` · expires ${fmtWhen(endpoint.expiresAt)}`}
                    </div>
                  </div>
                  <div className="profile-row-actions">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(endpoint)}>
                      Deliveries
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => rotate(endpoint)}>
                      Rotate secret
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(endpoint)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {creating && (
        <CreateSheet
          onClose={() => setCreating(false)}
          onCreated={(endpoint, secret) => {
            setCreating(false);
            setFresh({ endpoint, secret });
            reload();
          }}
        />
      )}
      {viewing !== undefined && <DeliveriesSheet endpoint={viewing} onClose={() => setViewing(undefined)} />}
      <ConfirmDialog
        open={removing !== undefined}
        title={`Delete "${removing?.name ?? ''}"?`}
        description="Senders get 404 from now on, and its secret is deleted. This can't be undone."
        confirmLabel="Delete endpoint"
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          const endpoint = removing;
          setRemoving(undefined);
          if (endpoint === undefined) return;
          void runtimeClient
            .removeInbound(endpoint.id)
            .then(() => {
              if (fresh?.endpoint.id === endpoint.id) setFresh(undefined);
              reload();
            })
            .catch((cause: unknown) => toast.show({ message: 'Could not delete', description: errorMessage(cause), tone: 'error' }));
        }}
      />
    </>
  );
}
