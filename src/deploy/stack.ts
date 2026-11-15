import { VERSION } from '../version';

export interface DeployAgent {
  name: string;
  dir: string;
}

export interface DeployConfig {
  name: string;
  host: string;
  user?: string;
  domain: string;
  proxy?: 'caddy' | 'traefik';
  traefikNetwork?: string;
  studio?: { user: string };
  agents: DeployAgent[];
  env?: string[];
  githubApp?: { agent: string; prefix: string };
}

export type StudioSource = { kind: 'npm'; sdk: string; studio: string } | { kind: 'local' };

export const STUDIO_PORT = 4750;
export const AGENT_PORT = 3000;

export function hostFor(config: DeployConfig, service: string): string {
  return `${service}.${config.domain}`;
}

export function sslipDomain(ip: string): string {
  return `${ip.replace(/[.:]/g, '-')}.sslip.io`;
}

export function assertValidConfig(config: DeployConfig): void {
  const name = /^[a-z][a-z0-9-]{0,30}$/;
  for (const value of [config.name, ...config.agents.map((agent) => agent.name)]) {
    if (!name.test(value)) throw new Error(`'${value}' must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (config.agents.some((agent) => agent.name === 'studio')) throw new Error("'studio' is reserved for Lousho Studio");
  if (new Set(config.agents.map((agent) => agent.name)).size !== config.agents.length) throw new Error('agent names must be unique');
  for (const key of config.env ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`env name '${key}' must be UPPER_CASE`);
  }
  if (!/^[a-z0-9.-]+$/i.test(config.domain)) throw new Error(`'${config.domain}' is not a domain name`);
}

export function studioDockerfile(source: StudioSource): string {
  const install =
    source.kind === 'npm'
      ? `RUN npm install --omit=dev lousho@${source.sdk} lousho-studio@${source.studio}`
      : 'COPY *.tgz ./\nRUN npm install --omit=dev ./lousho-*.tgz && rm -f ./*.tgz';
  return `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/lousho
RUN npm init -y >/dev/null
${install}
ENV PATH=/opt/lousho/node_modules/.bin:$PATH
RUN mkdir -p /workspace /home/node/.lousho && chown node:node /workspace /home/node/.lousho
USER node
WORKDIR /workspace
EXPOSE ${STUDIO_PORT}
CMD ["lousho-studio", "--workspace", "/workspace", "--host", "0.0.0.0", "--port", "${STUDIO_PORT}"]
`;
}

export function npmSource(): StudioSource {
  return { kind: 'npm', sdk: VERSION, studio: 'latest' };
}

function traefikLabels(config: DeployConfig, service: string, port: number, auth: boolean): string[] {
  const router = `${config.name}-${service}`;
  const labels = [
    'traefik.enable: "true"',
    `traefik.http.routers.${router}.rule: Host(\`${hostFor(config, service)}\`)`,
    `traefik.http.routers.${router}.entrypoints: websecure`,
    `traefik.http.routers.${router}.tls.certresolver: letsencrypt`,
    `traefik.http.services.${router}.loadbalancer.server.port: "${port}"`,
  ];
  if (auth) {
    labels.push(
      `traefik.http.routers.${router}.middlewares: ${router}-auth`,
      `traefik.http.middlewares.${router}-auth.basicauth.users: \${STUDIO_BASIC_AUTH}`,
      `traefik.http.routers.${router}-hooks.rule: Host(\`${hostFor(config, service)}\`) && PathPrefix(\`/hooks/\`)`,
      `traefik.http.routers.${router}-hooks.entrypoints: websecure`,
      `traefik.http.routers.${router}-hooks.tls.certresolver: letsencrypt`,
      `traefik.http.routers.${router}-hooks.service: ${router}`
    );
  }
  return labels;
}

function serviceBlock(lines: string[], labels: string[], traefikNetwork: string | undefined): string {
  const out = [...lines];
  if (labels.length > 0) out.push('    labels:', ...labels.map((label) => `      ${label}`));
  if (traefikNetwork) out.push('    networks: [default, proxy]');
  return out.join('\n');
}

export function renderCompose(config: DeployConfig): string {
  const traefik = config.proxy === 'traefik';
  const network = traefik ? config.traefikNetwork : undefined;
  const services: string[] = [];
  if (!traefik) {
    services.push(
      [
        '  caddy:',
        '    image: caddy:2-alpine',
        '    restart: unless-stopped',
        '    ports: ["80:80", "443:443"]',
        '    env_file: [.env]',
        '    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]',
      ].join('\n')
    );
  }
  if (config.studio) {
    services.push(
      serviceBlock(
        [
          '  studio:',
          '    build: ./studio',
          '    restart: unless-stopped',
          '    env_file: [.env]',
          '    volumes: ["workspace:/workspace", "studio-home:/home/node/.lousho"]',
        ],
        traefik ? traefikLabels(config, 'studio', STUDIO_PORT, true) : [],
        network
      )
    );
  }
  for (const agent of config.agents) {
    services.push(
      serviceBlock(
        [
          `  ${agent.name}:`,
          `    build: ./agents/${agent.name}`,
          '    restart: unless-stopped',
          '    env_file: [.env]',
          '    environment:',
          `      LOUSHO_STORE: sqlite:/app/data/lousho.db`,
          `    volumes: ["${agent.name}-data:/app/data"]`,
        ],
        traefik ? traefikLabels(config, agent.name, AGENT_PORT, false) : [],
        network
      )
    );
  }
  const volumes = [
    ...(traefik ? [] : ['caddy-data', 'caddy-config']),
    ...(config.studio ? ['workspace', 'studio-home'] : []),
    ...config.agents.map((agent) => `${agent.name}-data`),
  ];
  const parts = [`name: ${config.name}`, 'services:', services.join('\n'), 'volumes:', ...volumes.map((v) => `  ${v}:`)];
  if (network) parts.push('networks:', '  proxy:', '    external: true', `    name: ${network}`);
  return `${parts.join('\n')}\n`;
}

export function renderCaddyfile(config: DeployConfig): string {
  const blocks: string[] = [];
  if (config.studio) {
    blocks.push(
      `${hostFor(config, 'studio')} {\n  handle /hooks/* {\n    reverse_proxy studio:${STUDIO_PORT}\n  }\n  handle {\n    basic_auth {\n      {$STUDIO_USER} {$STUDIO_HASH}\n    }\n    reverse_proxy studio:${STUDIO_PORT}\n  }\n}`
    );
  }
  for (const agent of config.agents) {
    blocks.push(`${hostFor(config, agent.name)} {\n  reverse_proxy ${agent.name}:${AGENT_PORT}\n}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function envLine(key: string, value: string): string {
  if (value.includes("'") || value.includes('\n')) throw new Error(`${key} must not contain a single quote or a newline`);
  return `${key}='${value}'`;
}
