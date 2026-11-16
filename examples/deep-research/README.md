# deep-research

The "deep research" archetype Anthropic's multi-agent research system uses: one lead coordinator decomposes a question into subtopics, fans them out to researcher sub-agents called in parallel, then synthesizes their compressed, cited summaries into a report.

| Piece | Lousho feature |
|---|---|
| Lead coordinator | `createAgent({ instructions, subagents })` |
| Parallel researcher fan-out | several `task` calls in one model turn (`toolConcurrency` defaults to `'unbounded'`) |
| Researcher sub-agents in clean contexts | `subagents: { researcher }` - each task sees only its prompt |
| Offline retrieval | a `defineTool()` `search` tool over a small in-memory corpus |
| Citations | `[S#]` markers the researchers return and the lead carries into the report and its Sources list |

## Run it

```bash
npx tsx examples/deep-research/index.ts                    # offline, scripted models
npx tsx examples/deep-research/index.ts "your question"    # offline: the scripted models answer the built-in question whatever you ask; set a key to research yours
OPENROUTER_API_KEY=... npx tsx examples/deep-research/index.ts  # live, openrouter/openai/gpt-4o-mini
```

Offline, both the lead and the researchers run on scripted `mockModel`s: the researchers' `search` calls still execute for real against the corpus, so the run needs no network and no API key.
