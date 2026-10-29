'use strict';

/* ===================== helpers ===================== */
const $ = s => document.querySelector(s);
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const MOODS = ['😞', '🙁', '😐', '🙂', '😄'];
const APP_VERSION = '2026-10-28.10';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmt(d); };
const todayStr = () => fmt(new Date());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  del: k => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
};

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ===================== IndexedDB ===================== */
const dbp = new Promise((resolve, reject) => {
  const rq = indexedDB.open('journal', 2);
  rq.onupgradeneeded = () => {
    const db = rq.result;
    for (const s of ['entries', 'photos', 'thumbs']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
  };
  rq.onsuccess = () => {
    const db = rq.result;
    // If a newer version of the app opens in another window, step aside so it isn't stuck waiting.
    db.onversionchange = () => { db.close(); location.reload(); };
    resolve(db);
  };
  rq.onerror = () => reject(rq.error);
  // An older copy of the app open somewhere (e.g. a Chrome tab) is holding the old storage format.
  rq.onblocked = () => {
    authLog('storage upgrade blocked by another open Journal window');
    toast('Another Journal window is open with an older version (maybe a Chrome tab). Close it, then reopen the app.', 0);
  };
});
function tx(store, mode, fn) {
  return dbp.then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const dbGet = (st, k) => tx(st, 'readonly', s => s.get(k));
const dbAll = st => tx(st, 'readonly', s => s.getAll());
const dbPut = (st, v) => tx(st, 'readwrite', s => s.put(v));
const dbDel = (st, k) => tx(st, 'readwrite', s => s.delete(k));

/* ===================== state ===================== */
const cache = new Map();           // date -> entry
const tombs = new Map();           // date -> {id, date, deleted:true, updated} (so deletes sync)
let editCounter = 0;               // bumps on every local edit
let cur = null;                    // entry being edited
let currentDate = todayStr();
let view = 'timeline';
let listView = 'timeline';         // where "Back" from an entry goes
let photoUrls = [];                // full-size object URLs for the open entry

const blankEntry = date => ({
  id: date, date, title: '', html: '', text: '', mood: 0, tags: [],
  events: [], photoIds: [], highlight: null, places: [], created: null, updated: null,
});
const norm = e => ({ ...blankEntry(e.date || e.id), ...e });   // older entries lack newer fields
const isEmpty = e => !e.title.trim() && !e.text.trim() && !e.mood && !e.tags.length &&
  !e.events.length && !e.photoIds.length && !(e.places || []).length;
const highlightOf = e => (e.highlight && e.photoIds.includes(e.highlight)) ? e.highlight : (e.photoIds[0] || null);

/* ===================== thumbnails ===================== */
const thumbUrls = new Map();       // photoId -> object URL (square JPEG)
const THUMB_V = 2, THUMB_PX = 640;  // square, center-cropped; sharp on large calendar tiles and retina screens
async function makeThumb(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (_) { bmp = await createImageBitmap(blob); }
  const side = Math.min(bmp.width, bmp.height);
  const out = Math.min(THUMB_PX, side);
  const c = document.createElement('canvas');
  c.width = c.height = out;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  bmp.close && bmp.close();
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
}
async function thumbUrl(pid) {
  if (!pid) return null;
  if (thumbUrls.has(pid)) return thumbUrls.get(pid);
  let rec = await dbGet('thumbs', pid);
  if (!rec || rec.v !== THUMB_V) {               // older, smaller thumbs get rebuilt
    const p = await dbGet('photos', pid);
    if (!p) return null;
    try { rec = { id: pid, v: THUMB_V, blob: await makeThumb(p.blob) }; } catch (_) { rec = { id: pid, v: THUMB_V, blob: p.blob }; }
    await dbPut('thumbs', rec);
  }
  const url = URL.createObjectURL(rec.blob);
  thumbUrls.set(pid, url);
  return url;
}
async function dropPhoto(pid) {
  await dbDel('photos', pid);
  await dbDel('thumbs', pid);
  if (thumbUrls.has(pid)) { URL.revokeObjectURL(thumbUrls.get(pid)); thumbUrls.delete(pid); }
}
// Lazily fill any element with data-thumb="<photoId>" as it scrolls near the screen.
const thumbObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const el = en.target;
    thumbObserver.unobserve(el);
    thumbUrl(el.dataset.thumb).then(u => { if (u) el.style.backgroundImage = `url("${u}")`; });
  }
}, { rootMargin: '600px' });
const observeThumbs = root => root.querySelectorAll('[data-thumb]').forEach(el => thumbObserver.observe(el));

/* ===================== saving ===================== */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  editCounter++;
  $('#status').textContent = 'Saving…';
  saveTimer = setTimeout(() => saveNow(), 500);
}
function collect() {
  if (view !== 'entry') return;
  cur.title = $('#title').value;
  cur.html = $('#editor').innerHTML;
  cur.text = $('#editor').innerText.trim();
  cur.tags = $('#tags').value.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
}
async function saveNow(fromSync = false) {
  const hadPending = !!saveTimer;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!cur) return;
  collect();
  const prev = cache.get(cur.id);
  const changed = prev
    ? JSON.stringify({ ...prev, updated: 0, created: 0 }) !== JSON.stringify({ ...cur, updated: 0, created: 0 })
    : !isEmpty(cur);
  if (!changed && !hadPending) return;
  if (isEmpty(cur)) {
    if (prev) {
      cache.delete(cur.id);
      const t = { id: cur.id, date: cur.date, deleted: true, updated: Date.now() };
      tombs.set(t.id, t);
      await dbPut('entries', t);
    }
  } else if (changed) {
    cur.updated = Date.now();
    cur.created = cur.created || cur.updated;
    cache.set(cur.id, structuredClone(cur));
    tombs.delete(cur.id);
    await dbPut('entries', cur);
  }
  $('#status').textContent = 'Saved';
  listsDirty = true;
  if (!fromSync) queueSync();
}

