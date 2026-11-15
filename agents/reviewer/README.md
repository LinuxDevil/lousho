# lousho-reviewer

Reviews every pull request on `LinuxDevil/lousho` the way Wakeel does: one GitHub review per push with a verdict and `🔴/🟡/💭 Category: title` inline comments. It reads `CONTRIBUTING.md` and the PR template at review time.

It reviews PRs opened by owners, members and collaborators, re-reviews on every push, skips drafts until they are ready, and never pushes, merges or edits anything.

## Settings

| Variable | |
| --- | --- |
| `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY` | The `lousho-ai` GitHub App (private key PEM; `\n` escapes are accepted). |
| `REVIEWER_GITHUB_TOKEN` | Instead of an App: a bot account's fine-grained token. |
| `REVIEWER_WEBHOOK_SECRET` | The App's (or repository webhook's) secret. |
| `REVIEWER_BOT_NAME` | The App slug it posts as (`lousho-ai`); default `lousho-reviewer`. |
| `REVIEWER_REPO` | Default `LinuxDevil/lousho`. |
| `OPENROUTER_API_KEY` | The model key. The model is set in `agent.json`. |
| `LOUSHO_API_TOKEN` | Bearer for every server route except `/health` and the signed `/channels/github`. |

GitHub App permissions: Pull requests read and write, Contents read, Issues read, Metadata read. Subscribe to **Pull request** events. Webhook URL: `http://<host>:<port>/channels/github`.

## Deploy

```bash
npx lousho deploy --agent agents/reviewer --no-studio
npx lousho deploy github-app --agent reviewer --prefix REVIEWER_ --app-name lousho-ai --repo LinuxDevil/lousho
npx lousho deploy
```

The first deploy asks for the server and `OPENROUTER_API_KEY`. `github-app` creates the App with its webhook pointed at `https://reviewer.<domain>/channels/github` and saves its credentials; the second deploy hands them to the agent. With an existing App, pass `--env REVIEWER_APP_ID --env REVIEWER_APP_PRIVATE_KEY --env REVIEWER_WEBHOOK_SECRET --env REVIEWER_BOT_NAME` with those variables set instead.
