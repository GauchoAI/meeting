# Pi Project Configuration

This repo includes a project-local Pi extension:

- `extensions/meeting-router.ts`

It routes Pi sessions in this repository to:

```text
openai-codex/gpt-5.3-codex-spark
thinking: low
```

Run Pi from the repo root:

```bash
pi
```

Disable the router for a session:

```bash
pi --meeting-router=false
```