/* ===================== routing ===================== */
// #/timeline  #/calendar  #/map  #/entry/YYYY-MM-DD
let listsDirty = true;
async function route() {
  const [v, arg] = (location.hash.replace(/^#\/?/, '') || 'timeline').split('/');
  if (view === 'entry' && !(v === 'entry' && arg === currentDate)) await saveNow();
  if (v === 'entry' && /^\d{4}-\d{2}-\d{2}$/.test(arg || '')) return openEntry(arg);
  showView(['timeline', 'calendar', 'map'].includes(v) ? v : 'timeline');
}
function setVisible(v) {
  view = v;
  for (const s of ['timeline', 'calendar', 'map', 'entry']) $('#view-' + s).hidden = s !== v;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.view === (v === 'entry' ? listView : v)));
}
function showView(v) {
  const switching = view !== v;
  listView = v;
  setVisible(v);
  $('#btnBack').href = '#/' + v;
  if (v === 'timeline') { if (listsDirty || switching) renderTimeline(); }
  else if (v === 'calendar') renderPhotoCalendar(switching);
  else if (v === 'map') renderMap();
  if (switching) window.scrollTo(0, 0);
}
const go = h => { location.hash = h; };
const replace = h => { location.replace(h); };

/* ===================== timeline ===================== */
const TL_BATCH = 30;
let tlList = [], tlShown = 0, tlLastMonth = '';
function matchesSearch(e, q) {
  if (!q) return true;
  if (q.startsWith('#')) { const t = q.slice(1); return e.tags.some(x => x.toLowerCase().includes(t)); }
  return [e.title, e.text, e.tags.join(' '), e.events.map(v => v.summary).join(' '),
    (e.places || []).map(p => p.name + ' ' + p.address).join(' ')].join(' ').toLowerCase().includes(q);
}
function renderTimeline() {
  listsDirty = false;
  const q = $('#search').value.trim().toLowerCase();
  tlList = [...cache.values()].filter(e => matchesSearch(e, q)).sort((a, b) => b.date.localeCompare(a.date));
  const keep = Math.max(TL_BATCH, tlShown);
  tlShown = 0; tlLastMonth = '';
  const box = $('#timeline');
  box.innerHTML = '';
  if (!tlList.length) {
    box.innerHTML = q
      ? '<div class="tl-empty">No entries match your search.</div>'
      : '<div class="tl-empty">No entries yet.<br>Tap <b>+</b> to write today’s.</div>';
    return;
  }
  appendTimeline(keep);
}
function cardHtml(e) {
  const d = parseDate(e.date);
  const month = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  let head = '';
  if (month !== tlLastMonth) { tlLastMonth = month; head = `<h2 class="tl-month">${esc(month)}</h2>`; }
  const chips = [
    e.mood ? `<span class="chip soft">${MOODS[e.mood - 1]}</span>` : '',
    ...e.tags.map(t => `<span class="chip">🏷 ${esc(t)}</span>`),
    ...(e.places || []).map(p => `<span class="chip soft">📍 ${esc(p.name)}</span>`),
    ...e.events.slice(0, 3).map(v => `<span class="chip soft">📅 ${esc(v.summary)}</span>`),
  ].join('');
  const pid = highlightOf(e);
  const snip = e.text.length > 400 ? e.text.slice(0, 400) + '…' : e.text;
  return head + `<article class="tl-card" data-date="${e.date}">
    <div class="tl-date"><span class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</span><span class="dnum">${d.getDate()}</span></div>
    <div class="tl-body">
      ${e.title ? `<h3>${esc(e.title)}</h3>` : ''}
      ${snip ? `<p class="tl-snip">${esc(snip)}</p>` : (!e.title ? '<p class="tl-snip empty">Photos &amp; events</p>' : '')}
      ${chips ? `<div class="tl-chips">${chips}</div>` : ''}
    </div>
    ${pid ? `<div class="tl-thumb" data-thumb="${esc(pid)}"></div>` : '<div></div>'}
  </article>`;
}
function appendTimeline(n = TL_BATCH) {
  if (tlShown >= tlList.length) return;
  const slice = tlList.slice(tlShown, tlShown + n);
  tlShown += slice.length;
  const tmp = document.createElement('div');
  tmp.innerHTML = slice.map(cardHtml).join('');
  observeThumbs(tmp);
  $('#timeline').append(...tmp.childNodes);
}
new IntersectionObserver(en => { if (en[0].isIntersecting && view === 'timeline') appendTimeline(); }, { rootMargin: '800px' })
  .observe($('#tlSentinel'));

