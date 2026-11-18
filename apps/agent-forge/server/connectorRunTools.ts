import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { INTEGRATION_CREDENTIALS, type IntegrationName, type ToolRef } from 'lousho/spec';
import { createShellTool, NodeWorkspace } from 'lousho/tools';
import { CONNECTORS, INTEGRATION_SECRETS } from '../shared/profileWire';

type SecretSource = { getSecret(name: string): string | undefined } | undefined;

const READ_ONLY_TOOL = /_(get|list|search|read|lookup|resolve|check|download)(_|$)/;

export function withConnectedIntegrations(spec: AgentSpecV2, secrets: SecretSource): { spec: AgentSpecV2; added: number } {
  if (secrets === undefined) return { spec, added: 0 };
  const declared = new Set((spec.tools ?? []).flatMap((ref) => ('integration' in ref ? [ref.integration] : [])));
  const added: ToolRef[] = [];
  for (const [name, { credentials }] of Object.entries(INTEGRATION_SECRETS)) {
    const integration = name as IntegrationName;
    if (integration === 'github' || declared.has(integration)) continue;
    const present = Object.entries(credentials).filter(([, secret]) => secrets.getSecret(secret) !== undefined);
    const keys = new Set(present.map(([key]) => key));
    if (present.length === 0 || !INTEGRATION_CREDENTIALS[integration].required.every((key) => keys.has(key))) continue;
    added.push({
      id: `connector-${integration}`,
      integration,
      credentials: Object.fromEntries(present.map(([key, secret]) => [key, { secret }])),
      deferLoading: true,
    });
  }
  if (added.length === 0) return { spec, added: 0 };
  return { spec: { ...spec, tools: [...(spec.tools ?? []), ...added] }, added: added.length };
}

export function guardConnectorWrites(tools: Record<string, ToolDescriptor>, names: readonly (readonly string[])[]): void {
  for (const name of names.flat()) {
    const tool = tools[name];
    if (tool !== undefined && tool.needsApproval === undefined && !READ_ONLY_TOOL.test(name)) {
      tools[name] = { ...tool, needsApproval: true };
    }
  }
}

export function connectorShellEnv(secrets: SecretSource): Record<string, string> {
  const env: Record<string, string> = {};
  if (secrets === undefined) return env;
  for (const def of CONNECTORS) {
    for (const field of def.fields) {
      const value = secrets.getSecret(field.secret);
      if (value !== undefined) env[field.secret] = value;
    }
  }
  const token = env.GITHUB_TOKEN;
  if (token !== undefined) {
    env.GH_TOKEN = token;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

export function withShellEnv(tools: Record<string, ToolDescriptor>, spec: AgentSpecV2, env: Record<string, string>): void {
  const shell = tools.shell;
  const ref = (spec.tools ?? []).find((r) => 'builtin' in r && r.builtin === 'shell');
  const root = (ref as { options?: { root?: unknown } } | undefined)?.options?.root;
  if (shell === undefined || typeof root !== 'string' || Object.keys(env).length === 0) return;
  const fresh = createShellTool(new NodeWorkspace({ root, env }));
  tools.shell = { ...shell, execute: fresh.execute };
}
