# Family Secret Santa

A small site for the family name exchange: draw names, keep them secret, and share wishlists with links.

- **No getting yourself.** Optional toggle: no getting your spouse either.
- **No dead ends.** When the organizer starts the draw, everyone is matched at once, so the last person is never stuck with only their own name.
- **Private.** Each person sets a 4-digit PIN the first time they tap their name. Only they can see who they drew. The organizer can see who has drawn, but not who they got, so the organizer can play too.
- **Wishlists.** Everyone adds ideas, links and notes, and the whole family can see them.

Built with one HTML page and one Vercel serverless function (`api/ss.js`). There's no package.json and no dependencies. Data lives in Upstash Redis (free tier) and is reached through plain `fetch` to its REST API.

## Deploy (about 5 minutes)

1. **Import the repo in Vercel**: Add New → Project → `secretsanta`. Leave every build setting at its default and deploy.
2. **Add the database**: open the project's **Storage** tab, choose **Upstash → Redis** (free) and connect it to this project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. **Add two environment variables** (Settings → Environment Variables):
   - `FAMILY_CODE`: the word everyone types to get in, e.g. `burleson2026` (not case-sensitive)
   - `ADMIN_PIN`: your organizer password
4. **Redeploy** so the new variables take effect.

## Running it each year

1. Open the site, enter the family code, go to **Organizer** and unlock it with `ADMIN_PIN`.
2. Add everyone, pick spouses, set the spending limit and date, then **Save family**.
3. Tap **Start the draw** and text the link plus the family code to the family.
4. Each person taps their name, picks a PIN, draws, and adds to their wishlist.

Next year: tap **Reset the draw**, adjust the family, and start again. Wishlists and PINs carry over. Someone forgot their PIN? Use **Reset PIN** next to their name.

Optional: set `KEY_PREFIX` (e.g. `ss2027:`) to start a completely fresh year while keeping the old data in Redis.
