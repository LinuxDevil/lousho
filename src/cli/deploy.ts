import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { PromptObject } from 'prompts';
import { loadOptionalPeer } from '../providers/optionalPeer';
import { signAppJwt } from '../channels/githubAppAuth';
import { runBuild } from './build';
import { findSdkRoot } from '../deploy/bundle';
import { assertStudioBundleFresh } from './studioFreshness';
import {
  assertValidConfig,
  envLine,
  hostFor,
  npmSource,
  renderCaddyfile,
  renderCompose,
  sslipDomain,
  studioDockerfile,
  type DeployConfig,
} from '../deploy/stack';

const CONFIG_FILE = 'lousho.deploy.json';
const KEY_FOR_PROVIDER: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const HELP = `Usage: lousho deploy [options]
       lousho deploy github-app --agent <name> [--prefix P] [--app-name N] [--repo owner/name]

Deploys Lousho Studio and agent folders to a server over SSH with Docker
Compose, behind HTTPS (Caddy, or the server's existing Traefik). Asks for
anything missing and saves the answers to ${CONFIG_FILE}; secrets go to
~/.config/lousho/deploy-<name>.env (mode 600), never to that file.

Options:
  --host H         the server's address (SSH as --user, key auth)
  --user U         SSH user (default root)
  --name N         compose project and /opt/<name> folder (default lousho)
  --domain D       base domain; services answer on <service>.<D> (default <ip>.sslip.io)
  --agent DIR      an agent folder to deploy (repeatable)
  --studio-user U  deploy Studio behind this login (default: ask)
  --no-studio      deploy agents only
  --env KEY        another secret every container gets (repeatable)
  --password-stdin read Studio's password from stdin
  --local          build Studio from this checkout instead of npm
  --dry-run        write the stack to .lousho/deploy and stop
  -y, --yes        never ask; fail when something is missing
  -h, --help       show this help`;

interface Flags {
  host?: string;
  user?: string;
  name?: string;
  domain?: string;
  agent: string[];
  studioUser?: string;
  noStudio: boolean;
  env: string[];
  passwordStdin: boolean;
  local: boolean;
  dryRun: boolean;
  yes: boolean;
}

type Answers = Record<string, string | boolean | undefined>;

class DeployError extends Error {}

function parseFlags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      user: { type: 'string' },
      name: { type: 'string' },
      domain: { type: 'string' },
      agent: { type: 'string', multiple: true },
      'studio-user': { type: 'string' },
      'no-studio': { type: 'boolean' },
      env: { type: 'string', multiple: true },
      'password-stdin': { type: 'boolean' },
      local: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
  });
  return {
    host: values.host,
    user: values.user,
    name: values.name,
    domain: values.domain,
    agent: values.agent ?? [],
    studioUser: values['studio-user'],
    noStudio: values['no-studio'] ?? false,
    env: values.env ?? [],
    passwordStdin: values['password-stdin'] ?? false,
    local: values.local ?? false,
    dryRun: values['dry-run'] ?? false,
    yes: values.yes ?? false,
  };
}

async function ask(questions: PromptObject[], yes: boolean): Promise<Answers> {
  if (questions.length === 0) return {};
  if (yes || !process.stdin.isTTY) {
    throw new DeployError(`missing: ${questions.map((q) => String(q.name)).join(', ')} (pass them as flags or run in a terminal)`);
  }
  const { default: prompts } = await loadOptionalPeer('prompts', () => import('prompts'));
  let cancelled = false;
  const answers = (await prompts(questions, { onCancel: () => (cancelled = true) })) as Answers;
  if (cancelled) throw new DeployError('cancelled');
  return answers;
}

function readJson<T>(file: string): T | undefined {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
}

function secretsPath(name: string): string {
  return path.join(os.homedir(), '.config', 'lousho', `deploy-${name}.env`);
}

function readSecrets(name: string): Map<string, string> {
  const file = secretsPath(name);
  if (!fs.existsSync(file)) return new Map();
  return new Map(Object.entries(parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>));
}

function writeSecrets(name: string, secrets: Map<string, string>): void {
  const file = secretsPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, [...secrets].map(([key, value]) => envLine(key, value)).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function detectAgents(): string[] {
  const root = path.resolve('agents');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'agent.json')))
    .map((entry) => path.join('agents', entry.name));
}

