# Push Notifications — Setup & Deploy Guide

Real Web Push (VAPID) for the existing Supabase chat, working as an **iOS PWA**.
Flow: `chat_messages INSERT` → sender's browser calls Edge Function → Web Push →
recipient's iPhone (even when the site is closed) → tap opens the chat.

---

## 1) Environment variables

### FRONTEND (Netlify → Site settings → Environment variables) — these are PUBLIC
```
VITE_SUPABASE_URL=https://suwdzoycyeihbkhmpxay.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
VITE_VAPID_PUBLIC_KEY=BI9ZGkpX0ouN3NT_T6R47llE_c7wpyX3-OvxwjoMlkG65k0DV2eqZMYUmaF_OO9M5sv-JxQSoOsZ9ROCC9MELME
```
`VITE_VAPID_PUBLIC_KEY` is already set in this repo's `.env` for the preview.

### SUPABASE EDGE FUNCTION SECRETS (never exposed to the browser)
```
VAPID_SUBJECT=mailto:you@yourdomain.com
VAPID_PUBLIC_KEY=BI9ZGkpX0ouN3NT_T6R47llE_c7wpyX3-OvxwjoMlkG65k0DV2eqZMYUmaF_OO9M5sv-JxQSoOsZ9ROCC9MELME
VAPID_KEYS_JSON=<the private JWK JSON — copy it from the chat message>
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions
automatically by Supabase; you normally do NOT need to set them.

> Keep `VAPID_KEYS_JSON` SECRET. Do not put it in Netlify or any `VITE_` var.

---

## 2) Create the database table (run ONCE)
Open Supabase → SQL Editor → paste the contents of
`supabase/migrations/20260101000000_push_subscriptions.sql` → Run.

Creates `public.push_subscriptions` with write-only RLS (anon can register/delete
its own endpoint but cannot read anyone's subscriptions; only the service-role
Edge Function reads them).

---

## 3) Deploy the Edge Function
Requires the Supabase CLI (`npm i -g supabase` or `npx supabase`).

```bash
npx supabase login
npx supabase link --project-ref suwdzoycyeihbkhmpxay

# set secrets (paste the private JWK for VAPID_KEYS_JSON)
npx supabase secrets set \
  VAPID_SUBJECT="mailto:you@yourdomain.com" \
  VAPID_PUBLIC_KEY="BI9ZGkpX0ouN3NT_T6R47llE_c7wpyX3-OvxwjoMlkG65k0DV2eqZMYUmaF_OO9M5sv-JxQSoOsZ9ROCC9MELME" \
  VAPID_KEYS_JSON='<PASTE_THE_PRIVATE_JWK_JSON_FROM_CHAT>'

# deploy (public function — the app has no user JWT; body is validated in-function)
npx supabase functions deploy send-push-notification --no-verify-jwt
```

The repo already contains:
- `supabase/functions/send-push-notification/index.ts`
- `supabase/functions/send-push-notification/deno.json`
- `supabase/config.toml` (sets `verify_jwt = false` for this function)

---

## 4) Deploy the frontend (Netlify)
Set the three FRONTEND env vars above, then trigger a redeploy so the new
`index.html`, `/sw.js`, `/manifest.webmanifest`, and `/icons/*` ship.

---

## 5) Enable on your iPhone (iOS 16.4+)
1. Open the site in **Safari**.
2. **Share → Add to Home Screen** → Add.
3. Open the app from the **Home Screen icon** (NOT the Safari tab — iOS only
   allows Web Push from the installed PWA).
4. Unlock the chat, tap the **🔔** button in the header → **Allow**.
5. You should see "Notifications on 🔔".

---

## 6) Test end-to-end
- Phone A (persona A): Add to Home Screen, open, enable 🔔.
- Phone B (persona B): send a message.
- Phone A gets: **Title = other person's name 💗**, **Body = the message**.
- Tap it → the chat opens (enter passcode if prompted).
- Sender never notifies themselves.
- Quick server smoke test (replace ANON key):
```bash
curl -i -X POST "https://suwdzoycyeihbkhmpxay.supabase.co/functions/v1/send-push-notification" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  --data '{"recipient":"habiba","sender":"faizan","text":"Push smoke test","type":"text","url":"/"}'
```

---

## 7) Reliable Delivery — server-side webhook (IMPLEMENTED)
Pushes now also fire **server-side** on every message insert, so they work even
if the sender closes the app the instant after sending. Both triggers run
(instant client path + reliable server path) and an idempotency ledger
(`push_log`) guarantees **exactly one** notification per message.

Two things to do (once):
1. **Run the SQL** in `supabase/migrations/20260102000000_push_delivery_webhook.sql`
   in the Supabase SQL editor. It enables `pg_net`, creates `push_log`, and adds
   an AFTER INSERT trigger on `chat_messages` that POSTs the new row to the
   Edge Function. (The trigger is wrapped in an exception guard, so a push
   problem can never block a chat message from saving.)
2. **Re-deploy the Edge Function** (it gained the idempotency claim):
   `npx supabase functions deploy send-push-notification --no-verify-jwt`

No new secrets are required.

### Dashboard alternative (instead of the SQL trigger)
Supabase → Database → Webhooks → Create → table `chat_messages`, event `INSERT`,
type `Supabase Edge Function` → `send-push-notification`. The function already
accepts the webhook `{ record }` shape and derives the recipient from
`record.sender`. If you use this route you can skip creating the trigger in the
SQL file, but still run the `push_log` part of that migration for idempotency.

### Verify it
Insert a message from one persona while the OTHER persona's device is fully
closed → the closed device still gets the push. Check delivery status in
Supabase → Database → `net._http_response` (pg_net logs) and the Edge Function
logs (Functions → send-push-notification → Logs; look for `duplicate:true` when
both paths race — that's the idempotency guard working).


---

## Limitations
- iOS **requires** Add-to-Home-Screen; Web Push does not work in a plain Safari tab.
- No real auth → `persona`/`session_id` are not cryptographic identities. The
  table is write-only from the browser to limit exposure, but a determined
  anon user could still tamper. Acceptable for a private 2-person app; add
  Supabase Auth if you want true per-user ownership.
- iOS shows a notification for every push even if the chat is open (Apple
  requires a visible notification per push), so there may be a banner while
  you're already viewing.
