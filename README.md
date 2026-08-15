# Our Chat 💌

A private, passcode-protected two-person chat — a personal gift. Built as a
pure **Vite + React + TypeScript** single-page app with **Supabase** as the
entire backend (Postgres + Realtime + Storage). There is no custom server to
run or deploy — the static build talks to Supabase directly.

## Features

- 🔒 Passcode lockscreen (client-side, 10-attempt lockout per device)
- 💬 Realtime chat that syncs instantly across both devices
- 🖼️ Photo, 🎥 video and 🎙️ voice messages (uploaded to Supabase Storage)
- ↩️ Reply, ✏️ edit, 🗑️ unsend, and emoji reactions
- ⌨️ Live typing indicator
- 🌙 Chat-only dark mode
- ⚡ Fast load: history is prefetched during the lockscreen, messages render in
  a window (recent first) with infinite scroll for older ones and a
  "jump to newest" button

## Tech stack

| Layer     | Choice                                   |
| --------- | ---------------------------------------- |
| Framework | React 19 + TypeScript                    |
| Build     | Vite 7 + `@vitejs/plugin-react-swc`      |
| Styling   | Tailwind CSS 4                           |
| Animation | `motion`                                 |
| Backend   | Supabase (Postgres, Realtime, Storage)   |

## Local development

```bash
yarn install
# Create .env with your Supabase project details (see below), then:
yarn dev        # http://localhost:3000
```

### Environment variables (`.env`)

```bash
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

> The anon key is safe to expose in the browser — Row-Level Security policies
> on the database protect the data. Never commit `.env` (it is git-ignored).

## Database setup

Run [`supabase.sql`](./supabase.sql) once in the Supabase SQL editor to create
the `chat_messages` table, enable Realtime, and set the RLS policies. Create a
public Storage bucket named `chat-media` for photo/video/voice uploads.

## Deploy to Netlify

See [`NETLIFY_DEPLOY.md`](./NETLIFY_DEPLOY.md). In short: import the repo, set
the base directory to this folder, add the two `VITE_SUPABASE_*` env vars, and
deploy — `netlify.toml` handles the build command, Node version, SPA redirect
and asset caching.

## Scripts

| Command        | Description                          |
| -------------- | ------------------------------------ |
| `yarn dev`     | Start the dev server on port 3000    |
| `yarn build`   | Production build to `dist/`          |
| `yarn preview` | Preview the production build locally |
| `yarn lint`    | Run ESLint                           |
