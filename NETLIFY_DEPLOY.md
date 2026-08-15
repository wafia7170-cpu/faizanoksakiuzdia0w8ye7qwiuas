# Deploying to Netlify

This app is a pure Vite + React SPA. Everything server-side (chat, realtime,
storage, game leaderboard) runs on Supabase, so the only thing Netlify hosts
is the static build.

## One-time setup

1. **Push the repo to GitHub** (Netlify pulls from Git).
2. In Netlify → **Add new site → Import from Git** → pick your repo.
3. Set the **base directory** to `frontend` (this folder). The build & publish
   settings are already declared in `netlify.toml`:
   - Build command: `yarn install --frozen-lockfile && yarn build`
   - Publish directory: `dist`
   - Node version: `22`
4. Add the two required environment variables in
   **Site settings → Build & deploy → Environment**:

   | Key | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | `https://suwdzoycyeihbkhmpxay.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | *(your Supabase anon key)* |

   > **Do not commit the anon key** to Git. Add it only in the Netlify UI.

5. Click **Deploy site**. First build takes ~1–2 minutes.

## Verifying the deploy

- The lock screen should load at `https://<your-site>.netlify.app`.
- Enter the passcode and check that chat messages load — that confirms the
  Supabase env vars were picked up.
- If chat is empty, open DevTools console: a `[supabase] Missing
  VITE_SUPABASE_URL…` warning means the env vars weren't set in Netlify.

## Files already included for you

- `netlify.toml` – build command, Node version, headers, SPA redirect.
- `public/_redirects` – SPA history-mode fallback (backup for the redirect in
  `netlify.toml`).
- Long-lived cache headers for `/assets`, `/games`, `/songs`, `/media` so
  repeat visits are instant.

## Local production preview

Before pushing to Netlify you can build & preview locally with:

```bash
cd frontend
yarn build
yarn preview
```

Then open the URL Vite prints (usually http://localhost:4173).
