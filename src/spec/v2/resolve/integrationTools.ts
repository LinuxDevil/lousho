/**
 * resolveIntegrationRef() / resolveOpenApiRef(): the `{ integration }` and
 * `{ openapi }` tool refs become the SDK's real integration and OpenAPI
 * tools. Credential values go through resolveStringOrSecret — a missing
 * secret is LOUSHO_SPEC_SECRET_MISSING at build time, naming the spec field
 * and never the value. Node-side: the factories pull in `node:*`; the
 * schemas stay in `../tools.ts`.
 */
import type { ToolDescriptor } from '../../../types';
import { createConfluenceTools } from '../../../tools/built-in/confluence';
import { createEmailTool } from '../../../tools/built-in/email';
import { createFigmaTools } from '../../../tools/built-in/figma';
import { createGitHubTools } from '../../../tools/built-in/github';
import { createGitHubAccountTools } from '../../../tools/built-in/githubAccount';
import { createGoogleWorkspaceTools } from '../../../tools/built-in/google';
import { createJenkinsTools } from '../../../tools/built-in/jenkins';
import { createJiraTools } from '../../../tools/built-in/jira';
import { createSlackTool } from '../../../tools/built-in/slack';
import { createSlackApiTools } from '../../../tools/built-in/slackApi';
import { openApiTools } from '../../../tools/openapi/openApiTools';
import type { IntegrationName, ToolRef } from '../tools';
import { resolveSecretRef, resolveStringOrSecret, type SecretHost } from './secrets';

/**
 * The tools one integration builds from its resolved credential values. The
 * keys a ref may carry — and which builders read — are the validated
 * `INTEGRATION_CREDENTIALS` of `../tools.ts`.
 */
const INTEGRATION_BUILDERS: Record<IntegrationName, (credentials: Record<string, string>) => Record<string, ToolDescriptor>> = {
  github: (credentials) =>
    credentials['owner'] === undefined || credentials['repo'] === undefined
      ? createGitHubAccountTools(credentials['token'])
      : createGitHubTools({
          owner: credentials['owner'],
          repo: credentials['repo'],
          ...(credentials['appId'] !== undefined && credentials['privateKey'] !== undefined
            ? { app: { appId: credentials['appId'], privateKey: credentials['privateKey'].replace(/\\n/g, '\n') } }
            : { token: credentials['token'] }),
        }).getAll(),
  jira: (credentials) =>
    createJiraTools({
      baseUrl: credentials['baseUrl'],
      email: credentials['email'],
      apiToken: credentials['apiToken'],
    }).getAll(),
  email: (credentials) => ({
    send_email: createEmailTool({
      apiKey: credentials['apiKey'],
      ...(credentials['apiUrl'] !== undefined && { apiUrl: credentials['apiUrl'] }),
      ...(credentials['defaultFrom'] !== undefined && { defaultFrom: credentials['defaultFrom'] }),
    }),
  }),
  confluence: (credentials) =>
    createConfluenceTools({
      baseUrl: credentials['baseUrl'],
      email: credentials['email'],
      apiToken: credentials['apiToken'],
    }).getAll(),
  slack: (credentials) => ({
    ...(credentials['webhookUrl'] !== undefined && { slack_alert: createSlackTool({ webhookUrl: credentials['webhookUrl'] }) }),
    ...(credentials['botToken'] !== undefined && createSlackApiTools({ botToken: credentials['botToken'] }).getAll()),
  }),
  google: (credentials) =>
    createGoogleWorkspaceTools({
      clientId: credentials['clientId'],
      clientSecret: credentials['clientSecret'],
      refreshToken: credentials['refreshToken'],
    }).getAll(),
  jenkins: (credentials) =>
    createJenkinsTools({
      baseUrl: credentials['baseUrl'],
      username: credentials['username'],
      apiToken: credentials['apiToken'],
    }).getAll(),
  figma: (credentials) => createFigmaTools({ token: credentials['token'] }).getAll(),
};

/**
 * `{ integration: 'github' | 'jira' | 'slack' | 'email', credentials }` →
 * the integration's tools, keyed by model-facing name. `field` (e.g.
 * 'tools.0') names the ref in errors; a missing secret throws
 * LOUSHO_SPEC_SECRET_MISSING at `field.credentials.<key>`.
 */
export async function resolveIntegrationRef(
  ref: Extract<ToolRef, { integration: string }>,
  host: SecretHost,
  field: string
): Promise<Record<string, ToolDescriptor>> {
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(ref.credentials)) {
    credentials[key] = await resolveStringOrSecret(value, host, `${field}.credentials.${key}`);
  }
  return INTEGRATION_BUILDERS[ref.integration](credentials);
}

/**
 * `{ openapi: { url, ... } }` → one tool per selected operation
 * (`openApiTools`), keyed by tool name. `bearerToken` is handed over as a
 * function so a rotated secret is re-read per call — but it is resolved
 * once eagerly first, so a missing secret fails at build time
 * (LOUSHO_SPEC_SECRET_MISSING at `field.openapi.bearerToken`), not mid-run.
 */
export async function resolveOpenApiRef(
  ref: Extract<ToolRef, { openapi: object }>,
  host: SecretHost,
  field: string
): Promise<Record<string, ToolDescriptor>> {
  const { url, include, exclude, approval, bearerToken } = ref.openapi;
  if (bearerToken !== undefined) {
    await resolveSecretRef(bearerToken, host, `${field}.openapi.bearerToken`);
  }
  const tools = await openApiTools(url, {
    ...(include !== undefined && { include }),
    ...(exclude !== undefined && { exclude }),
    ...(approval !== undefined && { approval }),
    ...(bearerToken !== undefined && {
      bearerToken: () => resolveSecretRef(bearerToken, host, `${field}.openapi.bearerToken`),
    }),
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}
