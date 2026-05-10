# Exact Verbatim Input View and Comparison

## Exact input received

```txt
Task: Exact verbatim input view and comparison
Context: Source document is /Users/miguel_lemos/Desktop/mamba3/meeting/artifacts/dt=2026-05-10/hour=23/note-verbatim-message-rendering-before-after/artifact.smart.md; task class is artifact.render.
Constraints: Provide exact verbatim input as received, not a paraphrase. List differences between received input and artifact display. Avoid wrapper/status-only output that could steal focus. Preserve actionable content; omit raw JSONL/routing metadata unless it changes the action. Keep the response concise and ensure status-only messages do not steal canvas focus.
Output: Selectable Meeting artifact, opened on the canvas.
```

## Current source artifact display

```txt
Title: Verbatim Message Rendering: Current vs Preferred
Sections: Example 1 current handoff rendering; Example 1 preferred rendering; Example 2 current troubleshooting fragments; Example 2 preferred rendering; Minimal template; Rule.
Template shown: Task / Context / Constraints / Output.
```

## Differences

- The received input is itself already in the preferred `Task / Context / Constraints / Output` format.
- The source artifact displays examples of old-vs-preferred rendering; it does not display this exact received input.
- The received input asks for a comparison artifact; the source artifact is general guidance and examples.
- The received input requires exact verbatim reproduction; the source artifact includes verbatim samples from earlier messages, not this one.
- Both preserve the same rule: avoid wrapper/status-only output stealing canvas focus.

## Minimal reusable template

```txt
Task: <exact requested action>
Context: <source artifact/document and task class>
Constraints: <verbatim must/avoid requirements>
Output: <visible artifact/answer target>
```