/* ===================== photo calendar ===================== */
function renderPhotoCalendar(scrollToToday) {
  listsDirty = false;
  const now = new Date();
  const dates = [...cache.keys()].sort();
  // From the month of your first entry (but always at least the last 6 months) up to this month.
  let start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  if (dates.length) {
    const f = parseDate(dates[0]);
    const fm = new Date(f.getFullYear(), f.getMonth(), 1);
    if (fm < start) start = fm;
  }
  let y = start.getFullYear(), m = start.getMonth();
  const t = todayStr();
  let html = '';
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth())) {
    const label = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const lead = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let cells = '<div class="pc-day blank"></div>'.repeat(lead);
    for (let d = 1; d <= days; d++) {
      const s = `${y}-${pad(m + 1)}-${pad(d)}`;
      const e = cache.get(s);
      const pid = e && highlightOf(e);
      const cls = ['pc-day', e ? (pid ? 'photo' : 'entry') : '', s === t ? 'today' : ''].filter(Boolean).join(' ');
      cells += `<div class="${cls}" data-date="${s}"${pid ? ` data-thumb="${esc(pid)}"` : ''}>${pid ? `<span>${d}</span>` : d}</div>`;
    }
    html += `<section class="pc-month" id="m-${y}-${pad(m + 1)}"><h3>${esc(label)}</h3><div class="pc-grid">${cells}</div></section>`;
    if (++m > 11) { m = 0; y++; }
  }
  const box = $('#months');
  const keepY = window.scrollY;
  box.innerHTML = html;
  observeThumbs(box);
  if (scrollToToday) {
    const el = document.getElementById(`m-${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  } else window.scrollTo(0, keepY);
}

/* ===================== entry editor ===================== */
async function openEntry(date) {
  currentDate = date;
  cur = structuredClone(cache.get(date) || blankEntry(date));
  setVisible('entry');
  window.scrollTo(0, 0);
  await renderEntry();
}
async function renderEntry() {
  $('#dateLabel').textContent = parseDate(currentDate).toLocaleDateString(undefined,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  $('#jumpDate').value = currentDate;
  $('#title').value = cur.title;
  $('#editor').innerHTML = cur.html;
  $('#tags').value = cur.tags.join(', ');
  $('#status').textContent = '';
  $('#eventPicker').hidden = true;
  $('#placeSearch').value = ''; hideSuggestions();
  renderMood();
  renderEvents();
  renderPlaces();
  renderOnThisDay();
  await renderPhotos();
}
function renderMood() {
  $('#mood').innerHTML = MOODS.map((m, i) =>
    `<button type="button" role="radio" aria-checked="${cur.mood === i + 1}" class="${cur.mood === i + 1 ? 'on' : ''}" data-m="${i + 1}">${m}</button>`
  ).join('');
}
function renderOnThisDay() {
  const md = currentDate.slice(5);
  const list = [...cache.values()]
    .filter(e => e.date.slice(5) === md && e.date !== currentDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#otdList').innerHTML = list.length
    ? list.map(e => `<li data-date="${e.date}">${esc((e.title || e.text || 'Photos & events').slice(0, 90))}<small>${e.date.slice(0, 4)}</small></li>`).join('')
    : '<li class="empty" style="cursor:default">No entries from other years on this date.</li>';
}

/* ===================== Google auth ===================== */
let tokenClient = null, token = null, tokenExp = 0, pending = null, forceConsent = false;
// The sign-in may finish in another window of this app (Android does this for installed apps),
// so always fall back to the copy saved in storage.
function loadStoredToken() {
  try {
    const s = JSON.parse(ls.get('gtoken') || 'null');
    if (s && s.exp > Date.now() + 60000) { token = s.t; tokenExp = s.exp; return true; }
  } catch (_) { /* ignore */ }
  return false;
}
loadStoredToken();
function clearToken() { token = null; tokenExp = 0; ls.del('gtoken'); }
const hasToken = () => (!!token && Date.now() < tokenExp - 60000) || loadStoredToken();
function saveToken(t, expiresIn) {
  token = t; tokenExp = Date.now() + Number(expiresIn) * 1000;
  ls.set('gtoken', JSON.stringify({ t: token, exp: tokenExp }));
}

/* Installed (home-screen) apps can't use Google's pop-up sign-in: on Android the pop-up opens in a
   separate tab that can't hand the result back. There, sign-in goes to Google's page and returns
   to the app with the token in the URL instead. */
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// Small sign-in log (no tokens or personal data), shown in Settings to diagnose sign-in on phones.
function authLog(msg) {
  let log = [];
  try { log = JSON.parse(ls.get('authLog') || '[]'); } catch (_) { /* ignore */ }
  const t = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  log.push(`${t} ${msg}`);
  ls.set('authLog', JSON.stringify(log.slice(-14)));
}
(() => {
  const h = location.hash;
  const kind = /access_token=/.test(h) ? 'with sign-in token' : /error=/.test(h) ? 'with sign-in error' : h ? 'at ' + h.split('?')[0] : 'with no address';
  const mode = ['standalone', 'minimal-ui', 'fullscreen', 'browser'].find(m => matchMedia(`(display-mode: ${m})`).matches) || '?';
  authLog(`opened ${kind} · ${mode} · v${APP_VERSION}${document.referrer ? ' · from ' + new URL(document.referrer).host : ''}`);
})();
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');   // https://kokomoto-p.github.io/Journal/
function redirectSignIn(after) {
  const cid = ls.get('clientId');
  const state = uuid();
  ls.set('oauthState', JSON.stringify({ state, after, hash: location.hash || '#/timeline', at: Date.now(), installed: isInstalled() }));
  const qs = new URLSearchParams({
    client_id: cid, redirect_uri: REDIRECT_URI, response_type: 'token', scope: SCOPES,
    include_granted_scopes: 'true', state,
  });
  // Skip the account picker once we know which account you use; ask again only if permissions are missing.
  const email = ls.get('gEmail');
  if (forceConsent) qs.set('prompt', 'consent');
  else if (email) qs.set('login_hint', email);
  else qs.set('prompt', 'select_account');
  forceConsent = false;
  authLog(`going to Google sign-in (${qs.get('prompt') || 'hint'}) · returns to ${REDIRECT_URI}`);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + qs);
}
// Runs at startup: pick up a token (or error) Google sent back in the URL. Returns what to do next.
function finishRedirectSignIn() {
  const h = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h);
  let saved = null;
  try { saved = JSON.parse(ls.get('oauthState') || 'null'); } catch (_) { /* ignore */ }
  ls.del('oauthState');
  history.replaceState(null, '', location.pathname + ((saved && saved.hash) || '#/timeline'));
  if (!saved || p.get('state') !== saved.state) { authLog(saved ? 'sign-in state mismatch' : 'sign-in returned but no saved state'); return { error: 'Sign-in response didn’t match. Please try again.' }; }
  if (p.get('error')) {
    const err = p.get('error');
    authLog('Google returned error: ' + err);
    return { error: err === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed: ' + err };
  }
  const granted = (p.get('scope') || '').split(' ');
  if (!granted.some(s => s.endsWith('drive.appdata'))) forceConsent = true;
  saveToken(p.get('access_token'), p.get('expires_in') || 3600);
  authLog(`token saved · drive ${forceConsent ? 'NOT granted' : 'granted'} · ${isInstalled() ? 'in app' : 'in separate window'}`);
  // Finished in a separate browser window instead of the app itself? The app picks the sign-in
  // up from storage; this window just needs closing.
  return { after: saved.after, outside: !!saved.installed && !isInstalled() };
}

function getToken(interactive = true, after = '') {
  return new Promise((resolve, reject) => {
    if (hasToken()) return resolve(token);
    if (!interactive) { const e = new Error('Sign-in needed'); e.code = 'NEED_AUTH'; return reject(e); }
    const cid = ls.get('clientId');
    if (!cid) { openSettings(); return reject(new Error('Add your Google client ID in Settings first.')); }
    if (isInstalled()) {
      saveNow().finally(() => redirectSignIn(after));
      return reject(Object.assign(new Error('Signing in with Google…'), { code: 'REDIRECTING' }));
    }
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      return reject(new Error('Google sign-in script not loaded (are you offline?).'));
    }
    if (!tokenClient || tokenClient._cid !== cid) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: SCOPES,
        callback: r => {
          if (!pending) return;
          const p = pending; pending = null;
          if (r.error) return p.reject(new Error(r.error_description || r.error));
          saveToken(r.access_token, r.expires_in);
          p.resolve(token);
        },
        error_callback: e => {
          if (!pending) return;
          const p = pending; pending = null;
          p.reject(new Error('Google sign-in was cancelled or blocked (' + (e.type || 'unknown') + ').'));
        },
      });
      tokenClient._cid = cid;
    }
    pending = { resolve, reject };
    // Safety net: if the pop-up never reports back, don't leave sync waiting forever.
    const mine = pending;
    setTimeout(() => {
      if (pending !== mine) return;
      pending = null;
      reject(new Error('Google sign-in didn’t finish. Close the sign-in window and try again.'));
    }, 120000);
    tokenClient.requestAccessToken(forceConsent ? { prompt: 'consent' } : {});
    forceConsent = false;
  });
}

// as: 'json' | 'blob' | 'none'
async function gfetch(url, opts = {}, as = 'json', interactive = true) {
  const t = await getToken(interactive);
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (res.status === 401) {
    clearToken();
    const e = new Error('Google session expired, try again.');
    if (!interactive) e.code = 'NEED_AUTH';
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (_) { /* ignore */ }
    throw new Error(`Google API ${res.status}${detail ? ': ' + detail : ''}`);
  }
  if (as === 'blob') return res.blob();
  if (as === 'none') return null;
  return res.json();
}

/* ===================== Calendar events ===================== */
function eventTime(ev) {
  if (ev.allDay) return 'All day';
  const f = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ev.end ? `${f(ev.start)} – ${f(ev.end)}` : f(ev.start);
}
function renderEvents() {
  $('#eventList').innerHTML = cur.events.map((ev, i) =>
    `<li><div>${esc(ev.summary)}<small>${esc(eventTime(ev))}${ev.location ? ' · ' + esc(ev.location) : ''}</small></div>
     <button type="button" class="x" data-i="${i}" aria-label="Remove event">&times;</button></li>`).join('');
}
async function loadEvents() {
  const btn = $('#btnEvents');
  btn.disabled = true;
  try {
    const d = parseDate(currentDate);
    const min = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const max = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const qs = new URLSearchParams({
      timeMin: min.toISOString(), timeMax: max.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
    });
    const data = await gfetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + qs);
    const items = (data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
      id: e.id,
      summary: e.summary || '(no title)',
      allDay: !!e.start.date,
      start: e.start.dateTime || e.start.date,
      end: e.end && (e.end.dateTime || null),
      location: e.location || '',
      link: e.htmlLink || '',
    }));
    showEventPicker(items);
  } catch (err) {
    if (err.code !== 'REDIRECTING') toast(err.message, 6000);
  } finally {
    btn.disabled = false;
  }
}
function showEventPicker(items) {
  const box = $('#eventPicker');
  box.hidden = false;
  if (!items.length) { box.innerHTML = '<span class="empty">No events found on this day.</span>'; return; }
  const linked = new Set(cur.events.map(e => e.id));
  box.innerHTML = items.map((ev, i) =>
    `<label><input type="checkbox" data-i="${i}" ${linked.has(ev.id) ? 'checked' : ''}>
      <span>${esc(ev.summary)}<br><small class="empty">${esc(eventTime(ev))}</small></span></label>`).join('') +
    '<div class="row"><button type="button" id="applyEvents" class="primary">Save selection</button></div>';
  $('#applyEvents').onclick = () => {
    const picked = [...box.querySelectorAll('input:checked')].map(c => items[Number(c.dataset.i)]);
    const unrelated = cur.events.filter(e => !items.some(i => i.id === e.id));
    cur.events = [...unrelated, ...picked];
    box.hidden = true;
    renderEvents();
    scheduleSave();
  };
}

/* ===================== Photos (Picker API) ===================== */
const dur = s => (parseFloat(String(s)) || 5) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function renderPhotos() {
  photoUrls.forEach(URL.revokeObjectURL);
  photoUrls = [];
  const grid = $('#photoGrid');
  grid.innerHTML = '';
  const hl = highlightOf(cur);
  $('#photoHint').hidden = cur.photoIds.length < 1;
  for (const id of cur.photoIds) {
    const rec = await dbGet('photos', id);
    if (!rec) continue;
    const url = URL.createObjectURL(rec.blob);
    photoUrls.push(url);
    const isHl = id === hl;
    const div = document.createElement('div');
    div.className = 'photo' + (isHl ? ' hl' : '');
    div.innerHTML = `<img alt="" src="${url}">
      <button type="button" class="star${isHl ? ' on' : ''}" data-id="${esc(id)}" title="${isHl ? 'Day highlight' : 'Make this the day highlight'}" aria-label="Make highlight">&#9733;</button>
      <button type="button" class="x" data-id="${esc(id)}" aria-label="Remove photo">&times;</button>`;
    grid.appendChild(div);
  }
}

async function pickPhotos() {
  // In the installed app, sign in first (it leaves the app briefly); then tap the button again.
  if (isInstalled() && !hasToken()) { getToken().catch(() => {}); return; }
  const btn = $('#btnPhotos');
  const win = window.open('', '_blank');   // open inside the click so popup blockers allow it
  btn.disabled = true;
  try {
    const session = await gfetch('https://photospicker.googleapis.com/v1/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const uri = session.pickerUri + '/autoclose';
    if (win) win.location = uri; else window.open(uri, '_blank');
    toast('Choose photos in the Google Photos tab, then come back here…', 0);

    const every = dur(session.pollingConfig?.pollInterval);
    const deadline = Date.now() + dur(session.pollingConfig?.timeoutIn || '300s');
    let state = session;
    while (!state.mediaItemsSet) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for photo selection.');
      await sleep(every);
      state = await gfetch('https://photospicker.googleapis.com/v1/sessions/' + session.id);
    }

    toast('Downloading photos…', 0);
    const items = [];
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ sessionId: session.id, pageSize: '100' });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await gfetch('https://photospicker.googleapis.com/v1/mediaItems?' + qs);
      items.push(...(page.mediaItems || []));
      pageToken = page.nextPageToken || '';
    } while (pageToken);

    let added = 0, skipped = 0;
    for (const it of items) {
      if (it.type && it.type !== 'PHOTO') { skipped++; continue; }
      const blob = await gfetch(it.mediaFile.baseUrl + '=w2048-h2048', {}, 'blob');
      const id = uuid();
      await dbPut('photos', { id, blob, name: it.mediaFile.filename || '', mime: it.mediaFile.mimeType || blob.type, takenAt: it.createTime || null });
      cur.photoIds.push(id);
      added++;
    }
    gfetch('https://photospicker.googleapis.com/v1/sessions/' + session.id, { method: 'DELETE' }, 'none').catch(() => {});

    await renderPhotos();
    scheduleSave();
    toast(`Added ${added} photo${added === 1 ? '' : 's'}${skipped ? ` (${skipped} video${skipped === 1 ? '' : 's'} skipped)` : ''}.`);
  } catch (err) {
    if (win && !win.closed) { try { if (win.location.href === 'about:blank') win.close(); } catch (_) { /* cross-origin */ } }
    if (err.code !== 'REDIRECTING') toast(err.message, 7000);
  } finally {
    btn.disabled = false;
  }
}

/* ===================== Google Maps (map view + place search) =====================
   Free-tier friendly: the Maps script loads only when needed, the map is created once per
   app session (one "map load"), and place search waits for a pause in typing and uses
   session tokens + only Essentials fields (location, address). */
let gmapsPromise = null, clustererPromise = null;
window.gm_authFailure = () => toast('Google Maps rejected the API key. Check the key and its website restriction in Google Cloud.', 9000);
function loadGoogleMaps() {
  if (window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  const key = ls.get('mapsKey');
  if (!key) return Promise.reject(Object.assign(new Error('Add a Google Maps API key in Settings to use the map and place search.'), { code: 'NO_KEY' }));
  gmapsPromise = new Promise((resolve, reject) => {
    window.__gmapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker,places&callback=__gmapsReady`;
    s.async = true;
    s.onerror = () => { gmapsPromise = null; s.remove(); reject(new Error('Could not load Google Maps (are you offline?).')); };
    document.head.appendChild(s);
  });
  return gmapsPromise;
}
function loadClusterer() {
  if (window.markerClusterer) return Promise.resolve();
  if (clustererPromise) return clustererPromise;
  clustererPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js';
    s.onload = resolve;
    s.onerror = () => { clustererPromise = null; reject(new Error('Could not load map clustering.')); };
    document.head.appendChild(s);
  });
  return clustererPromise;
}

