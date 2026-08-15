# Frontend — build & deploy to Netlify

Self-contained Vite + React app (chat + Web Push). Everything here is what you
need to build the site. All values in `.env` are PUBLIC (safe to ship).

## Option A — fastest: deploy the prebuilt `dist/` (already built for you)
1. Netlify → Sites → "Add new site" → **Deploy manually**.
2. Drag the **`dist`** folder into the upload box.
Done. (No build needed — `dist/` already contains the app + service worker +
manifest + icons, with your Supabase + VAPID public keys baked in.)

## Option B — build it yourself, then deploy `dist/`
```bash
cd frontend
yarn install        # or: npm install
yarn build          # or: npm run build  -> outputs the dist/ folder
```
Then drag the newly generated **`dist`** folder into Netlify (manual deploy),
or point a Git-based Netlify site at this folder with:
- Build command: `yarn build`
- Publish directory: `dist`
- Environment variables (Site settings → Environment): copy the 3 keys from `.env`.

## What's inside
- `src/` — app code (chat UI, lockscreen, push client in `src/lib/push.ts`,
  the 🔔 button in `src/components/notification-bell.tsx`).
- `public/` — `sw.js` (service worker), `manifest.webmanifest`, `icons/`.
- `netlify.toml` — SPA redirect + no-cache header for `/sw.js`.
- `.env` — the 3 public build vars (Supabase URL, anon key, VAPID public key).

## After deploying — enable on iPhone (iOS 16.4+)
Safari → open the site → Share → **Add to Home Screen** → open that icon →
unlock chat → set "sending as" to your side → tap **🔔 → Allow**.

> The push SERVER side (the `push_subscriptions`/`push_log` tables + the
> `send-push-notification` Edge Function + the DB trigger) lives in Supabase and
> is already set up separately — it is NOT part of this frontend bundle.
