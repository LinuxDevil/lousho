import { describe, it, expect } from 'vitest';
import { assertValidConfig, envLine, npmSource, renderCaddyfile, renderCompose, sslipDomain, studioDockerfile, type DeployConfig } from './stack';

const base: DeployConfig = {
  name: 'lousho',
  host: '203.0.113.7',
  domain: sslipDomain('203.0.113.7'),
  studio: { user: 'admin' },
  agents: [{ name: 'reviewer', dir: 'agents/reviewer' }],
};

describe('deploy stack', () => {
  it('puts Studio behind basic auth with Caddy and keeps secrets out of the compose file', () => {
    const compose = renderCompose({ ...base, proxy: 'caddy' });
    const caddy = renderCaddyfile(base);
    expect(base.domain).toBe('203-0-113-7.sslip.io');
    expect(caddy).toContain('studio.203-0-113-7.sslip.io {\n  handle /hooks/* {\n    reverse_proxy studio:4750\n  }\n  handle {\n    basic_auth {');
    expect(caddy).toContain('reviewer.203-0-113-7.sslip.io {\n  reverse_proxy reviewer:3000');
    expect(compose).toContain('ports: ["80:80", "443:443"]');
    expect(compose).not.toMatch(/API_KEY|STUDIO_HASH|TOKEN/);
    expect(compose).not.toMatch(/studio:[\s\S]*ports:/);
  });

  it('uses Traefik labels and its network when Traefik already owns 443', () => {
    const compose = renderCompose({ ...base, proxy: 'traefik', traefikNetwork: 'web' });
    expect(compose).not.toContain('caddy');
    expect(compose).toContain('traefik.http.routers.lousho-studio.middlewares: lousho-studio-auth');
    expect(compose).toContain('basicauth.users: ${STUDIO_BASIC_AUTH}');
    expect(compose).toContain('lousho-studio-hooks.rule: Host(`studio.203-0-113-7.sslip.io`) && PathPrefix(`/hooks/`)');
    expect(compose).not.toContain('lousho-studio-hooks.middlewares');
    expect(compose).not.toContain('lousho-reviewer.middlewares');
    expect(compose).toContain('networks:\n  proxy:\n    external: true\n    name: web');
  });

  it('pins the Studio version so a new Studio release busts the cached install layer', () => {
    expect(studioDockerfile(npmSource('0.1.0-alpha.8'))).toContain(' lousho-studio@0.1.0-alpha.8 ');
  });

  it('refuses unsafe names and values', () => {
    expect(() => assertValidConfig({ ...base, agents: [{ name: 'studio', dir: 'x' }] })).toThrow(/reserved/);
    expect(() => assertValidConfig({ ...base, name: 'Bad Name' })).toThrow();
    expect(() => assertValidConfig({ ...base, env: ['lower'] })).toThrow(/UPPER_CASE/);
    expect(() => envLine('KEY', "it's")).toThrow();
    expect(envLine('HASH', '$2a$14$x')).toBe("HASH='$2a$14$x'");
    expect(studioDockerfile({ kind: 'npm', sdk: '1.0.0', studio: 'latest' })).toContain('USER node');
    expect(studioDockerfile({ kind: 'local' })).toContain('RUN ln -s /opt/lousho/node_modules /node_modules');
    for (const dockerfile of [studioDockerfile({ kind: 'npm', sdk: '1.0.0', studio: 'latest' }), studioDockerfile({ kind: 'local' })]) {
      expect(dockerfile).toContain('isolated-vm@^6');
      expect(dockerfile).toContain('ENV NODE_OPTIONS=--no-node-snapshot');
    }
  });
});
