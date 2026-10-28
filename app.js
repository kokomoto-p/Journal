'use strict';

/* ===================== helpers ===================== */
const $ = s => document.querySelector(s);
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const MOODS = ['😞', '🙁', '😐', '🙂', '😄'];

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmt(d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const hideToast = () => { $('#toast').hidden = true; };

/* ===================== IndexedDB ===================== */
const dbp = new Promise((resolve, reject) => {
  const rq = indexedDB.open('journal', 1);
  rq.onupgradeneeded = () => {
    const db = rq.result;
    db.createObjectStore('entries', { keyPath: 'id' });
    db.createObjectStore('photos', { keyPath: 'id' });
  };
  rq.onsuccess = () => resolve(rq.result);
  rq.onerror = () => reject(rq.error);
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
let cur = null;                   // entry being edited
let currentDate = fmt(new Date());
let viewMonth = { y: new Date().getFullYear(), m: new Date().getMonth() };
let photoUrls = [];                // object URLs to revoke on date change

const blankEntry = date => ({
  id: date, date, title: '', html: '', text: '', mood: 0, tags: [],
  events: [], photoIds: [], created: null, updated: null,
});
const isEmpty = e => !e.title.trim() && !e.text.trim() && !e.mood && !e.tags.length && !e.events.length && !e.photoIds.length;

/* ===================== saving ===================== */
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  editCounter++;
  $('#status').textContent = 'Saving…';
  saveTimer = setTimeout(() => saveNow(), 500);
}
function collect() {
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
  if (!changed && !hadPending) return;     // nothing new; don't bump timestamps
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
  if (!fromSync) queueSync();
  renderCalendar();
  renderOnThisDay();
  if ($('#search').value.trim()) renderSearch();
}

/* ===================== navigation / render ===================== */
async function goTo(date) {
  await saveNow();
  currentDate = date;
  const d = parseDate(date);
  viewMonth = { y: d.getFullYear(), m: d.getMonth() };
  cur = structuredClone(cache.get(date) || blankEntry(date));
  await renderEntry();
  renderCalendar();
  renderOnThisDay();
  $('#side').classList.remove('open');
}

async function renderEntry() {
  $('#dateLabel').textContent = parseDate(currentDate).toLocaleDateString(undefined,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  $('#title').value = cur.title;
  $('#editor').innerHTML = cur.html;
  $('#tags').value = cur.tags.join(', ');
  $('#status').textContent = '';
  $('#eventPicker').hidden = true;
  renderMood();
  renderEvents();
  await renderPhotos();
}

function renderMood() {
  $('#mood').innerHTML = MOODS.map((m, i) =>
    `<button type="button" role="radio" aria-checked="${cur.mood === i + 1}" class="${cur.mood === i + 1 ? 'on' : ''}" data-m="${i + 1}">${m}</button>`
  ).join('');
}

function renderCalendar() {
  const { y, m } = viewMonth;
  $('#monthLabel').textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const todayStr = fmt(new Date());
  let html = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const s = fmt(d);
    const cls = ['day',
      d.getMonth() !== m ? 'other' : '',
      cache.has(s) ? 'has' : '',
      s === todayStr ? 'today' : '',
      s === currentDate ? 'sel' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" data-date="${s}">${d.getDate()}</div>`;
  }
  $('#cal').innerHTML = html;
}

function snippet(e) {
  const t = e.title || e.text || '(photos / events only)';
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function entryCard(e, label) {
  return `<li class="entry-link" data-date="${e.date}">${esc(snippet(e))}<small>${esc(label)}</small></li>`;
}

function renderOnThisDay() {
  const md = currentDate.slice(5);
  const list = [...cache.values()]
    .filter(e => e.date.slice(5) === md && e.date !== currentDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#otdList').innerHTML = list.length
    ? list.map(e => entryCard(e, e.date.slice(0, 4))).join('')
    : '<li class="empty">No entries from past years on this date.</li>';
}

function renderSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#results');
  if (!q) { box.hidden = true; $('#calWrap').hidden = false; $('#otd').hidden = false; return; }
  box.hidden = false; $('#calWrap').hidden = true; $('#otd').hidden = true;
  const tagQ = q.startsWith('#') ? q.slice(1) : null;
  const hits = [...cache.values()].filter(e => tagQ !== null
    ? e.tags.some(t => t.toLowerCase().includes(tagQ))
    : (e.title + ' ' + e.text + ' ' + e.tags.join(' ') + ' ' + e.events.map(v => v.summary).join(' ')).toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));
  box.innerHTML = `<h3>${hits.length} result${hits.length === 1 ? '' : 's'}</h3><ul>` +
    hits.slice(0, 100).map(e => entryCard(e, e.date)).join('') + '</ul>';
}

/* ===================== Google auth ===================== */
let tokenClient = null, token = null, tokenExp = 0, pending = null;
try {   // access tokens last ~1 hour; keep it across reloads so background sync works
  const s = JSON.parse(localStorage.getItem('gtoken') || 'null');
  if (s && s.exp > Date.now() + 60000) { token = s.t; tokenExp = s.exp; }
} catch (_) { /* ignore */ }
function clearToken() { token = null; tokenExp = 0; try { localStorage.removeItem('gtoken'); } catch (_) { /* ignore */ } }

function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    if (token && Date.now() < tokenExp - 60000) return resolve(token);
    if (!interactive) { const e = new Error('Sign-in needed'); e.code = 'NEED_AUTH'; return reject(e); }
    const cid = localStorage.getItem('clientId');
    if (!cid) { openSettings(); return reject(new Error('Add your Google client ID in Settings first.')); }
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
          token = r.access_token; tokenExp = Date.now() + Number(r.expires_in) * 1000;
          try { localStorage.setItem('gtoken', JSON.stringify({ t: token, exp: tokenExp })); } catch (_) { /* ignore */ }
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
    tokenClient.requestAccessToken();
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

/* ===================== Calendar ===================== */
function eventTime(ev) {
  if (ev.allDay) return 'All day';
  const f = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ev.end ? `${f(ev.start)} – ${f(ev.end)}` : f(ev.start);
}

function renderEvents() {
  $('#eventList').innerHTML = cur.events.length
    ? cur.events.map((ev, i) =>
      `<li><div>${esc(ev.summary)}<small>${esc(eventTime(ev))}${ev.location ? ' · ' + esc(ev.location) : ''}</small></div>
       <button type="button" class="x" data-i="${i}" aria-label="Remove event">&times;</button></li>`).join('')
    : '';
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
    toast(err.message, 6000);
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
    const unrelated = cur.events.filter(e => !items.some(i => i.id === e.id)); // keep anything not in today's fetch
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
  for (const id of cur.photoIds) {
    const rec = await dbGet('photos', id);
    if (!rec) continue;
    const url = URL.createObjectURL(rec.blob);
    photoUrls.push(url);
    const div = document.createElement('div');
    div.className = 'photo';
    div.innerHTML = `<img alt="" src="${url}"><button type="button" class="x" data-id="${esc(id)}" aria-label="Remove photo">&times;</button>`;
    grid.appendChild(div);
  }
}

async function pickPhotos() {
  const btn = $('#btnPhotos');
  // Open the tab synchronously (inside the click) so popup blockers allow it.
  const win = window.open('', '_blank');
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
    // Clean up the session (best effort).
    gfetch('https://photospicker.googleapis.com/v1/sessions/' + session.id, { method: 'DELETE' }, 'none').catch(() => {});

    await renderPhotos();
    scheduleSave();
    toast(`Added ${added} photo${added === 1 ? '' : 's'}${skipped ? ` (${skipped} video${skipped === 1 ? '' : 's'} skipped)` : ''}.`);
  } catch (err) {
    if (win && !win.closed && win.location.href === 'about:blank') win.close();
    toast(err.message, 7000);
  } finally {
    btn.disabled = false;
  }
}

/* ===================== Google Drive sync (appDataFolder) =====================
   One Drive file per entry ("entry-YYYY-MM-DD.json", appProperties.updated = ms timestamp)
   and one per photo ("photo-<id>"). Newest edit of an entry wins. Deleted entries are kept
   as small tombstones so the delete reaches other devices. */
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';
const syncOn = () => { try { return localStorage.getItem('sync') === '1'; } catch (_) { return false; } };
let syncing = false, syncAgain = false, syncTimer = null;

function setSyncStatus(s) { $('#syncStatus').textContent = s; }
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
  syncing = true;
  clearTimeout(syncTimer);
  setSyncStatus('Syncing…');
  try {
    await saveNow(true);
    const editsAtStart = editCounter;
    const files = await listRemote(interactive);
    const rEntries = new Map(), rPhotos = new Map();
    for (const f of files) {
      if (f.name.startsWith('entry-') && f.name.endsWith('.json')) rEntries.set(f.name.slice(6, -5), f);
      else if (f.name.startsWith('photo-')) rPhotos.set(f.name.slice(6), f);
    }
    const remoteUpdated = f => Number(f?.appProperties?.updated || 0);

    // 1. Pull entries that are newer on Drive.
    let curChanged = false, pulled = 0, pushed = 0;
    for (const [id, f] of rEntries) {
      const local = cache.get(id) || tombs.get(id);
      if (local && remoteUpdated(f) <= (local.updated || 0)) continue;
      const e = await gfetch(`${DRIVE}/${f.id}?alt=media`, {}, 'json', interactive);
      if (e.deleted) { cache.delete(id); tombs.set(id, e); }
      else { tombs.delete(id); cache.set(id, e); }
      await dbPut('entries', e);
      pulled++;
      if (id === cur.id) curChanged = true;
    }

    // 2. Photos: download ones we're missing, upload ones Drive is missing.
    const needed = new Set();
    for (const e of cache.values()) (e.photoIds || []).forEach(p => needed.add(p));
    const localPhotos = new Set(await tx('photos', 'readonly', s => s.getAllKeys()));
    for (const pid of needed) {
      if (localPhotos.has(pid) || !rPhotos.has(pid)) continue;
      const f = rPhotos.get(pid), ap = f.appProperties || {};
      const blob = await gfetch(`${DRIVE}/${f.id}?alt=media`, {}, 'blob', interactive);
      await dbPut('photos', { id: pid, blob, name: ap.name || '', mime: ap.mime || blob.type, takenAt: ap.takenAt || null });
      localPhotos.add(pid);
    }
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
    }

    // 4. Refresh the screen if the entry on screen changed elsewhere and you haven't typed since.
    if (curChanged && editCounter === editsAtStart) {
      cur = structuredClone(cache.get(cur.id) || blankEntry(cur.id));
      await renderEntry();
    }

    // 5. Tidy up photos no entry uses any more (remote only after a day, to be safe across devices).
    const keep = new Set([...needed, ...(cur.photoIds || [])]);
    for (const [pid, f] of rPhotos) {
      if (!keep.has(pid) && Date.now() - Date.parse(f.modifiedTime || 0) > 864e5) {
        gfetch(`${DRIVE}/${f.id}`, { method: 'DELETE' }, 'none', interactive).catch(() => {});
      }
    }
    for (const pid of localPhotos) if (!keep.has(pid)) await dbDel('photos', pid);
    renderCalendar(); renderOnThisDay();
    if ($('#search').value.trim()) renderSearch();
    const when = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    setSyncStatus(`Synced ${when}`);
    if (interactive && (pulled || pushed)) toast(`Synced: ${pulled} down, ${pushed} up.`);
  } catch (err) {
    if (err.code === 'NEED_AUTH') setSyncStatus('Tap Sync now to sign in');
    else {
      setSyncStatus('Sync failed');
      console.warn('sync', err);
      if (interactive) toast(err.message, 7000);
    }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(1000); }
  }
}

