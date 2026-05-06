# Smart-down Artifacts

Smart-down artifacts are durable Markdown artifacts that can be edited in place, rendered, committed, diffed, and resumed later.

## Layout

Artifacts live under a partitioned directory:

```txt
artifacts/
  dt=YYYY-MM-DD/
    hour=HH/
      <kind>-<slug>/
        artifact.smart.md
        manifest.json
```

Examples:

```txt
artifacts/dt=2026-05-06/hour=03/diagram-project-flow/artifact.smart.md
artifacts/dt=2026-05-06/hour=03/plan-native-diagram-renderer/artifact.smart.md
artifacts/dt=2026-05-06/hour=03/status-meeting-ui/artifact.smart.md
```

## Semantics

- One folder is one evolving idea.
- `artifact.smart.md` is edited in place.
- The Meeting extension watches artifact files and renders the latest file automatically as it changes.
- Git provides versioning, rollback, and diffs.
- The watcher commits artifact file changes using the host utterance as the commit message.
- `manifest.json` makes artifacts discoverable without parsing the Markdown body.

## Manifest

```json
{
  "kind": "diagram",
  "slug": "project-flow",
  "title": "Meeting project flow",
  "createdAt": "2026-05-06T03:00:00.000Z",
  "updatedAt": "2026-05-06T03:30:00.000Z",
  "artifact": "artifact.smart.md",
  "tags": ["meeting", "diagram", "workflow"],
  "summary": "ScaliDRAW-style overview of the Meeting project loop."
}
```

## Commands

Create or update an artifact:

```bash
node scripts/smart-artifact.mjs write \
  --kind diagram \
  --slug project-flow \
  --title "Meeting project flow" \
  --tags meeting,diagram,workflow \
  --summary "ScaliDRAW-style overview of the Meeting project loop" \
  --file /tmp/project-flow.smart.md
```

List artifacts:

```bash
node scripts/smart-artifact.mjs list
```

Render an artifact in the Meeting canvas:

```bash
node scripts/smart-artifact.mjs url artifacts/dt=2026-05-06/hour=03/diagram-project-flow/artifact.smart.md
```
