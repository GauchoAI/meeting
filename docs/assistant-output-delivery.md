# Assistant output delivery

Use `deliver_assistant_output` when an assistant result must appear consistently across the main canvas and Realtime/status surfaces.

## Default workflow

One tool call does the full delivery:

1. Publishes structured Markdown to the canvas with a stable `documentId`.
2. Selects the latest real canvas document only while the web UI is in Auto focus mode.
3. Emits a concise Realtime/status message without wrapping or replacing the canvas content.

## Canvas template

Use normal Markdown structure for durable visual content:

```md
# <Title>

## Opinion

<short assessment>

## Before

<example>

## After

<example>

## Template

<reusable pattern>
```

## Status template

Use exactly three compact terminal-friendly lines for status surfaces:

```txt
Status: <one-line current state>
Confidence: <level> — <short reason>
Next: <1–3 concrete actions>
```

## Example tool payload

```json
{
  "title": "Terminal Message Rendering Guidance",
  "documentId": "assistant-output:terminal-message-rendering-guidance",
  "markdown": "## Opinion\n\nCanvas content can use headings; terminal status should be compact.\n\n## Before\n\n...\n\n## After\n\n...",
  "status": "Terminal rendering guidance published on the canvas.",
  "confidence": "High — canvas and status were delivered by one command.",
  "next": "Review the selected canvas artifact, then apply the template to future status messages."
}
```

## Guardrails

- Do not post a separate status wrapper as the main content.
- Do not rely on status messages to carry durable artifact content.
- Do not let status-only delivery replace the selected canvas or artifact.
- Use stable `documentId` values so repeated calls update the same conceptual canvas document.
- Keep status text flat; reserve headings and bullets for canvas Markdown.
