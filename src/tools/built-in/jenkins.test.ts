import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJenkinsTools, type JenkinsTools } from './jenkins';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

const ctx = {} as ToolExecutionContext;

function run(tools: JenkinsTools, name: string, input: Record<string, unknown>) {
  const execute = getToolExecute(tools.get(name)!);
  return execute!(input, ctx) as Promise<string>;
}

describe('JenkinsTools', () => {
  let tools: JenkinsTools;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tools = createJenkinsTools({ baseUrl: 'https://ci.example.com/', username: 'bot', apiToken: 'tok' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the expected tools', () => {
    expect(tools.list().sort()).toEqual([
      'jenkins_download_artifact',
      'jenkins_get_build',
      'jenkins_get_build_log',
      'jenkins_list_artifacts',
      'jenkins_list_jobs',
      'jenkins_trigger_job',
    ]);
  });

  it('sends basic auth and maps nested job paths', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      number: 7,
      result: 'SUCCESS',
      building: false,
      duration: 1000,
      timestamp: 1,
      url: 'u',
      changeSets: [{ items: [{ commitId: 'abc', msg: 'fix', author: { fullName: 'Dev' } }] }],
    })));

    const result = JSON.parse(await run(tools, 'jenkins_get_build', { job: 'team/api', build: 7 }));

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://ci.example.com/job/team/job/api/7/api/json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('bot:tok').toString('base64')}`);
    expect(result).toMatchObject({ result: 'SUCCESS', changes: [{ commitId: 'abc', author: 'Dev', message: 'fix' }] });
  });

  it('triggers with parameters and a CSRF crumb, returning the queue url', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ crumbRequestField: 'Jenkins-Crumb', crumb: 'c1' })))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { Location: 'https://ci.example.com/queue/item/42/' } }));

    const result = JSON.parse(await run(tools, 'jenkins_trigger_job', { job: 'deploy', parameters: { ENV: 'staging' } }));

    expect(fetchSpy.mock.calls[0][0]).toBe('https://ci.example.com/crumbIssuer/api/json');
    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toBe('https://ci.example.com/job/deploy/buildWithParameters?ENV=staging');
    expect(init.method).toBe('POST');
    expect(init.headers['Jenkins-Crumb']).toBe('c1');
    expect(result.queueItemUrl).toBe('https://ci.example.com/queue/item/42/');
  });

  it('triggers a plain build without a crumb when the issuer is unavailable', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { Location: 'q' } }));

    await run(tools, 'jenkins_trigger_job', { job: 'deploy' });

    expect(fetchSpy.mock.calls[1][0]).toBe('https://ci.example.com/job/deploy/build');
  });

  it('tails the console log', async () => {
    const log = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    fetchSpy.mockResolvedValue(new Response(log));

    const result = JSON.parse(await run(tools, 'jenkins_get_build_log', { job: 'a/b', tailLines: 3 }));

    expect(fetchSpy.mock.calls[0][0]).toBe('https://ci.example.com/job/a/job/b/lastBuild/consoleText');
    expect(result).toEqual({ totalLines: 10, truncated: true, log: 'line 8\nline 9\nline 10' });
  });
});