/* ---- places on an entry ---- */
function renderPlaces() {
  const places = cur.places || [];
  $('#placeList').innerHTML = places.map((p, i) =>
    `<li><div>📍 ${esc(p.name)}<small>${esc(p.address || '')}</small></div>
     <button type="button" class="x" data-i="${i}" aria-label="Remove place">&times;</button></li>`).join('');
}
let sessionToken = null, suggestTimer = null, suggestSeq = 0, suggestions = [];
function hideSuggestions() { $('#placeSuggest').hidden = true; $('#placeSuggest').innerHTML = ''; suggestions = []; }
function onPlaceInput() {
  clearTimeout(suggestTimer);
  const q = $('#placeSearch').value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 350);   // wait for a pause in typing
}
async function fetchSuggestions(q) {
  const seq = ++suggestSeq;
  try {
    await loadGoogleMaps();
    const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
    if (!sessionToken) sessionToken = new AutocompleteSessionToken();
    const req = { input: q, sessionToken };
    const last = [...cache.values()].flatMap(e => e.places || []).pop();
    if (last) req.locationBias = { lat: last.lat, lng: last.lng };   // prefer places near where you've been
    const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
    if (seq !== suggestSeq) return;
    suggestions = (res.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 6);
    const box = $('#placeSuggest');
    box.innerHTML = suggestions.length
      ? suggestions.map((p, i) => `<li data-i="${i}"><b>${esc(p.mainText?.text || p.text?.text || '')}</b><small>${esc(p.secondaryText?.text || '')}</small></li>`).join('')
      : '<li class="empty">No matches</li>';
    box.hidden = false;
  } catch (err) {
    if (seq !== suggestSeq) return;
    hideSuggestions();
    toast(err.message, 7000);
    if (err.code === 'NO_KEY') openSettings();
  }
}
async function pickSuggestion(i) {
  const pred = suggestions[i];
  if (!pred) return;
  hideSuggestions();
  $('#placeSearch').value = '';
  try {
    const place = pred.toPlace();
    await place.fetchFields({ fields: ['location', 'formattedAddress'] });   // Essentials fields only
    sessionToken = null;                                                      // session ends with the details call
    const entry = {
      id: place.id || pred.placeId,
      name: pred.mainText?.text || pred.text?.text || place.formattedAddress,
      address: place.formattedAddress || pred.secondaryText?.text || '',
      lat: place.location.lat(), lng: place.location.lng(),
    };
    cur.places = [...(cur.places || []).filter(p => p.id !== entry.id), entry];
    renderPlaces();
    scheduleSave();
  } catch (err) {
    toast('Could not get that place: ' + err.message, 7000);
  }
}

