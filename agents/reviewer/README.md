# lousho-reviewer

Reviews every pull request on `LinuxDevil/lousho`: one GitHub review per push with a verdict and `🔴/🟡/💭 Category: title` inline comments. It runs inside Lousho Studio as the agent `lousho-reviewer`, from [`lousho-reviewer.yaml`](./lousho-reviewer.yaml).

It reviews pull requests opened or pushed by owners, members and collaborators (`pullRequests: true` on its GitHub channel). Its permissions deny every GitHub tool that creates, updates, deletes, merges, closes or comments, so the only thing it can post is its review.

## Settings

The spec reads these from Studio's environment (the deploy's `.env`):

| Variable | |
| --- | --- |
| `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY` | The `lousho-ai` GitHub App (private key PEM; `\n` escapes are accepted). |
| `REVIEWER_WEBHOOK_SECRET` | The App's webhook secret. |
| `REVIEWER_BOT_NAME` | The App slug (`lousho-ai`). |
| `OPENROUTER_API_KEY` | The model key. |

GitHub App permissions: Pull requests read and write, Contents read, Issues read, Metadata read. Subscribe to **Pull request** events. Webhook URL: `https://studio.<domain>/hooks/lousho-reviewer/channel/github`.

## Set it up

1. Deploy Studio with the App's variables: `npx lousho deploy --env REVIEWER_APP_ID --env REVIEWER_APP_PRIVATE_KEY --env REVIEWER_WEBHOOK_SECRET --env REVIEWER_BOT_NAME` (or create the App with `npx lousho deploy github-app --agent lousho-reviewer --prefix REVIEWER_`).
2. In Studio, **New agent → Import from file…** and pick `lousho-reviewer.yaml`, then turn the agent on.
3. Each `lousho deploy` points the App's webhook at Studio again.