function agentName(source: string): string {
  const resolved = path.resolve(source);
  const folder = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
  return path.basename(folder).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function providerKeys(config: DeployConfig): string[] {
  const keys = new Set<string>();
  for (const agent of config.agents) {
    const spec = readJson<{ model?: string }>(path.join(agent.dir, 'agent.json'));
    const provider = spec?.model?.split('/')[0];
    if (provider && KEY_FOR_PROVIDER[provider]) keys.add(KEY_FOR_PROVIDER[provider]);
  }
  if (config.studio && keys.size === 0) keys.add('OPENROUTER_API_KEY');
  return [...keys];
}

function ssh(config: DeployConfig, command: string, input?: string): string {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', `${config.user ?? 'root'}@${config.host}`, command], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new DeployError(`ssh ${config.host} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (result.status !== 0) throw new DeployError(`${command} ${args[0] ?? ''} failed`);
}

async function resolveConfig(flags: Flags): Promise<DeployConfig> {
  const saved = readJson<DeployConfig>(CONFIG_FILE);
  const config: DeployConfig = {
    name: flags.name ?? saved?.name ?? 'lousho',
    host: flags.host ?? saved?.host ?? '',
    user: flags.user ?? saved?.user ?? 'root',
    domain: flags.domain ?? saved?.domain ?? '',
    agents: flags.agent.length > 0 ? flags.agent.map((dir) => ({ name: agentName(dir), dir })) : (saved?.agents ?? []),
    env: [...new Set([...(saved?.env ?? []), ...flags.env])],
    ...(saved?.githubApp ? { githubApp: saved.githubApp } : {}),
    ...(flags.noStudio ? {} : flags.studioUser ? { studio: { user: flags.studioUser } } : saved?.studio ? { studio: saved.studio } : {}),
  };
  const fresh = saved === undefined;
  const detected = detectAgents();
  const answers = await ask(
    [
      ...(config.host ? [] : [{ type: 'text' as const, name: 'host', message: 'Server address (SSH as root with your key)' }]),
      ...(fresh && !flags.noStudio && !config.studio
        ? [{ type: 'text' as const, name: 'studioUser', message: 'Studio login username (empty: no Studio)', initial: os.userInfo().username }]
        : []),
      ...(fresh && flags.agent.length === 0 && detected.length > 0
        ? [{ type: 'multiselect' as const, name: 'agents', message: 'Agents to deploy', choices: detected.map((dir) => ({ title: dir, value: dir, selected: true })) }]
        : []),
    ],
    flags.yes
  );
  if (typeof answers.host === 'string') config.host = answers.host.trim();
  if (typeof answers.studioUser === 'string' && answers.studioUser.trim() !== '') config.studio = { user: answers.studioUser.trim() };
  if (Array.isArray(answers.agents)) config.agents = (answers.agents as string[]).map((dir) => ({ name: agentName(dir), dir }));
  if (!config.host) throw new DeployError('--host is required');
  if (!config.domain) {
    const ip = /^[\d.]+$/.test(config.host) ? config.host : (await lookup(config.host, { family: 4 })).address;
    config.domain = sslipDomain(ip);
  }
  if (!config.studio && config.agents.length === 0) throw new DeployError('nothing to deploy: add --agent or a Studio user');
  assertValidConfig(config);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  return config;
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function resolveSecrets(config: DeployConfig, flags: Flags): Promise<{ secrets: Map<string, string>; password?: string }> {
  const secrets = readSecrets(config.name);
  if (config.agents.length > 0 && !secrets.has('LOUSHO_API_TOKEN')) secrets.set('LOUSHO_API_TOKEN', randomBytes(24).toString('hex'));
  const wanted = [...providerKeys(config), ...(config.env ?? [])];
  for (const key of wanted) {
    const value = process.env[key];
    if (!secrets.has(key) && value) secrets.set(key, value);
  }
  const missing = wanted.filter((key) => !secrets.has(key));
  const needsPassword = config.studio !== undefined && (secrets.get('STUDIO_USER') !== config.studio.user || !secrets.has('STUDIO_HASH'));
  let password: string | undefined;
  if (needsPassword && flags.passwordStdin) password = await readStdin();
  const answers = await ask(
    [
      ...missing.map((key) => ({ type: 'password' as const, name: key, message: key })),
      ...(needsPassword && password === undefined
        ? [{ type: 'password' as const, name: 'password', message: `Studio password for ${config.studio?.user}`, validate: (v: string) => v.length >= 12 || 'at least 12 characters' }]
        : []),
    ],
    flags.yes
  );
  for (const key of missing) secrets.set(key, String(answers[key] ?? ''));
  if (typeof answers.password === 'string') password = answers.password;
  if (config.studio && password !== undefined) {
    if (password.length < 12) throw new DeployError('the Studio password needs at least 12 characters');
    const hash = ssh(config, 'docker run --rm -i caddy:2-alpine caddy hash-password 2>/dev/null | tail -1', `${password}\n`);
    if (!hash.startsWith('$2')) throw new DeployError('could not hash the Studio password on the server');
    secrets.set('STUDIO_USER', config.studio.user);
    secrets.set('STUDIO_HASH', hash);
    secrets.set('STUDIO_BASIC_AUTH', `${config.studio.user}:${hash}`);
  }
  writeSecrets(config.name, secrets);
  return { secrets, password };
}

function detectProxy(config: DeployConfig): void {
  if (!ssh(config, 'docker compose version >/dev/null 2>&1 && echo ok || true').includes('ok')) {
    throw new DeployError(`Docker with the compose plugin is not installed on ${config.host}; install it first (https://docs.docker.com/engine/install/)`);
  }
  const rows = ssh(config, "docker ps --format '{{.Names}}|{{.Image}}'").split('\n').filter(Boolean).map((row) => row.split('|'));
  const traefik = rows.find(([, image]) => /traefik/i.test(image ?? ''));
  if (!traefik) {
    const ours = rows.some(([name]) => name === `${config.name}-caddy-1`);
    const busy = ssh(config, "ss -ltnH '( sport = :443 or sport = :80 )' 2>/dev/null | head -1 || true");
    if (busy && !ours) throw new DeployError(`ports 80/443 on ${config.host} are taken by something other than Traefik; free them first`);
    config.proxy = 'caddy';
    delete config.traefikNetwork;
    return;
  }
  const holder = traefik;
  const networks = ssh(config, `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${holder[0]}`).split(/\s+/).filter(Boolean);
  config.proxy = 'traefik';
  const network = networks.find((n) => n !== 'host');
  if (network) config.traefikNetwork = network;
  else delete config.traefikNetwork;
}

function packLocal(target: string): void {
  const root = findSdkRoot();
  const studio = path.join(root, 'apps', 'agent-forge');
  if (!fs.existsSync(path.join(root, 'dist', 'index.js')) || !fs.existsSync(path.join(studio, 'dist-server', 'cli.cjs'))) {
    throw new DeployError('--local needs built packages: run `npm run build && npm run build:studio` in the SDK checkout');
  }
  run('npm', ['pack', '--silent', '--pack-destination', target], root);
  run('npm', ['pack', '--silent', '--pack-destination', target], studio);
}

async function writeStack(config: DeployConfig, secrets: Map<string, string>, flags: Flags, dir: string): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), renderCompose(config));
  if (config.proxy !== 'traefik') fs.writeFileSync(path.join(dir, 'Caddyfile'), renderCaddyfile(config));
  fs.writeFileSync(path.join(dir, '.env'), [...secrets].map(([key, value]) => envLine(key, value)).join('\n') + '\n', { mode: 0o600 });
  if (config.studio) {
    const studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir);
    if (flags.local) packLocal(studioDir);
    fs.writeFileSync(path.join(studioDir, 'Dockerfile'), studioDockerfile(flags.local ? { kind: 'local' } : npmSource(latestStudioVersion())));
  }
  for (const agent of config.agents) {
    const code = await runBuild([agent.dir, '--target=docker', `--out=${path.join(dir, 'agents', agent.name)}`], {
      stdout: () => undefined,
      stderr: (line) => console.error(line),
    });
    if (code !== 0) throw new DeployError(`building ${agent.dir} failed`);
  }
}

