# GitHub Pages web client

The Meeting web client can be deployed as a static GitHub Pages site.

Expected URL for this repository:

```text
https://gauchoai.github.io/meeting/stable.html
```

## Important limitation

GitHub Pages only hosts the browser client. It does **not** run:

- Meeting API
- local STT
- local TTS
- Pi/Codex agent worker
- local model services

So a Pages session still needs a reachable Meeting API endpoint.

## Local LAN mode

If all machines are on the same Wi-Fi/LAN, it is usually easier to open the local web server directly:

```text
http://<host-lan-ip>:5175/stable.html
```

Example:

```text
http://192.168.0.48:5175/stable.html
```

## Public lobby

The root Pages app shows an online meeting lobby when Firebase is configured. Hosts can advertise the current meeting by opening the Pages app or stable shell with `advertise=1` and an HTTPS API URL.

Example host advertisement URL:

```text
https://gauchoai.github.io/meeting/?advertise=1&api=https%3A%2F%2Fyour-api-tunnel.example&meeting=core&title=Core%20Meeting&hostName=Miguel
```

A local host can also advertise from the command line while the backend is running:

```bash
./scripts/advertise-meeting.mjs \
  --meeting core \
  --title "Core Meeting" \
  --host Miguel \
  --api "http://<host-lan-ip>:4317"
```

Guests can open the normal Pages URL and click the online meeting:

```text
https://gauchoai.github.io/meeting/
```

The lobby uses Firebase Realtime Database REST/SSE directly, without auth. By default it writes only under this namespace, not at the database root:

```text
https://signaling-dcfad-default-rtdb.europe-west1.firebasedatabase.app/gauchoai-meeting/publicMeetings
```

Optional build-time overrides:

```text
VITE_FIREBASE_DATABASE_URL=https://signaling-dcfad-default-rtdb.europe-west1.firebasedatabase.app
VITE_FIREBASE_NAMESPACE=gauchoai-meeting
```

## Pages + hosted/tunneled API mode

Because GitHub Pages is HTTPS, browsers will generally block calls from the Pages site to a plain `http://` local API as mixed content. For Pages, expose the API through HTTPS, for example with a tunnel such as Cloudflare Tunnel or ngrok.

Then open directly:

```text
https://gauchoai.github.io/meeting/stable.html?api=https%3A%2F%2Fyour-api-tunnel.example
```

Or advertise it in the public lobby:

```text
https://gauchoai.github.io/meeting/?advertise=1&api=https%3A%2F%2Fyour-api-tunnel.example&meeting=core&title=Core%20Meeting
```

The `api` query parameter is saved into `localStorage` as `meeting.api`, so future reloads use the same API until changed.

You can also set it manually in the browser console:

```js
localStorage.setItem("meeting.api", "https://your-api-tunnel.example")
```

## Deployment

A ready-to-copy workflow template is committed at:

```text
docs/github-pages-workflow.yml
```

Copy it to the actual GitHub Actions workflow path:

```bash
mkdir -p .github/workflows
cp docs/github-pages-workflow.yml .github/workflows/pages.yml
```

Note: creating or updating `.github/workflows/pages.yml` requires a GitHub token with the `workflow` scope. The local `gh` login currently has `repo` but not `workflow`, so normal code pushes work but workflow-file pushes are rejected by GitHub. Refresh auth with `gh auth refresh -s workflow`, or create the file in the GitHub web UI.

The workflow builds `apps/web` with:

```text
VITE_BASE_PATH=/meeting/
```

and deploys `apps/web/dist` to GitHub Pages on every push to `main`.

In GitHub, ensure Pages is configured to use **GitHub Actions** as its source:

```text
Repository Settings → Pages → Build and deployment → Source: GitHub Actions
```

## Static path behavior

The web app supports GitHub Pages subpath hosting by using Vite base path `/meeting/` in CI. The stable shell embeds the React app with a relative URL, so this works both locally and under `/meeting/` on Pages.
