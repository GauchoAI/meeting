# Realtime agent sleep mode

The Realtime conversation agent supports two activation modes:

- **Active**: normal behavior. If unmuted, server VAD can create audio responses; if muted, the agent stays in silent/background mode.
- **Sleeping until prompted**: the agent keeps the session connected but disables automatic responses. It does not override mute, auto-enable the microphone, or speak readiness phrases.

## Wake paths

- Use the UI control: **Sleep until prompted** / **Wake voice agent**.
- Send a text prompt in the prompt box; this wakes the agent explicitly.
- Voice activity can only act as a gate: prompt-like speech may wake the agent after debounce, but it does not immediately speak. Non-prompt room audio is ignored.

## Guardrails

- Sleeping mode sets Realtime turn detection `create_response=false` and `interrupt_response=false`.
- Muted/background semantics still win: muted agents do not speak.
- Wake detection is debounced to avoid active/sleeping flapping.
- Status messages should use concise Status/Confidence/Next text and must not steal canvas focus.