async function waitHealthy(url: string, headers: Record<string, string>): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(url, { headers }).catch(() => undefined);
    if (res?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

function webhookUrl(config: DeployConfig, agent: string): string {
  return config.agents.some((a) => a.name === agent)
    ? `https://${hostFor(config, agent)}/channels/github`
    : `https://${hostFor(config, 'studio')}/hooks/${agent}/channel/github`;
}

async function setWebhook(config: DeployConfig, secrets: Map<string, string>): Promise<void> {
  const app = config.githubApp;
  if (!app) return;
  const appId = secrets.get(`${app.prefix}APP_ID`);
  const key = secrets.get(`${app.prefix}APP_PRIVATE_KEY`)?.replace(/\\n/g, '\n');
  if (!appId || !key) return;
  const url = webhookUrl(config, app.agent);
  const jwt = await signAppJwt(appId, key);
  const res = await fetch('https://api.github.com/app/hook/config', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'lousho-deploy' },
    body: JSON.stringify({ url, content_type: 'json' }),
  });
  console.log(res.ok ? `GitHub App webhook -> ${url}` : `GitHub App webhook update failed: HTTP ${res.status}`);
}

async function deploy(flags: Flags): Promise<void> {
  if (flags.local) {
    try {
      assertStudioBundleFresh(path.join(findSdkRoot(), 'apps', 'agent-forge'));
    } catch (error) {
      throw new DeployError((error as Error).message);
    }
  }
  const config = await resolveConfig(flags);
  const { secrets, password } = flags.dryRun ? { secrets: readSecrets(config.name), password: undefined } : await resolveSecrets(config, flags);
  if (flags.dryRun) config.proxy ??= 'caddy';
  else detectProxy(config);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  const dir = flags.dryRun ? path.resolve('.lousho', 'deploy') : fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-deploy-'));
  try {
    await writeStack(config, secrets, flags, dir);
    if (flags.dryRun) {
      console.log(`Wrote the stack to ${path.relative(process.cwd(), dir)} (proxy: ${config.proxy}).`);
      return;
    }
    const remote = `/opt/${config.name}`;
    const archive = path.join(os.tmpdir(), `lousho-deploy-${config.name}-${process.pid}.tgz`);
    run('tar', ['--no-xattrs', '-czf', archive, '-C', dir, '.']);
    ssh(config, `mkdir -p ${remote} && chmod 700 ${remote} && rm -rf ${remote}/agents ${remote}/studio`);
    run('scp', ['-q', '-o', 'BatchMode=yes', archive, `${config.user ?? 'root'}@${config.host}:${remote}/stack.tgz`]);
    fs.rmSync(archive, { force: true });
    console.log(`Building and starting on ${config.host} (proxy: ${config.proxy})...`);
    const up = spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', `${config.user ?? 'root'}@${config.host}`, `cd ${remote} && tar -xzf stack.tgz && rm stack.tgz && chmod 600 .env && docker compose up -d --build --remove-orphans`],
      { stdio: 'inherit' }
    );
    if (up.status !== 0) throw new DeployError('docker compose up failed on the server');
  } finally {
    if (!flags.dryRun) fs.rmSync(dir, { recursive: true, force: true });
  }
  const checks: Array<[string, Record<string, string>]> = config.agents.map((agent) => [`https://${hostFor(config, agent.name)}/health`, {}]);
  if (config.studio && password !== undefined) {
    checks.push([`https://${hostFor(config, 'studio')}/health`, { authorization: `Basic ${Buffer.from(`${config.studio.user}:${password}`).toString('base64')}` }]);
  }
  const unhealthy: string[] = [];
  for (const [url, headers] of checks) {
    const ok = await waitHealthy(url, headers);
    if (!ok) unhealthy.push(url);
    console.log(`${ok ? 'healthy' : 'NOT healthy'}: ${url}`);
  }
  await setWebhook(config, secrets);
  if (config.studio) console.log(`Studio: https://${hostFor(config, 'studio')} (login: ${config.studio.user})`);
  for (const agent of config.agents) console.log(`${agent.name}: https://${hostFor(config, agent.name)} (Bearer LOUSHO_API_TOKEN from ${secretsPath(config.name)})`);
  if (unhealthy.length > 0) throw new DeployError(`deployed, but not healthy: ${unhealthy.join(', ')}`);
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
}

