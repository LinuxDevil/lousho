import { githubChannel } from 'lousho';

const REVIEWABLE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const appId = process.env.REVIEWER_APP_ID;
const privateKey = process.env.REVIEWER_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

export default githubChannel({
  webhookSecret: process.env.REVIEWER_WEBHOOK_SECRET ?? '',
  ...(appId && privateKey ? { app: { appId, privateKey } } : { token: process.env.REVIEWER_GITHUB_TOKEN ?? '' }),
  botName: process.env.REVIEWER_BOT_NAME ?? 'lousho-reviewer',
  pullRequestEvents: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
  replyToPullRequest: false,
  triggers: ({ association }) => REVIEWABLE.has(association),
});
