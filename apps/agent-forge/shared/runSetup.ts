import { CONNECTORS, INTEGRATION_SECRETS } from './profileWire';
import type { RunSetup, RunSetupSkipped } from './wireTypes';

export const RUN_SETUP_PREFIX = 'Setup · ';

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const titled = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const providerLabel = (integration: string): string =>
  CONNECTORS.find((def) => def.id === INTEGRATION_SECRETS[integration]?.connector)?.label ?? titled(integration);

function skippedSentence({ integration, reason, missing }: RunSetupSkipped): string {
  return reason === 'off'
    ? `${providerLabel(integration)} is connected but switched off for this kind of run.`
    : `${providerLabel(integration)} is missing its ${(missing ?? []).join(', ')}.`;
}

export function describeRunSetup(setup: RunSetup): { summary: string; detail?: string } {
  const parts = [RUN_SETUP_PREFIX.slice(0, 5)];
  const names = setup.accounts.map((account) => account.integration);
  if (setup.note !== undefined) parts.push(setup.note);
  else if (names.length > 0) parts.push(`${plural(names.length, 'connected account')} (${names.join(', ')})`);
  else if (setup.declared.length === 0 && setup.skipped.length === 0) parts.push('No connected accounts. Connect one in Profile → Connectors.');
  else parts.push('No connected accounts attached');
  if (setup.declared.length > 0) parts.push(`${plural(setup.declared.length, 'declared integration')} (${setup.declared.join(', ')})`);
  const profileMcp = setup.profileMcpServers ?? [];
  if (setup.mcpServers.length + profileMcp.length > 0) parts.push(plural(setup.mcpServers.length + profileMcp.length, 'MCP server'));
  if (setup.tools !== undefined) parts.push(plural(setup.tools, 'tool'));
  if (setup.workspaceRoot !== undefined) parts.push(`workspace ${setup.workspaceRoot}`);
  const lines = [
    ...setup.accounts.map(
      (account) =>
        `${account.integration}: ${account.tools.join(', ') || 'no tools'}${account.approvals.length > 0 ? ` (ask for approval: ${account.approvals.join(', ')})` : ''}`
    ),
    ...(profileMcp.length > 0 ? [`MCP servers from Profile: ${profileMcp.join(', ')} (every tool asks for approval)`] : []),
    ...new Set(setup.skipped.map(skippedSentence)),
  ];
  return { summary: parts.join(' · '), ...(lines.length > 0 && { detail: lines.join('\n') }) };
}
