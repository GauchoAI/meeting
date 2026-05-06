# Reproducible Development Setup

This repo is intended to be runnable from a fresh clone with one canonical source tree.

## Fresh clone

```bash
pnpm install
cp .env.example .env
bash scripts/setup-whisper.cpp.sh   # if the Whisper model/binary are not already installed
pnpm dev
```

Open:

```text
http://localhost:5173/stable.html
```

Click **Join meeting** once, then hold **Space** to speak.

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
pnpm dev
```

or in the background:

```bash
bash scripts/dev-source.sh
```

Avoid editing `apps/web/public/stable.html` during a live meeting unless doing deliberate stable-shell maintenance. Normal UI iteration should happen in `apps/web/src/*`.

## Validation

```bash
pnpm typecheck
node scripts/browser-screenshot.mjs http://localhost:5173/stable.html .pi/screenshots/check.png
```

The screenshot command launches/reuses a Chrome DevTools instance and writes the image to `.pi/screenshots/`.
