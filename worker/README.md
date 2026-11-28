# JimLogs push server

A tiny Cloudflare Worker that sends the "rest is over" notification to the JimLogs app (Web Push), so it shows on the lock screen and buzzes the Apple Watch.

**What it stores:** a hash of your random key, your phone's push address, the time of the one pending alert and its short text. Nothing else. No workouts, no notes.

## Deploy (free, from the Cloudflare dashboard, no computer needed)
1. Create a free account at cloudflare.com and log in.
2. **Workers & Pages → Create → Import a repository** (or "Connect to Git") → authorize GitHub → pick `logbook`.
3. Project name: `jimlogs-push`. **Root directory: `worker`**. Leave the build command empty. Deploy command: `npx wrangler deploy`.
4. Save and deploy. When it finishes, copy the address shown, like `https://jimlogs-push.<your-name>.workers.dev`.
5. In JimLogs (installed on the Home Screen): More → Rest timer alert → switch on the lock-screen alert, paste the address, tap Enable, allow notifications, tap Send test.

The server makes its own signing keys the first time the app asks for them; you never handle any secret.

## Safety notes
- Requests need a 64-character random key made on the phone; only its SHA-256 names your record.
- Only Apple/Google/Mozilla/Microsoft push hosts are accepted as destinations.
- Only the site `frimpongemanuele.github.io` is allowed by CORS.
- Reset: More → switch the alert off and on again after clearing the address, or delete the Worker.
