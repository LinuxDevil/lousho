import { createGitHubTools } from 'lousho/integrations';

const [owner, repo] = (process.env.REVIEWER_REPO ?? 'LinuxDevil/lousho').split('/');
const appId = process.env.REVIEWER_APP_ID;
const privateKey = process.env.REVIEWER_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

const github = createGitHubTools(
  appId && privateKey ? { owner, repo, app: { appId, privateKey } } : { owner, repo, token: process.env.REVIEWER_GITHUB_TOKEN ?? '' }
);

export default [
  'github_get_pull_request',
  'github_get_pr_files',
  'github_get_pr_comments',
  'github_get_file',
  'github_list_commits',
  'github_compare_commits',
  'github_submit_review',
].map((name) => github.get(name));