async function githubApp(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { agent: { type: 'string' }, prefix: { type: 'string' }, 'app-name': { type: 'string' }, repo: { type: 'string' } },
  });
  const config = readJson<DeployConfig>(CONFIG_FILE);
  if (!config) throw new DeployError(`run lousho deploy once first, so ${CONFIG_FILE} knows the domain`);
  const agent = values.agent ?? config.agents[0]?.name;
  if (!agent || !/^[a-z0-9][a-z0-9-]*$/.test(agent)) throw new DeployError('--agent must name a deployed agent or a Studio agent id');
  if (!config.agents.some((a) => a.name === agent) && !config.studio) throw new DeployError(`'${agent}' is not deployed and there is no Studio to host it`);
  const hookUrl = webhookUrl(config, agent);
  const prefix = values.prefix ?? `${agent.toUpperCase().replace(/-/g, '_')}_`;
  const port = 4820;
  const state = randomBytes(16).toString('hex');
  const manifest = {
    name: values['app-name'] ?? `${config.name}-${agent}`,
    url: values.repo ? `https://github.com/${values.repo}` : new URL(hookUrl).origin,
    public: false,
    redirect_url: `http://127.0.0.1:${port}/callback`,
    hook_attributes: { url: hookUrl, active: true },
    default_permissions: { pull_requests: 'write', contents: 'read', issues: 'write', metadata: 'read' },
    default_events: ['pull_request', 'issue_comment', 'pull_request_review_comment'],
  };
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Create the GitHub App</button></form><script>document.forms[0].submit()</script>`);
        return;
      }
      const code = url.searchParams.get('code');
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !code) {
        res.writeHead(400).end();
        return;
      }
      const reply = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'lousho-deploy' },
      });
      const app = (await reply.json()) as { id: number; slug: string; pem: string; webhook_secret: string; message?: string };
      if (!reply.ok) {
        res.writeHead(502).end('GitHub refused the exchange');
        server.close();
        reject(new DeployError(`GitHub refused the exchange: ${app.message ?? reply.status}`));
        return;
      }
      const secrets = readSecrets(config.name);
      secrets.set(`${prefix}APP_ID`, String(app.id));
      secrets.set(`${prefix}APP_PRIVATE_KEY`, app.pem.replace(/\r?\n/g, '\\n'));
      secrets.set(`${prefix}WEBHOOK_SECRET`, app.webhook_secret);
      secrets.set(`${prefix}BOT_NAME`, app.slug);
      writeSecrets(config.name, secrets);
      config.githubApp = { agent, prefix };
      config.env = [...new Set([...(config.env ?? []), ...['APP_ID', 'APP_PRIVATE_KEY', 'WEBHOOK_SECRET', 'BOT_NAME'].map((k) => `${prefix}${k}`)])];
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
      const install = `https://github.com/apps/${app.slug}/installations/new`;
      res.writeHead(302, { location: install }).end();
      console.log(`Created ${app.slug}; credentials saved to ${secretsPath(config.name)}. Install it on your repository: ${install}`);
      console.log('Run `lousho deploy` again so the agent gets the new credentials.');
      server.close();
      resolve();
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Opening http://127.0.0.1:${port} to create the GitHub App...`);
      openBrowser(`http://127.0.0.1:${port}`);
    });
  });
}

export async function runDeploy(argv: string[]): Promise<number> {
  try {
    if (argv.includes('-h') || argv.includes('--help')) {
      console.log(HELP);
      return 0;
    }
    if (argv[0] === 'github-app') await githubApp(argv.slice(1));
    else await deploy(parseFlags(argv));
    return 0;
  } catch (error) {
    console.error(`lousho deploy: ${(error as Error).message}`);
    return error instanceof DeployError || (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 2 : 1;
  }
}

function latestStudioVersion(): string {
  const out = spawnSync('npm', ['view', 'lousho-studio', 'version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const version = out.status === 0 ? out.stdout.trim() : '';
  return /^\d+\.\d+\.\d+/.test(version) ? version : 'latest';
}
