import { useEffect, useState } from 'react';
import { NOTIFICATION_EVENTS, targetKey, type NotificationChannel, type NotificationSettings } from '../../../shared/profileWire';
import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';
import { Checkbox, Input, Select } from '../../ui/controls';
import { useToast } from '../../ui/Toast';
import { useAgentOptions, useLoad } from './profileShared';

const CHANNELS: { value: NotificationChannel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'both', label: 'Slack and email' },
];

const EVENT_LABELS = { started: 'A run starts', completed: 'A run finishes', failed: 'A run fails' } as const;

export function NotificationsTab() {
  const toast = useToast();
  const options = useAgentOptions();
  const { data, error } = useLoad(() => runtimeClient.getNotifications());
  const [draft, setDraft] = useState<NotificationSettings | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState('');

  useEffect(() => {
    if (data !== undefined) setDraft(data);
  }, [data]);

  if (error !== undefined && draft === undefined) {
    return (
      <div className="run-error" role="alert">
        {error}
      </div>
    );
  }
  if (draft === undefined) return <p className="profile-help">Loading…</p>;

  const update = (patch: Partial<NotificationSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);
  const usesSlack = draft.channel === 'slack' || draft.channel === 'both' || Object.values(draft.overrides).some((c) => c === 'slack' || c === 'both');
  const usesEmail = draft.channel === 'email' || draft.channel === 'both' || Object.values(draft.overrides).some((c) => c === 'email' || c === 'both');

  const save = async () => {
    setPending(true);
    try {
      setDraft(await runtimeClient.saveNotifications(draft));
      toast.show({ message: 'Notifications saved', tone: 'success' });
    } catch (cause) {
      toast.show({ message: 'Could not save', description: errorMessage(cause), tone: 'error' });
    } finally {
      setPending(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await runtimeClient.testNotifications();
      for (const [via, outcome] of Object.entries(result)) {
        toast.show({
          message: outcome === 'sent' ? `Test sent by ${via}` : `${via === 'slack' ? 'Slack' : 'Email'} failed`,
          ...(outcome !== 'sent' && { description: outcome }),
          tone: outcome === 'sent' ? 'success' : 'error',
        });
      }
    } catch (cause) {
      toast.show({ message: 'Could not send a test', description: errorMessage(cause), tone: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const unused = (options ?? []).filter((o) => draft.overrides[targetKey(o)] === undefined);

  return (
    <>
      <p className="profile-intro">
        Get a message when runs start, finish or fail. Slack uses the connected bot token and a channel, or the incoming webhook. Email uses the
        connected Resend key.
      </p>
      <Card
        title="Default for every agent"
        actions={
          <>
            <button type="button" className="btn btn-sm" disabled={testing} onClick={() => void test()}>
              {testing ? 'Sending…' : 'Send a test'}
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || pending} onClick={() => void save()}>
              {pending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="profile-form">
          <Field label="Send by">
            <Select value={draft.channel} options={CHANNELS} onChange={(e) => update({ channel: e.currentTarget.value as NotificationChannel })} />
          </Field>
          <Field label="When">
            <div className="profile-grid">
              {NOTIFICATION_EVENTS.map((event) => (
                <Checkbox
                  key={event}
                  label={EVENT_LABELS[event]}
                  checked={draft.events[event]}
                  onChange={(e) => update({ events: { ...draft.events, [event]: e.currentTarget.checked } })}
                />
              ))}
            </div>
          </Field>
          {usesSlack && (
            <Field label="Slack channel" hint="A channel ID or #name the bot is in. Leave empty to use the incoming webhook.">
              <Input value={draft.slackChannel ?? ''} placeholder="#agent-runs" onChange={(e) => update({ slackChannel: e.currentTarget.value || undefined })} />
            </Field>
          )}
          {usesEmail && (
            <Field label="Email to" hint="One or more addresses, separated by commas.">
              <Input value={draft.emailTo ?? ''} placeholder="you@example.com" onChange={(e) => update({ emailTo: e.currentTarget.value || undefined })} />
            </Field>
          )}
        </div>
      </Card>
      <Card title="Per-agent overrides" description="An agent listed here uses its own setting instead of the default.">
        <div className="profile-form">
          {Object.entries(draft.overrides).map(([key, channel]) => {
            const option = options?.find((o) => targetKey(o) === key);
            return (
              <div className="profile-inline" key={key}>
                <Field label={option ? `${option.agentName} · ${option.workspaceName}` : key}>
                  <Select
                    value={channel}
                    options={CHANNELS}
                    onChange={(e) => update({ overrides: { ...draft.overrides, [key]: e.currentTarget.value as NotificationChannel } })}
                  />
                </Field>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    update({ overrides: Object.fromEntries(Object.entries(draft.overrides).filter(([k]) => k !== key)) });
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })}
          <div className="profile-inline">
            <Field label="Add an agent">
              <Select
                value={adding}
                placeholder={options === undefined ? 'Loading agents…' : 'Pick an agent'}
                options={unused.map((o) => ({ value: targetKey(o), label: `${o.agentName} · ${o.workspaceName}` }))}
                onChange={(e) => setAdding(e.currentTarget.value)}
              />
            </Field>
            <button
              type="button"
              className="btn"
              disabled={adding === ''}
              onClick={() => {
                update({ overrides: { ...draft.overrides, [adding]: 'off' } });
                setAdding('');
              }}
            >
              Add override
            </button>
          </div>
          {dirty && <p className="profile-help">Unsaved changes. Save with the button above.</p>}
        </div>
      </Card>
    </>
  );
}
