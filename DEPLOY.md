# Deploying Outrank Map

About ten minutes, most of it waiting.

## Why Render, not Vercel or Cloudflare

A study runs for 15+ minutes in the background, and every study, shortlist
and note is stored in a database file on disk. Vercel and Cloudflare run
short-lived functions: a study would be killed partway through, and the disk
is wiped between requests. Render runs an ordinary always-on server with a
disk attached, which is what this app is. (Same setup as EntityGraph.)

## One-time setup

1. **Create the service.** At [render.com](https://render.com) choose
   **New → Blueprint** and pick the `outrank-map` GitHub repository. Render
   reads `render.yaml` and fills in everything except the secrets.
2. **Paste the secrets** when Render asks:

   | Key | Value |
   |---|---|
   | `APP_PASSWORD` | the password you will sign in with — 12+ characters; a long passphrase is best |
   | `AHREFS_API_KEY` | same as your local `.env` |
   | `DATAFORSEO_LOGIN` | same as your local `.env` |
   | `DATAFORSEO_PASSWORD` | same as your local `.env` (the **API** password) |

3. **Wait for the deploy**, open the `…onrender.com` URL, sign in.

## How it is locked down

- Every API route except `/api/login` and `/api/health` returns 401 without a
  session. The server refuses to start on a public address without
  `APP_PASSWORD`.
- Sessions are random 256-bit tokens in an HttpOnly, Secure, SameSite cookie,
  valid 30 days; only their hashes are stored. **Sign out** ends one.
- 8 wrong passwords from one address locks it out for 15 minutes.
- State-changing requests must come from the app's own page, so another site
  open in your browser cannot start a study and spend credit.
- Pages send `noindex` and `no-referrer`, so the URL stays out of search
  engines and is not leaked to sites you click through to.

To change the password: edit `APP_PASSWORD` in the Render dashboard
(Environment) and save; Render restarts the app.

## After that

Every push to `main` redeploys in about a minute. Studies, shortlists and
notes live on the disk at `/var/data` and survive deploys.

## Costs

| | |
|---|---|
| Render Starter instance | ~$7/month |
| 1 GB disk | ~$0.25/month |
| Ahrefs / DataForSEO | per study, as shown on the New study form |

## Backup

Render dashboard → **Shell**:

```bash
node -e "new (require('node:sqlite').DatabaseSync)('/var/data/outrank-map.db').exec(\"VACUUM INTO '/var/data/backup.db'\")"
```

or download the CSV of any study from its page.
