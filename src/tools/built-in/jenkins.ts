import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

/** Connection settings for a Jenkins server (Basic auth with an API token). */
export interface JenkinsConfig {
  /** Jenkins server URL. */
  baseUrl: string;
  /** Jenkins username. */
  username: string;
  /** Jenkins API token. */
  apiToken: string;
}

interface JenkinsJobResource {
  name: string;
  url: string;
  color?: string;
  _class?: string;
}

interface JenkinsChangeSetItem {
  commitId?: string;
  msg?: string;
  author?: { fullName?: string };
}

interface JenkinsArtifactResource {
  fileName: string;
  relativePath: string;
}

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = /\.(txt|log|json|xml|html?|csv|ya?ml|md|properties|ini|conf|sh|js|ts|css|out)$/i;

/** Jenkins REST tools: jobs, builds, logs, artifacts and triggering. */
export class JenkinsTools extends ToolRegistry {
  private config: JenkinsConfig;
  private authHeader: string;

  constructor(config: JenkinsConfig) {
    super();
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
    this.authHeader = `Basic ${Buffer.from(`${config.username}:${config.apiToken}`).toString('base64')}`;
    this.registerAllTools();
  }

  public register(tool: DefinedTool): void;
  public register(name: string, descriptor: ToolDescriptor): void;
  public register(...args: [DefinedTool] | [string, ToolDescriptor]): void {
    routeFetchThroughSandbox(args.length === 1 ? args[0] : args[1]);
    if (args.length === 1) {
      super.register(args[0]);
      return;
    }
    super.register(args[0], args[1]);
  }

  private registerAllTools() {
    this.registerListJobs();
    this.registerGetBuild();
    this.registerGetBuildLog();
    this.registerListArtifacts();
    this.registerDownloadArtifact();
    this.registerTriggerJob();
  }

  private registerListJobs() {
    this.register(
      defineTool({
        name: 'jenkins_list_jobs',
        displayName: 'List Jenkins Jobs',
        description: 'List Jenkins jobs at the root or inside a folder, with their status color',
        input: z.object({
          folder: z.string().optional().describe('Folder path like "team/services"; omit for the root'),
        }),
        execute: async ({ folder }) => {
          const base = folder ? this.jobUrl(folder) : this.config.baseUrl;
          const response = await this.fetchJenkins(`${base}/api/json?tree=jobs[name,url,color]`);
          await assertOk(response, 'Failed to list Jenkins jobs');
          const data = (await response.json()) as { jobs?: JenkinsJobResource[] };
          const jobs = (data.jobs ?? []).map((job) => ({
            name: job.name,
            url: job.url,
            status: job.color ?? 'folder',
          }));
          return JSON.stringify({ jobs }, null, 2);
        },
      })
    );
  }

  private registerGetBuild() {
    this.register(
      defineTool({
        name: 'jenkins_get_build',
        displayName: 'Get Jenkins Build',
        description: 'Get a Jenkins build: result, building, duration, timestamp, url and change set summary',
        input: z.object({
          job: z.string().describe('Job path like "folder/job"'),
          build: z.union([z.number(), z.string()]).optional().default('lastBuild').describe('Build number or "lastBuild", "lastSuccessfulBuild", "lastFailedBuild"'),
        }),
        execute: async ({ job, build = 'lastBuild' }) => {
          const response = await this.fetchJenkins(`${this.jobUrl(job)}/${build}/api/json`);
          await assertOk(response, 'Failed to get Jenkins build');
          const data = await response.json();
          const sets: Array<{ items?: JenkinsChangeSetItem[] }> = data.changeSets ?? (data.changeSet ? [data.changeSet] : []);
          const changes = sets.flatMap((set) => set.items ?? []).map((item) => ({
            commitId: item.commitId,
            author: item.author?.fullName,
            message: item.msg,
          }));
          return JSON.stringify({
            number: data.number,
            result: data.result,
            building: data.building,
            duration: data.duration,
            timestamp: data.timestamp,
            url: data.url,
            changes,
          }, null, 2);
        },
      })
    );
  }

  private registerGetBuildLog() {
    this.register(
      defineTool({
        name: 'jenkins_get_build_log',
        displayName: 'Get Jenkins Build Log',
        description: 'Get the last N lines of a Jenkins build console log',
        input: z.object({
          job: z.string().describe('Job path like "folder/job"'),
          build: z.union([z.number(), z.string()]).optional().default('lastBuild').describe('Build number or "lastBuild"'),
          tailLines: z.number().int().positive().optional().default(200).describe('Number of trailing lines to return'),
        }),
        execute: async ({ job, build = 'lastBuild', tailLines = 200 }) => {
          const response = await this.fetchJenkins(`${this.jobUrl(job)}/${build}/consoleText`);
          await assertOk(response, 'Failed to get Jenkins build log');
          const lines = (await response.text()).split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          return JSON.stringify({
            totalLines: lines.length,
            truncated: lines.length > tailLines,
            log: lines.slice(-tailLines).join('\n'),
          }, null, 2);
        },
      })
    );
  }

