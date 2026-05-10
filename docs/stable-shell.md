# Stable Shell Development Contract

Open the meeting through:

```text
http://localhost:5175/stable.html
```

`stable.html` is the long-lived tier. It owns:

- microphone permission
- the OpenAI Realtime WebRTC peer connection
- the Realtime data channel and function-call loop
- room transcript persistence
- Realtime-to-pi-agent handoffs
- pi-agent result injection back into the voice agent
- audio output and mute/unmute state

The React app inside the iframe is the editable tier. It owns:

- layout
- transcript rendering
- Markdown/artifacts
- experiments
- command controls that talk to the stable shell through `postMessage`

During live development, do **not** edit or sync `apps/web/public/stable.html` into the running runtime. `scripts/sync-runtime.sh` intentionally excludes it so the browser tab holding the live microphone does not reload.

If the stable shell itself needs a change, treat it as a deliberate maintenance operation:

1. Announce that the connection shell will be updated.
2. Stop the live meeting or open a second shell.
3. Sync/restart intentionally.
4. Rejoin once.

Normal UI work should happen in `apps/web/src/*` and can reload the iframe without breaking the stable shell.
