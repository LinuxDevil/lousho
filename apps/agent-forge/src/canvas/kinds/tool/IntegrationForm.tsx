/**
 * The `{ integration }` form of the tool Inspector: the service picker
 * (GitHub, Jira, Confluence, Slack, email, Google Workspace, Jenkins or Figma) and the credentials map, edited as
 * SecretRef-or-string rows. `usePrefilledRows` shows the service's
 * required keys as blank rows while the map is empty — keys only, values
 * are never prefilled — and switching service resets the map so keys of
 * the old service are not carried over.
 */
import { useState } from 'react';
import { INTEGRATION_SECRETS } from '../../../../shared/profileWire';
import { INTEGRATION_CREDENTIALS, type IntegrationName } from '../../../graph/v2/specTypes';
import { runtimeClient } from '../../../runtime/runtimeClient';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';
import { usePrefilledRows } from '../../fields/usePrefilledRows';
import type { ToolSubFormProps } from './BuiltinForm';

const SERVICES: { value: IntegrationName; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'confluence', label: 'Confluence' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'google', label: 'Google Workspace' },
  { value: 'jenkins', label: 'Jenkins' },
  { value: 'figma', label: 'Figma' },
];

function UseConnectedAccount({ item, patch }: ToolSubFormProps<'integration'>): JSX.Element | null {
  const [note, setNote] = useState<string | undefined>(undefined);
  const mapping = INTEGRATION_SECRETS[item.integration];
  if (mapping === undefined) return null;
  const apply = async () => {
    try {
      const stored = new Set((await runtimeClient.listSecrets()).filter((s) => s.hasValue).map((s) => s.name));
      const refs = Object.entries(mapping.credentials).filter(([, name]) => stored.has(name));
      if (refs.length === 0) {
        setNote('Nothing connected yet. Connect it in Profile → Connectors first.');
        return;
      }
      patch({ credentials: { ...(item.credentials ?? {}), ...Object.fromEntries(refs.map(([key, name]) => [key, { secret: name }])) } });
      setNote(`Using ${refs.map(([, name]) => name).join(', ')}.`);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="integration-connected">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void apply()}>
        Use connected account
      </button>
      <a className="integration-connected-link" href="#/profile/connectors">
        Manage connectors
      </a>
      {note !== undefined && <p className="field-hint">{note}</p>}
    </div>
  );
}

/** The `{ integration }` sub-form described above. */
export function IntegrationForm({ item, patch }: ToolSubFormProps<'integration'>): JSX.Element {
  const spec = INTEGRATION_CREDENTIALS[item.integration];
  const rows = usePrefilledRows(spec.required, item.credentials);
  return (
    <>
      <ChoiceField
        id="node-tool-service"
        label="Service"
        value={item.integration}
        options={SERVICES}
        onChange={(next) => {
          if (next !== undefined) patch({ integration: next, credentials: {} });
        }}
        fieldPath=".integration"
      />
      <KeyValueField
        id="node-tool-credentials"
        label="Credentials"
        valueKind="secret"
        value={rows.view}
        onChange={(next) => patch({ credentials: rows.onChange(next) })}
        error={Object.keys(item.credentials ?? {}).length === 0 ? 'Add the credentials this integration needs' : undefined}
        help={`Suggested: ${[...spec.required, ...spec.optional].join(', ')}`}
        fieldPath=".credentials"
      />
      <UseConnectedAccount item={item} patch={patch} />
    </>
  );
}
