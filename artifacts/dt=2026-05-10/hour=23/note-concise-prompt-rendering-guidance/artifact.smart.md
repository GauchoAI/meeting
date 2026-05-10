# Concise Prompt Rendering Guidance

## Opinion

Current pi-agent handoffs can read like raw routing metadata instead of a clear instruction. Terminal rendering should preserve intent, path, and constraints while removing boilerplate.

## Before — verbose handoff

```txt
Realtime agent handoff to pi-agent. Treat the JSONL below as the task handoff, not as a raw transcript dump.
Use the Meeting artifact tools to answer in the Meeting UI. If a durable artifact is requested, create/update it and show it.

taskClass: artifact.render
artifactIntent: decision=open_existing_artifact
currentArtifact=Terminal Message Rendering Guidance | slug=...
message: Create a durable artifact that evaluates how pi-agent questions/instructions are currently rendered...
```

## After — concise terminal prompt

```txt
Task: Create a durable artifact on concise prompt rendering.
Context: Current canvas is Terminal Message Rendering Guidance.
Constraints: Include before/after examples + reusable template; keep it short; open the artifact; avoid status wrappers stealing focus.
```

## Before — ambiguous user fragment

```txt
was just now trying to improve a little bit of the edges.
is able to have an easy time.
time informing an output.
to the voice agent and the UI.
```

## After — clarified prompt

```txt
Goal: Make assistant outputs easier for the voice agent and UI to consume.
Issue: Status/wrapper messages can obscure the real artifact output.
Next: Verify the selected artifact stays visible after status updates.
```

## Reusable template

```txt
Task: <one-line action>
Context: <current artifact/canvas + relevant state>
Constraints: <must/avoid items, max 2 lines>
Output: <artifact, status, code change, or answer>
```

## Rule of thumb

Render instructions for humans first, machines second: keep routing metadata out of the visible prompt unless it changes the required action.