  private registerListArtifacts() {
    this.register(
      defineTool({
        name: 'jenkins_list_artifacts',
        displayName: 'List Jenkins Artifacts',
        description: 'List the archived artifacts of a Jenkins build',
        input: z.object({
          job: z.string().describe('Job path like "folder/job"'),
          build: z.union([z.number(), z.string()]).optional().default('lastBuild').describe('Build number or "lastBuild"'),
        }),
        execute: async ({ job, build = 'lastBuild' }) => {
          const response = await this.fetchJenkins(`${this.jobUrl(job)}/${build}/api/json?tree=artifacts[fileName,relativePath]`);
          await assertOk(response, 'Failed to list Jenkins artifacts');
          const data = (await response.json()) as { artifacts?: JenkinsArtifactResource[] };
          const artifacts = (data.artifacts ?? []).map((a) => ({ fileName: a.fileName, relativePath: a.relativePath }));
          return JSON.stringify({ artifacts }, null, 2);
        },
      })
    );
  }

  private registerDownloadArtifact() {
    this.register(
      defineTool({
        name: 'jenkins_download_artifact',
        displayName: 'Download Jenkins Artifact',
        description: 'Download a Jenkins build artifact (up to 1MB); text files are returned as text, others as base64',
        input: z.object({
          job: z.string().describe('Job path like "folder/job"'),
          build: z.union([z.number(), z.string()]).optional().default('lastBuild').describe('Build number or "lastBuild"'),
          relativePath: z.string().describe('Artifact relativePath from jenkins_list_artifacts'),
        }),
        execute: async ({ job, build = 'lastBuild', relativePath }) => {
          const path = relativePath.split('/').map(encodeURIComponent).join('/');
          const response = await this.fetchJenkins(`${this.jobUrl(job)}/${build}/artifact/${path}`);
          await assertOk(response, 'Failed to download Jenkins artifact');
          const declared = Number(response.headers.get('content-length') ?? 0);
          if (declared > MAX_ARTIFACT_BYTES) {
            throw toolFailure(`Artifact is ${declared} bytes, over the ${MAX_ARTIFACT_BYTES} byte limit`);
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MAX_ARTIFACT_BYTES) {
            throw toolFailure(`Artifact is ${bytes.length} bytes, over the ${MAX_ARTIFACT_BYTES} byte limit`);
          }
          const contentType = response.headers.get('content-type') ?? '';
          const isText = /^text\/|json|xml|yaml|javascript/.test(contentType) || TEXT_EXTENSIONS.test(relativePath);
          return JSON.stringify({
            relativePath,
            size: bytes.length,
            contentType,
            encoding: isText ? 'utf8' : 'base64',
            content: bytes.toString(isText ? 'utf8' : 'base64'),
          }, null, 2);
        },
      })
    );
  }

  private registerTriggerJob() {
    this.register(
      defineTool({
        name: 'jenkins_trigger_job',
        displayName: 'Trigger Jenkins Job',
        description: 'Trigger a Jenkins job, optionally with build parameters; returns the queue item URL',
        input: z.object({
          job: z.string().describe('Job path like "folder/job"'),
          parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Build parameters'),
        }),
        execute: async ({ job, parameters }) => {
          const headers: Record<string, string> = { Authorization: this.authHeader };
          const crumbResponse = await this.fetchJenkins(`${this.config.baseUrl}/crumbIssuer/api/json`);
          if (crumbResponse.ok) {
            const crumb = (await crumbResponse.json()) as { crumbRequestField?: string; crumb?: string };
            if (crumb.crumbRequestField && crumb.crumb) headers[crumb.crumbRequestField] = crumb.crumb;
          }
          const hasParams = parameters && Object.keys(parameters).length > 0;
          const query = hasParams
            ? `?${new URLSearchParams(Object.entries(parameters).map(([k, v]) => [k, String(v)]))}`
            : '';
          const url = `${this.jobUrl(job)}/${hasParams ? 'buildWithParameters' : 'build'}${query}`;
          const response = await fetch(url, { method: 'POST', headers });
          await assertOk(response, 'Failed to trigger Jenkins job');
          return JSON.stringify({ success: true, job, queueItemUrl: response.headers.get('location') }, null, 2);
        },
      })
    );
  }

  private jobUrl(jobPath: string): string {
    const segments = jobPath.split('/').filter(Boolean);
    return `${this.config.baseUrl}${segments.map((s) => `/job/${encodeURIComponent(s)}`).join('')}`;
  }

  private fetchJenkins(url: string): Promise<Response> {
    return fetch(url, { headers: { Authorization: this.authHeader, Accept: 'application/json' } });
  }
}

/** Create the Jenkins tool registry for the given server config. */
export function createJenkinsTools(config: JenkinsConfig): JenkinsTools {
  return new JenkinsTools(config);
}
