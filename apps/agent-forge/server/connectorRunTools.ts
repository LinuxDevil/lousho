import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { INTEGRATION_CREDENTIALS, type IntegrationName, type ToolRef } from 'lousho/spec';
import { createShellTool, NodeWorkspace } from 'lousho/tools';
import { CONNECTORS, INTEGRATION_SECRETS, type StoredMcpConnector } from '../shared/profileWire';
import type { RunSetupSkipped } from '../shared/wireTypes';

type SecretSource = { getSecret(name: string): string | undefined; mcpConnectors?(): StoredMcpConnector[] } | undefined;

const READ_ONLY_TOOL = /_(get|list|search|read|lookup|resolve|check|download)(_|$)/;

function connectionStates(spec: AgentSpecV2, secrets: SecretSource): { integration: IntegrationName; present: [string, string][]; missing: string[] }[] {
  if (secrets === undefined) return [];
  const declared = new Set((spec.tools ?? []).flatMap((ref) => ('integration' in ref ? [ref.integration] : [])));
  const states = [];
  for (const [name, { credentials }] of Object.entries(INTEGRATION_SECRETS)) {
    const integration = name as IntegrationName;
    if (declared.has(integration)) continue;
    const present = Object.entries(credentials).filter(([, secret]) => secrets.getSecret(secret) !== undefined);
    if (present.length === 0) continue;
    const keys = new Set(present.map(([key]) => key));
    const missing = INTEGRATION_CREDENTIALS[integration].required.filter((key) => !keys.has(key));
    states.push({ integration, present, missing: missing.map((key) => CONNECTORS.flatMap((def) => def.fields).find((field) => field.secret === credentials[key])?.label ?? key) });
  }
  return states;
}

export function withConnectedIntegrations(spec: AgentSpecV2, secrets: SecretSource): { spec: AgentSpecV2; added: number; integrations: string[] } {
  const added: ToolRef[] = connectionStates(spec, secrets)
    .filter((state) => state.missing.length === 0)
    .map(({ integration, present }) => ({
      id: `connector-${integration}`,
      integration,
      credentials: Object.fromEntries(present.map(([key, secret]) => [key, { secret }])),
      deferLoading: true,
    }));
  if (added.length === 0) return { spec, added: 0, integrations: [] };
  return {
    spec: { ...spec, tools: [...(spec.tools ?? []), ...added] },
    added: added.length,
    integrations: added.map((ref) => ('integration' in ref ? ref.integration : '')),
  };
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function missingMcpConnectors(spec: AgentSpecV2, secrets: SecretSource): StoredMcpConnector[] {
  const servers = Object.entries(spec.mcpServers ?? {});
  return (secrets?.mcpConnectors?.() ?? []).filter(
    (connector) => !servers.some(([key, server]) => key === connector.name || ('url' in server && sameUrl(server.url, connector.url))),
  );
}

export function withMcpConnectors(spec: AgentSpecV2, secrets: SecretSource): { spec: AgentSpecV2; names: string[] } {
  const added = missingMcpConnectors(spec, secrets);
  if (added.length === 0) return { spec, names: [] };
  const servers: NonNullable<AgentSpecV2['mcpServers']> = { ...spec.mcpServers };
  for (const { name, url, tokenSecret } of added) {
    servers[name] = {
      url,
      approval: 'always',
      deferLoading: true,
      ...(tokenSecret !== undefined && { headers: { Authorization: { secret: tokenSecret } } }),
    };
  }
  return { spec: { ...spec, mcpServers: servers }, names: added.map((connector) => connector.name) };
}

export function skippedConnections(spec: AgentSpecV2, secrets: SecretSource, attached: boolean): RunSetupSkipped[] {
  return connectionStates(spec, secrets).flatMap<RunSetupSkipped>(({ integration, missing }) => {
    if (missing.length > 0) return [{ integration, reason: 'incomplete', missing }];
    return attached ? [] : [{ integration, reason: 'off' }];
  });
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
  const token = secrets?.getSecret('GITHUB_TOKEN');
  if (token !== undefined) {
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

export function connectedAccountsForAuthor(secrets: SecretSource): string[] {
  if (secrets === undefined) return [];
  const lines: string[] = [];
  for (const [integration, { credentials }] of Object.entries(INTEGRATION_SECRETS)) {
    const present = Object.entries(credentials).filter(([, secret]) => secrets.getSecret(secret) !== undefined);
    if (present.length === 0) continue;
    const refs = JSON.stringify(Object.fromEntries(present.map(([key, secret]) => [key, { secret }])));
    const extra = integration === 'github' ? ' (account-wide: list/create repositories and any REST call; add "owner" and "repo" strings to get the repo tools for one repository instead)' : '';
    lines.push(`- ${integration}: { "integration": "${integration}", "credentials": ${refs} }${extra}`);
  }
  return lines;
}

export function mcpConnectorsForAuthor(secrets: SecretSource): string[] {
  return (secrets?.mcpConnectors?.() ?? []).map(({ name, url }) => {
    try {
      return `- ${name}: ${new URL(url).host}`;
    } catch {
      return `- ${name}`;
    }
  });
}

export function withShellEnv(tools: Record<string, ToolDescriptor>, spec: AgentSpecV2, env: Record<string, string>): void {
  const shell = tools.shell;
  const ref = (spec.tools ?? []).find((r) => 'builtin' in r && r.builtin === 'shell');
  const root = (ref as { options?: { root?: unknown } } | undefined)?.options?.root;
  if (shell === undefined || typeof root !== 'string' || Object.keys(env).length === 0) return;
  const fresh = createShellTool(new NodeWorkspace({ root, env }));
  tools.shell = { ...shell, execute: fresh.execute };
}
