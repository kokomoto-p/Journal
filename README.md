# Journal (Diarium-style PWA)

Local-first journaling web app. Entries live in your browser (IndexedDB). Google is used only to pull in
calendar events and photos you explicitly pick.

## Features
- One entry per day: title, rich text, mood, tags
- Month calendar with dots on days that have entries, prev/next day, jump to today
- "On this day" shows entries from past years
- Search text, event names, and `#tags`
- Link Google Calendar events for the day (read-only)
- Attach photos via the Google Photos Picker (photos are copied into the app, so they work offline)
- Sync across devices through a hidden app folder in your own Google Drive
- Export / import everything as JSON (photos included)
- Installable PWA, works offline for existing entries

## Run it
No build step. From this folder:

    python3 -m http.server 8080

Open http://localhost:8080. (Google sign-in requires `http://localhost` or HTTPS, not `file://`.)

## Google setup (about 10 minutes)
1. Go to https://console.cloud.google.com and create a project.
2. APIs & Services > Library: enable **Google Calendar API**, **Google Photos Picker API** and
   **Google Drive API**.
3. APIs & Services > OAuth consent screen: choose External, fill in the basics, and add yourself under
   **Test users**. Add these scopes:
   - `.../auth/calendar.events.readonly`
   - `.../auth/photospicker.mediaitems.readonly`
   - `.../auth/drive.appdata` (only lets the app see its own hidden folder, not your other Drive files)
4. Credentials > Create credentials > **OAuth client ID** > Web application.
   Under **Authorized JavaScript origins** add `http://localhost:8080` (and your deployed URL later).
5. Copy the client ID, open the app, click the gear icon, paste it, Save.

While the consent screen is in "Testing" mode, Google expires the authorization every 7 days and shows an
"unverified app" warning. That is fine for personal use.

## Notes on how Google access works
- Photos: Google no longer lets apps browse your whole library. The Picker opens in a Google tab, you choose
  photos, and the app receives just those. Photo URLs expire after about an hour, so the app downloads and
  stores the image data right away. Videos are skipped.
- Calendar: reads events from your primary calendar for the day you are viewing, and you choose which to link.
  Linked events are saved into the entry, so they remain even if the calendar event changes later.
- Tokens are kept in memory only; you may be asked to re-approve after a page reload.

## Syncing between computer and phone
1. Settings (gear) > tick **Sync entries across devices with Google Drive** > Save, then approve the
   Google prompt.
2. Do the same on your other device (same client ID).

The app syncs when it opens, a few seconds after you stop typing, when you switch back to it, and
every 5 minutes while it's open. "Sync now" in the sidebar forces one.

How conflicts work: each day's entry is synced as a whole, and the most recently edited version wins.
If you edit the same day on two devices before either syncs, the older edit is replaced. Deleting all
of an entry's content deletes it everywhere.

Google access tokens last about an hour. After that, background sync pauses and the sidebar says
"Tap Sync now to sign in"; one tap gets a fresh token. (While the consent screen is in Testing mode,
Google also asks you to re-approve the app every 7 days.)

## Deploying to use on your phone
Host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages), add that URL to the
OAuth client's authorized origins, then "Add to Home Screen". Each origin (localhost vs. your hosted URL)
has its own local storage, so turn sync on in each and they'll converge through Drive.

## Ideas for next steps
- Multiple entries per day and times
- Insert photos inline in the text
- Encrypted export / app lock
- Location and weather per entry
- Field-level merge for same-day edits on two devices
