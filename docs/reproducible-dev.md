# Reproducible Development Setup

This repo is intended to be runnable from a fresh clone with one canonical source tree.

## Fresh clone

```bash
pnpm install
cp .env.example .env
pnpm dev:local-live
```

Open:

```text
http://localhost:5175/stable.html
```

Click **Join meeting** once. The stable shell starts the Realtime voice agent
immediately and keeps it alive while the iframe hot reloads.

Local Voxtral and Moshi experiments are documented in `docs/local-voice-models.md`.
The full startup, stop, logs, and smoke-test runbook is `docs/running-the-program.md`.

## Pi extensions

Project-local Pi extensions live in:

```text
.pi/extensions/
```

Committed extensions:

- `.pi/extensions/meeting/index.ts` — connects this Pi session to the Meeting API and emits trace events.
- `.pi/extensions/browser/index.ts` — captures browser screenshots through Chrome DevTools.

After cloning, start Pi in this repo and run:

```text
/reload
```

The extensions are project-local, so Pi discovers them from the repository.

## Runtime state intentionally not committed

The following are ignored and recreated locally:

```text
.meeting/                 # persisted local meeting events
.pi/browser-profile/      # local Chrome DevTools profile
.pi/screenshots/          # screenshot outputs
node_modules/
models/
.env
```

## Development mode

Prefer running directly from the source checkout:

```bash
pnpm dev:local-live
```

For app-only development without local speech providers:

```bash
pnpm dev
```

Avoid editing `apps/web/public/stable.html` during a live meeting unless doing deliberate stable-shell maintenance. Normal UI iteration should happen in `apps/web/src/*`.

## Validation

```bash
pnpm typecheck
node scripts/browser-screenshot.mjs http://localhost:5175/stable.html .pi/screenshots/check.png
```

The screenshot command launches/reuses a Chrome DevTools instance and writes the image to `.pi/screenshots/`.
