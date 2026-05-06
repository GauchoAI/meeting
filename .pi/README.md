# Pi Project Configuration

This repo includes project-local Pi extensions:

- `extensions/meeting-router.ts`
- `extensions/meeting/index.ts`

The router applies a provider/model per task class. The default route table lives in:

```text
.pi/meeting-routes.json
```

Run Pi from the repo root:

```bash
pi
```

Disable the router for a session:

```bash
pi --meeting-router=false
```

Inspect or set the next route:

```bash
/meeting-routes
/meeting-route artifact.render
/meeting-route code.change
/meeting-route critique.review
```

Current defaults:

```text
artifact.render  -> openai-codex/gpt-5.3-codex-spark:low
artifact.edit    -> openai-codex/gpt-5.3-codex-spark:low
conversation     -> openai-codex/gpt-5.5:medium
code.change      -> openai-codex/gpt-5.5:high
research.explore -> openai-codex/gpt-5.5:high
critique.review  -> openai-codex/gpt-5.5:high
```

To add Cerebras, local, OpenRouter, or another provider, add a matching provider/model entry to `.pi/meeting-routes.json`. Pi resolves it through the same model registry used by `/model` and `--list-models`.

Claude/Sonnet can be used by changing a route target to `anthropic/claude-sonnet-4-5`, provided Pi has a valid Anthropic API key or OAuth credential. The installed Claude Code CLI is separate from Pi's provider registry.
