# Smart-down Artifacts

Smart-down artifacts are durable Markdown artifacts that can be edited in place, rendered, committed, diffed, and resumed later.

## Layout

Artifacts live under a partitioned directory, inspired by lakehouse/parquet-style partitions:

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
- Git history is the version log for rollback, comparison, and iteration.
- Partition folders make browsing cheap by date/hour.
- The `<kind>-<slug>` folder makes related ideas cluster lexically.
- The Meeting extension watches artifact files and renders the latest file automatically as it changes.
- The watcher commits artifact file changes using the host utterance as the commit message.
- `manifest.json` makes artifacts discoverable without parsing the Markdown body.
- `artifacts/index.json` is a generated search/index file and can be regenerated any time.

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

## Naming conventions

Kinds should be broad and stable:

- `diagram`
- `plan`
- `implementation`
- `status`
- `note`
- `spec`
- `decision`

Slugs should be concise, lowercase, dash-separated, and idea-oriented:

```txt
diagram-project-flow
plan-native-diagram-renderer
implementation-meeting-artifact-router
status-latency-investigation
decision-smart-down-layout
```

Create a new folder only for a new idea. Keep iterating in place for the same idea; use Git for versions.

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

Search artifacts:

```bash
node scripts/smart-artifact.mjs find latency
node scripts/smart-artifact.mjs find --kind diagram --tag meeting
```

Regenerate the index:

```bash
node scripts/smart-artifact.mjs index
```

Render an artifact in the Meeting canvas:

```bash
node scripts/smart-artifact.mjs url artifacts/dt=2026-05-06/hour=03/diagram-project-flow/artifact.smart.md
```