/* ---- map view ---- */
let map = null, clusterer = null, mapMarkers = [], infoWin = null, mapFitted = false;
async function renderMap() {
  const msg = $('#mapMsg');
  msg.hidden = true;
  try {
    await loadGoogleMaps();
    await loadClusterer();
  } catch (err) {
    msg.innerHTML = esc(err.message) + (err.code === 'NO_KEY' ? ' <button id="mapSettings">Open settings</button>' : '');
    msg.hidden = false;
    const b = $('#mapSettings'); if (b) b.onclick = openSettings;
    return;
  }
  const { Map, InfoWindow } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  if (!map) {
    map = new Map($('#map'), {
      center: { lat: 39.5, lng: -98.35 }, zoom: 4,
      mapId: ls.get('mapId') || 'DEMO_MAP_ID',
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      clickableIcons: false, gestureHandling: 'greedy',
    });
    infoWin = new InfoWindow();
  }
  // (Re)build markers: one per place per entry.
  if (clusterer) clusterer.clearMarkers();
  mapMarkers.forEach(m => { m.map = null; });
  mapMarkers = [];
  const bounds = new google.maps.LatLngBounds();
  for (const e of [...cache.values()].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const p of e.places || []) {
      const pid = highlightOf(e);
      const content = document.createElement('div');
      content.className = 'mk' + (pid ? '' : ' nophoto');
      if (pid) thumbUrl(pid).then(u => { if (u) content.style.backgroundImage = `url("${u}")`; });
      const m = new AdvancedMarkerElement({ position: { lat: p.lat, lng: p.lng }, content, title: `${e.date} · ${p.name}` });
      m._entry = e; m._place = p; m._pid = pid;
      m.addListener('click', () => showMarkerList([m]));
      mapMarkers.push(m);
      bounds.extend(m.position);
    }
  }
  const { MarkerClusterer } = window.markerClusterer;
  if (!clusterer) {
    clusterer = new MarkerClusterer({
      map, markers: [],
      renderer: {
        render: ({ count, position, markers }) => {
          const withPhoto = markers.find(x => x._pid);
          const el = document.createElement('div');
          el.className = 'mk cluster' + (withPhoto ? '' : ' nophoto');
          el.innerHTML = `<span>${count}</span>`;
          if (withPhoto) thumbUrl(withPhoto._pid).then(u => { if (u) el.style.backgroundImage = `url("${u}")`; });
          return new AdvancedMarkerElement({ position, content: el, zIndex: 1000 + count });
        },
      },
      onClusterClick: (ev, cluster) => {
        const b = cluster.bounds;
        const tiny = !b || b.getNorthEast().equals(b.getSouthWest()) || map.getZoom() >= 17;
        if (tiny) showMarkerList(cluster.markers, cluster.position);
        else map.fitBounds(b, 60);
      },
    });
  }
  clusterer.addMarkers(mapMarkers);
  if (!mapMarkers.length) {
    msg.textContent = 'No places yet. Add a place to an entry (under "Places") and it will show up here.';
    msg.hidden = false;
  } else if (!mapFitted) {
    mapFitted = true;
    map.fitBounds(bounds, 60);
    google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 15) map.setZoom(15); });
  }
}
function showMarkerList(markers, position) {
  const items = markers.slice().sort((a, b) => b._entry.date.localeCompare(a._entry.date)).map(m => {
    const e = m._entry;
    const d = parseDate(e.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return `<li><a href="#/entry/${e.date}"><b>${esc(d)}</b> · ${esc(m._place.name)}<br><span>${esc((e.title || e.text || '').slice(0, 80))}</span></a></li>`;
  }).join('');
  infoWin.setContent(`<ul class="mk-list">${items}</ul>`);
  infoWin.setPosition(position || markers[0].position);
  infoWin.open({ map });
}

/* ===================== Google Drive sync (appDataFolder) =====================
   One Drive file per entry ("entry-YYYY-MM-DD.json", appProperties.updated = ms timestamp)
   and one per photo ("photo-<id>"). Newest edit of an entry wins. Deleted entries are kept
   as small tombstones so the delete reaches other devices. */
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';
const syncOn = () => ls.get('sync') === '1';
let syncing = false, syncAgain = false, syncTimer = null;

const syncInfo = { state: '', when: null, error: '', email: '', remote: null, local: 0 };
function setSyncStatus(s, state = '') {
  $('#syncStatus').textContent = s;
  $('#btnSync').title = s || 'Sync now';
  $('#btnSync').classList.toggle('err', state === 'err');
  $('#btnSync').classList.toggle('spin', state === 'busy');
  syncInfo.state = state;
  renderSyncInfo();
}
function renderSyncInfo() {
  const el = $('#syncInfo');
  if (!el) return;
  if (!syncOn()) { el.textContent = ''; return; }
  const parts = [];
  if (syncInfo.email) parts.push(`Syncing as ${syncInfo.email}.`);
  if (syncInfo.remote !== null) parts.push(`${syncInfo.remote} entr${syncInfo.remote === 1 ? 'y' : 'ies'} in Drive, ${cache.size} on this device.`);
  if (syncInfo.when) parts.push(`Last synced ${syncInfo.when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`);
  if (syncInfo.error) parts.push(`Last problem: ${syncInfo.error}`);
  if (!parts.length) parts.push('Not synced yet on this device. Tap ⟳ in the top bar.');
  el.textContent = parts.join(' ');
  el.classList.toggle('bad', !!syncInfo.error);
}
function renderSyncBar() { $('#syncBar').hidden = !syncOn(); }
function queueSync(delay = 4000) {
  if (!syncOn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), delay);
}
async function listRemote(interactive) {
  const files = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({
      spaces: 'appDataFolder', pageSize: '1000',
      fields: 'nextPageToken,files(id,name,appProperties,modifiedTime)',
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const r = await gfetch(DRIVE + '?' + qs, {}, 'json', interactive);
    files.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return files;
}
function driveUpload(existingId, name, appProperties, body, mime, interactive) {
  const meta = existingId ? { appProperties } : { name, parents: ['appDataFolder'], appProperties };
  const b = 'jsync' + Math.random().toString(16).slice(2);
  const payload = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`,
    body,
    `\r\n--${b}--`,
  ]);
  const url = existingId
    ? `${DRIVE_UP}/${existingId}?uploadType=multipart&fields=id`
    : `${DRIVE_UP}?uploadType=multipart&fields=id`;
  return gfetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body: payload,
  }, 'json', interactive);
}
async function sync(interactive = false) {
  if (!syncOn()) return;
  if (syncing) { syncAgain = true; return; }
  if (interactive && !hasToken() && isInstalled() && ls.get('clientId')) {
    setSyncStatus('Signing in…', 'busy');
    await saveNow(true);
    redirectSignIn('sync');              // comes back to the app and syncs
    return;
  }
  syncing = true;
  clearTimeout(syncTimer);
  setSyncStatus('Syncing…', 'busy');
  let photoFails = 0;
  try {
    await saveNow(true);
    const editsAtStart = editCounter;
    if (!syncInfo.email) {
      gfetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {}, 'json', interactive)
        .then(r => { syncInfo.email = r.user?.emailAddress || ''; if (syncInfo.email) ls.set('gEmail', syncInfo.email); renderSyncInfo(); }).catch(() => {});
    }
    const files = await listRemote(interactive);
    const rEntries = new Map(), rPhotos = new Map();
    for (const f of files) {
      if (f.name.startsWith('entry-') && f.name.endsWith('.json')) rEntries.set(f.name.slice(6, -5), f);
      else if (f.name.startsWith('photo-')) rPhotos.set(f.name.slice(6), f);
    }
    const remoteUpdated = f => Number(f?.appProperties?.updated || 0);
    let created = 0;

    // 1. Pull entries that are newer on Drive.
    let curChanged = false, pulled = 0, pushed = 0;
    for (const [id, f] of rEntries) {
      const local = cache.get(id) || tombs.get(id);
      if (local && remoteUpdated(f) <= (local.updated || 0)) continue;
      const raw = await gfetch(`${DRIVE}/${f.id}?alt=media`, {}, 'json', interactive);
      const e = raw.deleted ? raw : norm(raw);
      if (e.deleted) { cache.delete(id); tombs.set(id, e); }
      else { tombs.delete(id); cache.set(id, e); }
      await dbPut('entries', e);
      pulled++;
      if (cur && id === cur.id) curChanged = true;
    }
    // Show pulled entries right away; photos can take a while on a first sync.
    if (pulled) { listsDirty = true; refreshListView(); if (interactive) toast(`Got ${pulled} entr${pulled === 1 ? 'y' : 'ies'} from Drive, downloading photos…`, 0); }

    // 2. Photos: download ones we're missing, upload ones Drive is missing.
    const needed = new Set();
    for (const e of cache.values()) (e.photoIds || []).forEach(p => needed.add(p));
    const localPhotos = new Set(await tx('photos', 'readonly', s => s.getAllKeys()));
    for (const pid of needed) {
      if (localPhotos.has(pid) || !rPhotos.has(pid)) continue;
      const f = rPhotos.get(pid), ap = f.appProperties || {};
      try {
        const blob = await gfetch(`${DRIVE}/${f.id}?alt=media`, {}, 'blob', interactive);
        await dbPut('photos', { id: pid, blob, name: ap.name || '', mime: ap.mime || blob.type, takenAt: ap.takenAt || null });
        localPhotos.add(pid);
        if (thumbUrls.has(pid)) { URL.revokeObjectURL(thumbUrls.get(pid)); thumbUrls.delete(pid); }
      } catch (err) {
        if (err.code === 'NEED_AUTH' || /401|403/.test(err.message)) throw err;
        photoFails++;                      // skip this one; it'll be retried next sync
      }
    }
    if (pulled) refreshListView();
    for (const pid of needed) {
      if (!localPhotos.has(pid) || rPhotos.has(pid)) continue;
      const p = await dbGet('photos', pid);
      const r = await driveUpload(null, 'photo-' + pid,
        { name: (p.name || '').slice(0, 80), mime: p.mime || '', takenAt: p.takenAt || '' },
        p.blob, p.mime || 'application/octet-stream', interactive);
      rPhotos.set(pid, { id: r.id, modifiedTime: new Date().toISOString() });
    }

    // 3. Push entries (and deletions) that are newer here.
    for (const e of [...cache.values(), ...tombs.values()]) {
      const f = rEntries.get(e.id);
      if (f && (e.updated || 0) <= remoteUpdated(f)) continue;
      await driveUpload(f && f.id, `entry-${e.id}.json`, { updated: String(e.updated || 0) },
        JSON.stringify(e), 'application/json', interactive);
      pushed++;
      if (!f) created++;
    }

    // 4. Refresh the open entry if it changed elsewhere and you haven't typed since.
    if (curChanged && editCounter === editsAtStart) {
      cur = structuredClone(cache.get(cur.id) || blankEntry(cur.id));
      if (view === 'entry') await renderEntry();
    }

    // 5. Tidy up photos no entry uses any more (remote only after a day, to be safe across devices).
    const keep = new Set([...needed, ...((cur && cur.photoIds) || [])]);
    for (const [pid, f] of rPhotos) {
      if (!keep.has(pid) && Date.now() - Date.parse(f.modifiedTime || 0) > 864e5) {
        gfetch(`${DRIVE}/${f.id}`, { method: 'DELETE' }, 'none', interactive).catch(() => {});
      }
    }
    for (const pid of localPhotos) if (!keep.has(pid)) await dropPhoto(pid);

    if (pulled) { listsDirty = true; refreshListView(); }
    syncInfo.when = new Date();
    syncInfo.error = photoFails ? `${photoFails} photo${photoFails === 1 ? '' : 's'} didn't download; will retry next sync.` : '';
    syncInfo.remote = rEntries.size + created - tombs.size;   // entry files in Drive, minus deleted days
    setSyncStatus(`Synced ${syncInfo.when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`, photoFails ? 'err' : '');
    if (interactive) toast(pulled || pushed ? `Synced: ${pulled} down, ${pushed} up.` : `Up to date (${cache.size} entries).`);
  } catch (err) {
    if (err.code === 'REDIRECTING') { /* leaving to sign in */ }
    else if (err.code === 'NEED_AUTH') { syncInfo.error = 'Signed out. Tap ⟳ to sign in again.'; setSyncStatus('Tap ⟳ to sign in', 'err'); }
    else {
      let msg = err.message;
      if (/insufficient|scope/i.test(msg)) {
        msg = 'Google didn’t give the app Drive access. Tap ⟳ and tick every box on the Google screen.';
        clearToken(); forceConsent = true;
      }
      syncInfo.error = msg;
      setSyncStatus('Sync failed', 'err');
      console.warn('sync', err);
      if (interactive) toast(msg, 9000);
    }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(1000); }
  }
}
function refreshListView() {
  if (view === 'timeline') renderTimeline();
  else if (view === 'calendar') renderPhotoCalendar(false);
  else if (view === 'map') renderMap();
  else if (view === 'entry') renderOnThisDay();
}

