export type ConnectorId = 'github' | 'atlassian' | 'slack' | 'google' | 'jenkins' | 'figma' | 'email';

export interface ConnectorField {
  key: string;
  label: string;
  secret: string;
  sensitive: boolean;
  required: boolean;
  placeholder?: string;
}

export interface ConnectorDef {
  id: ConnectorId;
  label: string;
  description: string;
  fields: ConnectorField[];
  oauth?: boolean;
  help: string;
}

export const CONNECTORS: readonly ConnectorDef[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repositories, pull requests, issues and reviews.',
    help: 'A fine-grained or classic personal access token from github.com/settings/tokens.',
    fields: [{ key: 'token', label: 'Personal access token', secret: 'GITHUB_TOKEN', sensitive: true, required: true, placeholder: 'ghp_… or github_pat_…' }],
  },
  {
    id: 'atlassian',
    label: 'Atlassian',
    description: 'Jira issues and Confluence pages.',
    help: 'An API token from id.atlassian.com/manage-profile/security/api-tokens.',
    fields: [
      { key: 'baseUrl', label: 'Site URL', secret: 'JIRA_BASE_URL', sensitive: false, required: true, placeholder: 'https://your-site.atlassian.net' },
      { key: 'email', label: 'Account email', secret: 'JIRA_EMAIL', sensitive: false, required: true },
      { key: 'apiToken', label: 'API token', secret: 'JIRA_API_TOKEN', sensitive: true, required: true },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Read channels and threads, post messages, upload files.',
    help: 'A bot token (xoxb-…) from your Slack app, an incoming webhook URL, or both.',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: 'SLACK_BOT_TOKEN', sensitive: true, required: false, placeholder: 'xoxb-…' },
      { key: 'webhookUrl', label: 'Incoming webhook URL', secret: 'SLACK_WEBHOOK_URL', sensitive: true, required: false, placeholder: 'https://hooks.slack.com/services/…' },
    ],
  },
  {
    id: 'google',
    label: 'Google Workspace',
    description: 'Gmail, Drive, Calendar, Docs, Sheets and Meet.',
    help: 'A Google Cloud OAuth client (type "Web application") with this Studio\'s callback URL as an authorized redirect URI.',
    oauth: true,
    fields: [
      { key: 'clientId', label: 'OAuth client ID', secret: 'GOOGLE_CLIENT_ID', sensitive: false, required: true },
      { key: 'clientSecret', label: 'OAuth client secret', secret: 'GOOGLE_CLIENT_SECRET', sensitive: true, required: true },
    ],
  },
  {
    id: 'jenkins',
    label: 'Jenkins',
    description: 'Builds, logs, artifacts and job triggers.',
    help: 'Your Jenkins username and an API token from your Jenkins user page → Security.',
    fields: [
      { key: 'baseUrl', label: 'Server URL', secret: 'JENKINS_BASE_URL', sensitive: false, required: true, placeholder: 'https://jenkins.example.com' },
      { key: 'username', label: 'Username', secret: 'JENKINS_USERNAME', sensitive: false, required: true },
      { key: 'apiToken', label: 'API token', secret: 'JENKINS_API_TOKEN', sensitive: true, required: true },
    ],
  },
  {
    id: 'figma',
    label: 'Figma',
    description: 'Pages, design context, images, variables and comments.',
    help: 'A personal access token from Figma → Settings → Security.',
    fields: [{ key: 'token', label: 'Personal access token', secret: 'FIGMA_TOKEN', sensitive: true, required: true, placeholder: 'figd_…' }],
  },
  {
    id: 'email',
    label: 'Email (Resend)',
    description: 'Send email from agents and run notifications.',
    help: 'An API key from resend.com/api-keys and a sender on a verified domain.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: 'RESEND_API_KEY', sensitive: true, required: true, placeholder: 're_…' },
      { key: 'defaultFrom', label: 'Send from', secret: 'EMAIL_FROM', sensitive: false, required: false, placeholder: 'Lousho <agents@example.com>' },
    ],
  },
];

export const GOOGLE_REFRESH_SECRET = 'GOOGLE_REFRESH_TOKEN';