/* ===================== export / import ===================== */
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataUrlToBlob = async u => (await fetch(u)).blob();

async function exportAll() {
  await saveNow();
  const entries = [...cache.values()];
  const photos = await dbAll('photos');
  const out = {
    version: 1, exportedAt: new Date().toISOString(), entries,
    photos: await Promise.all(photos.map(async p => ({ id: p.id, name: p.name, mime: p.mime, takenAt: p.takenAt, data: await blobToDataUrl(p.blob) }))),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `journal-export-${fmt(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importAll(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.entries)) throw new Error('Not a journal export file.');
  for (const p of data.photos || []) await dbPut('photos', { id: p.id, name: p.name, mime: p.mime, takenAt: p.takenAt, blob: await dataUrlToBlob(p.data) });
  for (const e of data.entries) { tombs.delete(e.id); cache.set(e.id, e); await dbPut('entries', e); }
  cur = structuredClone(cache.get(currentDate) || blankEntry(currentDate));
  await renderEntry(); renderCalendar(); renderOnThisDay();
  queueSync(500);
  return data.entries.length;
}

/* ===================== settings ===================== */
function openSettings() {
  $('#clientId').value = localStorage.getItem('clientId') || '';
  $('#syncToggle').checked = syncOn();
  $('#settingsMsg').textContent = '';
  const d = $('#settings');
  if (!d.open) d.showModal();
}

/* ===================== wiring ===================== */
function wire() {
  $('#title').addEventListener('input', scheduleSave);
  $('#tags').addEventListener('input', scheduleSave);
  $('#editor').addEventListener('input', scheduleSave);
  $('#editor').addEventListener('paste', e => {          // paste as plain text
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  $('#toolbar').addEventListener('mousedown', e => e.preventDefault());   // keep editor selection
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

  $('#cal').addEventListener('click', e => { const d = e.target.closest('.day'); if (d) goTo(d.dataset.date); });
  const listClick = e => { const li = e.target.closest('[data-date]'); if (li) { $('#search').value = ''; renderSearch(); goTo(li.dataset.date); } };
  $('#otdList').addEventListener('click', listClick);
  $('#results').addEventListener('click', listClick);
  $('#search').addEventListener('input', renderSearch);

  $('#prevMonth').onclick = () => { viewMonth.m--; if (viewMonth.m < 0) { viewMonth.m = 11; viewMonth.y--; } renderCalendar(); };
  $('#nextMonth').onclick = () => { viewMonth.m++; if (viewMonth.m > 11) { viewMonth.m = 0; viewMonth.y++; } renderCalendar(); };
  $('#btnToday').onclick = () => goTo(fmt(new Date()));
  $('#prevDay').onclick = () => goTo(addDays(currentDate, -1));
  $('#nextDay').onclick = () => goTo(addDays(currentDate, 1));
  $('#btnMenu').onclick = () => $('#side').classList.toggle('open');

  $('#btnEvents').onclick = loadEvents;
  $('#eventList').addEventListener('click', e => {
    const b = e.target.closest('.x'); if (!b) return;
    cur.events.splice(Number(b.dataset.i), 1);
    renderEvents(); scheduleSave();
  });

  $('#btnPhotos').onclick = pickPhotos;
  $('#photoGrid').addEventListener('click', async e => {
    const x = e.target.closest('.x');
    if (x) {
      cur.photoIds = cur.photoIds.filter(id => id !== x.dataset.id);
      await dbDel('photos', x.dataset.id);
      await renderPhotos(); scheduleSave();
      return;
    }
    const img = e.target.closest('img');
    if (img) { $('#lightImg').src = img.src; $('#lightbox').showModal(); }
  });

  $('#btnSettings').onclick = openSettings;
  $('#btnSaveSettings').addEventListener('click', () => {
    const cid = $('#clientId').value.trim();
    if (cid !== (localStorage.getItem('clientId') || '')) { clearToken(); tokenClient = null; }
    localStorage.setItem('clientId', cid);
    const wasOn = syncOn();
    localStorage.setItem('sync', $('#syncToggle').checked ? '1' : '0');
    renderSyncBar();
    if (syncOn() && !wasOn) sync(true);     // first sync right away (inside the click, so sign-in can pop up)
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

  window.addEventListener('beforeunload', () => { if (cur) { collect(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow().then(() => queueSync(0));
    else queueSync(300);                          // pick up changes from other devices when you come back
  });
  window.addEventListener('online', () => queueSync(500));
  setInterval(() => { if (!document.hidden) queueSync(0); }, 5 * 60 * 1000);
}

/* ===================== boot ===================== */
(async function init() {
  wire();
  for (const e of await dbAll('entries')) (e.deleted ? tombs : cache).set(e.id, e);
  cur = structuredClone(cache.get(currentDate) || blankEntry(currentDate));
  await renderEntry();
  renderCalendar();
  renderOnThisDay();
  renderSyncBar();
  if (syncOn()) sync(false);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