/* ===================== export / import ===================== */
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataUrlToBlob = async u => (await fetch(u)).blob();

async function exportAll() {
  await saveNow();
  const entries = [...cache.values()];
  const photos = await dbAll('photos');
  const out = {
    version: 2, exportedAt: new Date().toISOString(), entries,
    photos: await Promise.all(photos.map(async p => ({ id: p.id, name: p.name, mime: p.mime, takenAt: p.takenAt, data: await blobToDataUrl(p.blob) }))),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `journal-export-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importAll(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.entries)) throw new Error('Not a journal export file.');
  for (const p of data.photos || []) await dbPut('photos', { id: p.id, name: p.name, mime: p.mime, takenAt: p.takenAt, blob: await dataUrlToBlob(p.data) });
  for (const raw of data.entries) { const e = norm(raw); tombs.delete(e.id); cache.set(e.id, e); await dbPut('entries', e); }
  listsDirty = true;
  if (view === 'entry') { cur = structuredClone(cache.get(currentDate) || blankEntry(currentDate)); await renderEntry(); }
  else refreshListView();
  queueSync(500);
  return data.entries.length;
}

/* ===================== settings ===================== */
function openSettings() {
  $('#clientId').value = ls.get('clientId') || '';
  $('#mapsKey').value = ls.get('mapsKey') || '';
  $('#syncToggle').checked = syncOn();
  $('#settingsMsg').textContent = '';
  $('#appVersion').textContent = 'Version ' + APP_VERSION;
  let log = [];
  try { log = JSON.parse(ls.get('authLog') || '[]'); } catch (_) { /* ignore */ }
  $('#authLog').textContent = log.length ? log.join('\n') : '(empty)';
  $('#authLogBox').hidden = !log.length;
  renderSyncInfo();
  const d = $('#settings');
  if (!d.open) d.showModal();
}

/* ===================== wiring ===================== */
function wire() {
  window.addEventListener('hashchange', route);

  $('#title').addEventListener('input', scheduleSave);
  $('#tags').addEventListener('input', scheduleSave);
  $('#editor').addEventListener('input', scheduleSave);
  $('#editor').addEventListener('paste', e => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  $('#toolbar').addEventListener('mousedown', e => e.preventDefault());
  $('#toolbar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#editor').focus();
    document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
    scheduleSave();
  });
  $('#mood').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const m = Number(b.dataset.m);
    cur.mood = cur.mood === m ? 0 : m;
    renderMood(); scheduleSave();
  });

  // lists -> entry
  $('#timeline').addEventListener('click', e => { const c = e.target.closest('[data-date]'); if (c) go('#/entry/' + c.dataset.date); });
  $('#months').addEventListener('click', e => { const c = e.target.closest('.pc-day[data-date]'); if (c) go('#/entry/' + c.dataset.date); });
  $('#otdList').addEventListener('click', e => { const c = e.target.closest('[data-date]'); if (c) go('#/entry/' + c.dataset.date); });
  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderTimeline, 150); });

  // entry navigation
  $('#btnToday').onclick = () => go('#/entry/' + todayStr());
  $('#prevDay').onclick = () => replace('#/entry/' + addDays(currentDate, -1));
  $('#nextDay').onclick = () => replace('#/entry/' + addDays(currentDate, 1));
  $('#jumpDate').addEventListener('change', e => { if (e.target.value) replace('#/entry/' + e.target.value); });

  // events
  $('#btnEvents').onclick = loadEvents;
  $('#eventList').addEventListener('click', e => {
    const b = e.target.closest('.x'); if (!b) return;
    cur.events.splice(Number(b.dataset.i), 1);
    renderEvents(); scheduleSave();
  });

  // photos
  $('#btnPhotos').onclick = pickPhotos;
  $('#photoGrid').addEventListener('click', async e => {
    const star = e.target.closest('.star');
    if (star) {
      cur.highlight = star.dataset.id;
      await renderPhotos(); scheduleSave();
      toast('Set as this day’s highlight photo.', 2000);
      return;
    }
    const x = e.target.closest('.x');
    if (x) {
      cur.photoIds = cur.photoIds.filter(id => id !== x.dataset.id);
      if (cur.highlight === x.dataset.id) cur.highlight = null;
      await dropPhoto(x.dataset.id);
      await renderPhotos(); scheduleSave();
      return;
    }
    const img = e.target.closest('img');
    if (img) { $('#lightImg').src = img.src; $('#lightbox').showModal(); }
  });

  // places
  $('#placeSearch').addEventListener('input', onPlaceInput);
  $('#placeSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (suggestions.length) pickSuggestion(0); }
    if (e.key === 'Escape') hideSuggestions();
  });
  $('#placeSuggest').addEventListener('mousedown', e => e.preventDefault());
  $('#placeSuggest').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) pickSuggestion(Number(li.dataset.i)); });
  $('#placeSearch').addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  $('#placeList').addEventListener('click', e => {
    const b = e.target.closest('.x'); if (!b) return;
    cur.places.splice(Number(b.dataset.i), 1);
    renderPlaces(); scheduleSave();
  });

  // settings
  $('#btnSettings').onclick = openSettings;
  $('#btnSaveSettings').addEventListener('click', () => {
    const cid = $('#clientId').value.trim();
    if (cid !== (ls.get('clientId') || '')) { clearToken(); tokenClient = null; }
    ls.set('clientId', cid);
    const key = $('#mapsKey').value.trim();
    const keyChanged = key !== (ls.get('mapsKey') || '');
    ls.set('mapsKey', key);
    const wasOn = syncOn();
    ls.set('sync', $('#syncToggle').checked ? '1' : '0');
    renderSyncBar();
    if (syncOn() && !wasOn) sync(true);
    if (keyChanged && gmapsPromise) toast('Reload the app to use the new Maps key.', 5000);
    else if (keyChanged && view === 'map') renderMap();
  });
  $('#btnSync').onclick = () => sync(true);
  $('#btnExport').onclick = () => exportAll().catch(err => { $('#settingsMsg').textContent = err.message; });
  $('#btnImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { $('#settingsMsg').textContent = `Imported ${await importAll(f)} entries.`; }
    catch (err) { $('#settingsMsg').textContent = err.message; }
    e.target.value = '';
  };

  window.addEventListener('beforeunload', () => { if (cur) collect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow().then(() => queueSync(0));
    else queueSync(300);
  });
  window.addEventListener('online', () => queueSync(500));
  // A sign-in that finished in another window of the app: pick it up and sync.
  window.addEventListener('storage', e => {
    if (e.key !== 'gtoken' || !loadStoredToken()) return;
    authLog('picked up sign-in from another window');
    toast('Signed in to Google.', 2500);
    if (syncOn()) sync(true);
  });
  setInterval(() => { if (!document.hidden) queueSync(0); }, 5 * 60 * 1000);
}

/* ===================== boot ===================== */
(async function init() {
  // Handle a returning Google sign-in first, before anything that waits, so it's never lost.
  let signIn = null;
  try { signIn = finishRedirectSignIn(); }
  catch (err) { authLog('sign-in handling failed: ' + err.message); signIn = { error: 'Sign-in failed: ' + err.message }; }
  wire();
  let all = [];
  try { all = await dbAll('entries'); }
  catch (err) { authLog('could not open storage: ' + err.message); toast('Could not open the journal’s storage: ' + err.message, 0); }
  for (const e of all) {
    if (e.deleted) tombs.set(e.id, e); else cache.set(e.id, norm(e));
  }
  authLog(`loaded ${cache.size} entries`);
  renderSyncBar();
  await route();
  if (signIn && signIn.outside) {
    // The app window picks up the sign-in and syncs on its own; this extra window just needs closing.
    toast('Signed in! Close this window to go back to the Journal app.', 0);
  } else {
    if (signIn && signIn.error) toast(signIn.error, 7000);
    else if (signIn && signIn.after === 'sync') sync(true);
    else if (signIn) toast('Signed in to Google. Tap the button again to continue.', 5000);
    if (syncOn() && !(signIn && signIn.after === 'sync')) sync(false);
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => { reg.update().catch(() => {}); })
      .catch(() => {});
    // When a new version takes over, reload once (unless you're mid-entry, then just say so).
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController || reloaded) return;
      if (view === 'entry') { toast('App updated. It will refresh next time you open it.', 5000); return; }
      reloaded = true;
      await saveNow();
      location.reload();
    });
  }
})();
