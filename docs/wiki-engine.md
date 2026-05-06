# Wiki Engine Plan

The wiki engine is the local-first memory layer for meeting agents. It is designed around deterministic graph traversal first, with optional LLM judgment only at the parent-selection step.

## Implementation Stages

1. Watch files and enqueue durable work items.
2. Extract a compact source record: title, summary, keywords, entities, path hints, checksum.
3. Search existing wiki pages for candidate parents.
4. Ask the optional local LLM router to choose from the numbered candidate menu.
5. Write the child page with frontmatter and a readable body.
6. Backtrack into the parent page and add the child as a numbered reference.
7. Search and traverse pages through compact numbered references.

## Workspace Layout

```txt
raw/              original documents
wiki/             generated wiki pages
.wiki-state/      persistent queue and future traversal sessions
```

## Page Contract

Each wiki page has frontmatter with:

```txt
id
title
kind
parent
children
keywords
references
confidence
createdAt
updatedAt
```

The body keeps numbered references short, so an agent can traverse by asking for `[1]`, `[2]`, or `[0]` for parent.

## Current Implementation Review (Captured)

- **What is working well**
  - Event-driven queue flow is in place: watcher/file event → queue item → processor.
  - Source extraction + candidate ranking + optional LLM arbitration step are implemented.
  - Parent/backlink creation supports deterministic graph traversal with compact references.
  - Search and routing can operate without strict vector dependency (attention-based and keyword routing are present).
  - End-to-end scenario and typecheck/build checks pass on the current branch.

- **Risks to address before production rollout**
  - **Parent candidate hygiene:** currently wiki source pages may be selected as parents; restrict default parent selection to `pattern/folder/root`-style canonical pages unless explicit policy allows source pages.
  - **Queue concurrency safety:** queue update/read can race under parallel processing; add a lock/lease or single-consumer guarantee for `process`/`watch` pipelines.
  - **Retry behavior:** failed items currently retry repeatedly without backoff/cap; add attempt limits, delayed retry policy, and dead-letter/error records.
  - **Parent body updates:** backtracking updates should avoid overriding/manual-content loss by using an explicit machine-managed section (for example `## Menu (auto)`) and preserving user-authored context.

These are the top practical fixes if we want the system “ready to try” reliably in repeated usage.
## CLI

```sh
pnpm --filter @meeting/wiki-engine scenario
pnpm --filter @meeting/wiki-engine scenario -- --llm pi
pnpm --filter @meeting/wiki-engine init -- --root /tmp/wiki
pnpm --filter @meeting/wiki-engine add -- --root /tmp/wiki --file /tmp/wiki/raw/note.md
pnpm --filter @meeting/wiki-engine process -- --root /tmp/wiki
pnpm --filter @meeting/wiki-engine search -- --root /tmp/wiki --query "meeting agent tools"
pnpm --filter @meeting/wiki-engine watch -- --root /tmp/wiki
```

The scenario command always uses a temporary directory unless `--root` is provided, so it does not dirty the real repository wiki.
