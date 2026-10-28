# Journal

A personal journaling web app. Entries live in your browser (IndexedDB) and sync between your devices
through a hidden folder in your own Google Drive. Google Calendar, Google Photos and Google Maps are used
only for the things you explicitly link, pick or search.

Live at https://kokomoto-p.github.io/Journal/

## Features
- **Timeline:** scroll through all entries, newest first, grouped by month, with title, preview, mood, tags,
  places and a photo
- **Calendar:** scrolling months where each day shows its highlight photo (tap the star on a photo to choose
  it; otherwise the first photo is used). Days with an entry but no photo are shaded.
- **Map:** every place you've added to an entry, shown as photo pins that group together as you zoom out
- One entry per day: title, rich text, mood, tags, places, photos, linked calendar events
- "On this day" shows the same date in other years
- Search text, places, event names and `#tags`
- Link Google Calendar events for the day (read-only)
- Add photos with the Google Photos picker (copied into the app, so they work offline)
- Sync across devices through Google Drive
- Export / import everything as JSON (photos included)
- Installable on phone and desktop, works offline for existing entries

## Run it locally
No build step. From this folder:

    python3 -m http.server 8080

Open http://localhost:8080. (Google sign-in needs `http://localhost` or HTTPS, not `file://`.)

## Google setup: sign-in, Calendar, Photos, Drive (about 10 minutes)
1. Go to https://console.cloud.google.com and create a project.
2. APIs & Services > Library: enable **Google Calendar API**, **Photos Picker API** and **Google Drive API**.
3. APIs & Services > OAuth consent screen (Google Auth Platform): choose External, fill in the basics, and
   add yourself under **Audience > Test users**. Under **Data Access**, add these scopes:
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`
   - `https://www.googleapis.com/auth/drive.appdata` (only the app's own hidden folder, not your other files)
4. **Clients > Create client > Web application.** Under **Authorized JavaScript origins** add
   `https://kokomoto-p.github.io` (and `http://localhost:8080` for local testing).
5. Copy the client ID, open the app, click the gear, paste it, Save.

While the app is in "Testing" mode, Google shows an "unverified app" warning and asks you to re-approve
every 7 days. That's fine for personal use.

## Google Maps setup: Map tab and place search (about 5 minutes)
Google Maps needs an API key on a project with billing turned on, but every account gets a free monthly
allowance per request type: 10,000 map loads, 10,000 place-search requests and 10,000 place lookups
(see https://developers.google.com/maps/billing-and-pricing/pricing). A personal journal uses a tiny
fraction of that. The app is built to stay small:
- The Maps script loads only when you open the Map tab or search for a place.
- The map is created once per app session, which counts as one map load.
- Place search waits until you pause typing, needs 3+ characters, groups each search into one session,
  and only asks for location and address.

Steps:
1. In the same Cloud project, APIs & Services > Library: enable **Maps JavaScript API** and
   **Places API (New)**.
2. APIs & Services > Credentials > **Create credentials > API key**.
3. Edit the key so it can't be used anywhere else:
   - **Application restrictions:** Websites, then add `https://kokomoto-p.github.io/*`
     (and `http://localhost:8080/*` if you test locally)
   - **API restrictions:** Restrict key, then tick **Maps JavaScript API** and **Places API (New)**
4. Paste the key into the app's Settings under "Google Maps API key" and Save.

Optional extra safety:
- **Budget alert:** Billing > Budgets & alerts > create a budget of $1 with email alerts. This doesn't stop
  charges by itself, but you'd hear about anything unexpected right away.
- **Quota caps (a hard stop):** APIs & Services > Maps JavaScript API > Quotas, and the same for
  Places API (New). Lower the per-day or per-minute limits to something small. Requests past the cap
  fail instead of being billed.

Note: Google Photos removes location data from photos it shares with apps, so pins come from the places
you add to each entry, not from photo GPS.

## Syncing between computer and phone
1. Settings (gear) > tick **Sync entries across devices with Google Drive** > Save, then approve the
   Google prompt.
2. Do the same on your other device (same client ID).

The app syncs when it opens, a few seconds after you stop typing, when you switch back to it, and
every 5 minutes while it's open. The ⟳ button in the top bar forces a sync.

Each day's entry syncs as a whole, and the most recent edit wins. If you edit the same day on two
devices before either syncs, the older edit is replaced. Clearing all of an entry's content deletes it
everywhere.

Google access tokens last about an hour. After that, background sync pauses until you tap ⟳.

## Installing
- **Computer (Chrome/Edge):** open the site and click the install icon in the address bar.
- **iPhone:** open the site in Safari > Share > Add to Home Screen. The home-screen app has its own storage,
  so set up the gear settings inside it.
- **Android:** open the site in Chrome > ⋮ > Install app.

## Ideas for next steps
- Import Google Maps Timeline exports to fill in places automatically
- Multiple entries per day
- Insert photos inline in the text
- App lock / encrypted export
- Field-level merge for same-day edits on two devices