export const INTEGRATION_SECRETS: Record<string, { connector: ConnectorId; credentials: Record<string, string> }> = {
  github: { connector: 'github', credentials: { token: 'GITHUB_TOKEN' } },
  jira: { connector: 'atlassian', credentials: { baseUrl: 'JIRA_BASE_URL', email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' } },
  confluence: { connector: 'atlassian', credentials: { baseUrl: 'JIRA_BASE_URL', email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' } },
  slack: { connector: 'slack', credentials: { botToken: 'SLACK_BOT_TOKEN', webhookUrl: 'SLACK_WEBHOOK_URL' } },
  email: { connector: 'email', credentials: { apiKey: 'RESEND_API_KEY', defaultFrom: 'EMAIL_FROM' } },
  google: {
    connector: 'google',
    credentials: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', refreshToken: GOOGLE_REFRESH_SECRET },
  },
  jenkins: { connector: 'jenkins', credentials: { baseUrl: 'JENKINS_BASE_URL', username: 'JENKINS_USERNAME', apiToken: 'JENKINS_API_TOKEN' } },
  figma: { connector: 'figma', credentials: { token: 'FIGMA_TOKEN' } },
};

export interface ConnectorStatus {
  id: ConnectorId;
  connected: boolean;
  account?: string;
  connectedAt?: string;
  scopes?: string[];
  verifiedAt?: string;
  error?: string;
  filled: string[];
}

export const MCP_CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const mcpTokenSecret = (name: string): string => `MCP_${name.toUpperCase().replace(/-/g, '_')}_TOKEN`;

export function mcpConnectorUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a valid URL.';
  }
  if (url.username !== '' || url.password !== '') return 'Do not put credentials in the URL. Use the token field.';
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return undefined;
  return 'The URL must start with https:// (http:// is only allowed for localhost).';
}

export interface McpConnectorStatus {
  name: string;
  url: string;
  hasToken: boolean;
  connectedAt: string;
  verifiedAt?: string;
  error?: string;
  toolCount?: number;
}

export interface StoredMcpConnector {
  name: string;
  url: string;
  tokenSecret?: string;
}

export interface McpConnectRequest {
  url: string;
  token?: string;
}

export interface ConnectRequest {
  values: Record<string, string>;
}

export interface ConnectResponse {
  status: ConnectorStatus;
  authUrl?: string;
}

export interface AgentTarget {
  workspaceId: string;
  agentId: string;
}

export interface AutomationKey {
  id: string;
  name: string;
  prefix: string;
  targets: AgentTarget[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreateAutomationKeyRequest {
  name: string;
  targets: AgentTarget[];
}

export interface CreatedAutomationKey {
  key: AutomationKey;
  token: string;
}

export type InboundMode = 'hmac' | 'token';

export interface InboundEndpoint {
  id: string;
  name: string;
  mode: InboundMode;
  targets: AgentTarget[];
  promptTemplate: string;
  createdAt: string;
  expiresAt?: string;
  path: string;
}

export interface CreateInboundRequest {
  name: string;
  mode: InboundMode;
  targets: AgentTarget[];
  promptTemplate?: string;
  expiresAt?: string;
}

export interface CreatedInbound {
  endpoint: InboundEndpoint;
  secret: string;
}

export type DeliveryOutcome = 'started' | 'busy' | 'disabled' | 'missing' | 'error';

export interface InboundDelivery {
  id: string;
  endpointId: string;
  at: string;
  accepted: boolean;
  reason?: string;
  bytes: number;
  runs: Array<AgentTarget & { outcome: DeliveryOutcome; detail?: string }>;
}

export type NotificationChannel = 'off' | 'slack' | 'email' | 'both';

export type NotificationEvent = 'started' | 'completed' | 'failed';

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = ['started', 'completed', 'failed'];

export interface NotificationSettings {
  channel: NotificationChannel;
  events: Record<NotificationEvent, boolean>;
  slackChannel?: string;
  emailTo?: string;
  overrides: Record<string, NotificationChannel>;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  channel: 'off',
  events: { started: false, completed: true, failed: true },
  overrides: {},
};

export const targetKey = (t: AgentTarget): string => `${t.workspaceId}/${t.agentId}`;
