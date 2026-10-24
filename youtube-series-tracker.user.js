// ==UserScript==
// @name         YouTube Series Tracker
// @namespace    https://github.com/GraveEaterMadison/youtube-series-tracker
// @version      2.2.2
// @description  Build YouTube series from playlists or add individual videos, with automatic default series names, local progress, watched status, history matching, and optional auto-next.
// @author       Zero
// @license      MIT
// @homepageURL  https://github.com/GraveEaterMadison/youtube-series-tracker
// @supportURL   https://github.com/GraveEaterMadison/youtube-series-tracker/issues
// @compatible   firefox
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = 2;
  const KEY = 'yt-series-tracker-v2';
  const LEGACY_KEYS = ['yt-series-tracker-v1'];
  const PANEL = 'yst2-panel';
  const STYLE = 'yst2-style';
  const BTN = 'yst2-button';
  const PLAYER_BTN = 'yst2-player-button';
  const AUTO_WATCHED_DEFAULT = 0.90;
  const SAVE_MS = 2000;
  const AUTO_SYNC_KEY = 'yst2-last-sync';
  let db = loadDB();
  let activeTab = 'library';
  let currentVideoId = '';
  let activeVideo = null;
  let tickTimer = null;
  let routeTimer = null;
  let lastSave = 0;
  let syncBusy = false;
  let currentHistoryScan = '';
  const listenerVideos = new WeakSet();

  function emptyDB() {
    return {
      version: VERSION,
      settings: {
        watchedThreshold: AUTO_WATCHED_DEFAULT,
        autoNext: false,
        autoSyncOnOpen: true,
        showSidebarButton: true,
        historyScan: true
      },
      series: [],
      episodes: {},
      history: {},
      lastSync: 0
    };
  }
  function loadDB() {
    try {
      let raw = localStorage.getItem(KEY);
      if (!raw) {
        for (const k of LEGACY_KEYS) {
          const old = localStorage.getItem(k);
          if (old) { raw = old; break; }
        }
      }
      const p = raw ? JSON.parse(raw) : {};
      const base = emptyDB();
      return {
        ...base, ...p,
        settings: { ...base.settings, ...(p.settings || {}) },
        series: Array.isArray(p.series) ? p.series : [],
        episodes: p.episodes && typeof p.episodes === 'object' ? p.episodes : {},
        history: p.history && typeof p.history === 'object' ? p.history : {}
      };
    } catch (_) { return emptyDB(); }
  }
  function saveDB() {
    try {
      db.version = VERSION;
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) { console.warn('[YouTube Series] Storage failed', e); toast('Could not save: browser storage may be full. Export a backup.'); }
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text = n => (n?.textContent || '').replace(/\s+/g, ' ').trim();
  const urlFor = (id, list, index, time) => {
    const u = new URL('/watch', location.origin); u.searchParams.set('v', id);
    if (list) u.searchParams.set('list', list);
    if (Number.isFinite(index) && index >= 0) u.searchParams.set('index', String(index + 1));
    if (Number.isFinite(time) && time > 3) u.searchParams.set('t', String(Math.floor(time)));
    return u.toString();
  };
  function getVideoId(url = location.href) {
    try {
      const u = new URL(url, location.origin);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || '';
      return '';
    } catch (_) { return ''; }
  }
  function getPlaylistId(url = location.href) {
    try { return new URL(url, location.origin).searchParams.get('list') || ''; } catch (_) { return ''; }
  }
  function parseDuration(v) {
    if (typeof v === 'number') return v;
    const s = String(v || '').trim();
    if (/^\d+$/.test(s)) return Number(s);
    const a = s.split(':').map(Number);
    if (!a.length || a.some(n => !Number.isFinite(n))) return 0;
    return a.reduce((n, part) => n * 60 + part, 0);
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
  }
  function videoTitle() {
    return text(document.querySelector('h1.ytd-watch-metadata yt-formatted-string')) ||
      text(document.querySelector('h1.title')) || document.title.replace(/\s+-\s+YouTube$/, '') || 'Untitled video';
  }
  function videoMeta() {
    const id = getVideoId();
    if (!id) return null;
    const v = document.querySelector('video');
    return { id, title: videoTitle(), duration: Number.isFinite(v?.duration) ? v.duration : 0,
      url: `https://www.youtube.com/watch?v=${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }
  function stateFor(id) {
    return db.episodes[id] || { watched: false, position: 0, duration: 0, title: '', updatedAt: 0, lastWatchedAt: 0 };
  }
  function setState(id, patch, persist = true) {
    const old = stateFor(id);
    const next = { ...old, ...patch, updatedAt: Date.now() };
    if (patch.watched === true && !old.watched) next.lastWatchedAt = Date.now();
    db.episodes[id] = next;
    if (persist) saveDB();
  }
  function getInitialData() {
    return window.ytInitialData || window.ytInitialPlayerResponse?.responseContext?.serviceTrackingParams && window.ytInitialData || null;
  }
  function getApiKey() {
    try { return window.ytcfg?.get?.('INNERTUBE_API_KEY') || window.ytcfg?.data_?.INNERTUBE_API_KEY || ''; }
    catch (_) { return ''; }
  }
  function getClientContext() {
    try {
      const c = window.ytcfg?.get?.('INNERTUBE_CONTEXT') || window.ytcfg?.data_?.INNERTUBE_CONTEXT;
      if (c) return c;
    } catch (_) {}
    return { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00', hl: 'en', gl: 'IN' } };
  }
  function walk(obj, fn) {
    if (!obj || typeof obj !== 'object') return;
    fn(obj);
    if (Array.isArray(obj)) { for (const x of obj) walk(x, fn); return; }
    for (const k of Object.keys(obj)) walk(obj[k], fn);
  }
  function videoFromRenderer(r) {
    const v = r?.playlistVideoRenderer || r?.playlistPanelVideoRenderer;
    if (!v?.videoId) return null;
    const title = v.title?.runs?.map(x => x.text).join('') || v.title?.simpleText || 'Untitled episode';
    const length = v.lengthSeconds ? Number(v.lengthSeconds) : parseDuration(v.lengthText?.simpleText);
    const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
    return { id: v.videoId, title, duration: length || 0, thumb, url: `https://www.youtube.com/watch?v=${v.videoId}` };
  }
  function findPlaylistRenderer(data) {
    const out = [];
    walk(data, o => {
      const ep = videoFromRenderer(o);
      if (ep && !out.some(x => x.id === ep.id)) out.push(ep);
    });
    return out;
  }
  function titleFromData(data) {
    let title = '';
    walk(data, o => {
      if (title) return;
      const h = o.playlistMetadataRenderer?.title || o.playlistSidebarPrimaryInfoRenderer?.title?.runs?.map(x=>x.text).join('');
      if (h) title = h;
    });
    return title;
  }
  function continuationToken(data) {
    let token = '';
    walk(data, o => {
      if (token) return;
      if (o.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token)
        token = o.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    });
    return token;
  }
  function playlistTitleFromDOM() {
    return text(document.querySelector('ytd-playlist-header-renderer #title')) ||
      text(document.querySelector('ytd-playlist-header-renderer h1')) ||
      text(document.querySelector('ytd-playlist-sidebar-primary-info-renderer h1')) ||
      document.title.replace(/\s+-\s+YouTube$/, '').trim() || 'YouTube playlist';
  }
  function domPlaylistItems() {
    const out = [], seen = new Set();
    const selectors = 'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-rich-item-renderer, ytd-video-renderer';
    for (const node of document.querySelectorAll(selectors)) {
      const a = node.querySelector('a#video-title, a#thumbnail[href*="watch"], a[href*="/watch?v="]');
      if (!a) continue;
      let u; try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
      const id = u.searchParams.get('v');
      if (!id || seen.has(id)) continue;
      if (location.pathname === '/watch' && !node.closest('ytd-playlist-panel-renderer') && !node.matches('ytd-playlist-video-renderer')) continue;
      seen.add(id);
      const title = text(node.querySelector('#video-title')) || a.title || 'Untitled episode';
      const durationNode = node.querySelector('ytd-thumbnail-overlay-time-status-renderer, #overlays #text');
      out.push({ id, title, duration: parseDuration(text(durationNode)), thumb: node.querySelector('img')?.src || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${id}` });
    }
    return out;
  }
  async function fetchFullPlaylist(listId) {
    if (!listId) throw new Error('Open a playlist URL containing list= first.');
    const data = getInitialData();
    let items = data ? findPlaylistRenderer(data) : [];
    // YouTube's playlist renderer may be nested inside initial data; include currently-rendered items too.
    const dom = domPlaylistItems();
    const seen = new Set(items.map(x => x.id));
    for (const ep of dom) if (!seen.has(ep.id)) { items.push(ep); seen.add(ep.id); }
    let token = data ? continuationToken(data) : '';
    const key = getApiKey();
    let pages = 0;
    while (token && key && pages < 60) {
      pages++;
      const response = await fetch(`/youtubei/v1/browse?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': getClientContext().client?.clientVersion || '2.20260101.00.00' },
        body: JSON.stringify({ context: getClientContext(), continuation: token })
      });
      if (!response.ok) throw new Error(`YouTube playlist request failed (${response.status}).`);
      const next = await response.json();
      for (const ep of findPlaylistRenderer(next)) {
        if (!seen.has(ep.id)) { items.push(ep); seen.add(ep.id); }
      }
      token = continuationToken(next);
      if (!findPlaylistRenderer(next).length && token && pages > 3) break;
    }
    // Preserve YouTube order as provided by the playlist renderer.
    return { items, title: titleFromData(data) || playlistTitleFromDOM(), pages };
  }
  function findSeries(id) {
    if (!id) return undefined;
    return db.series.find(s => (s.playlistId && s.playlistId === id) || s.id === id);
  }
  function mergeSeries(listId, title, items) {
    let series = findSeries(listId);
    if (!series) {
      series = { id: listId, playlistId: listId, title: title || 'YouTube playlist', episodes: [], addedAt: Date.now(), updatedAt: Date.now() };
      db.series.unshift(series);
    }
    const old = new Map(series.episodes.map((e, i) => [e.id, { ...e, order: Number.isFinite(e.order) ? e.order : i }]));
    const merged = [];
    items.forEach((ep, i) => {
      const prev = old.get(ep.id);
      const next = { ...prev, ...ep, order: i };
      merged.push(next);
      const st = stateFor(ep.id);
      setState(ep.id, { title: ep.title || st.title, duration: ep.duration || st.duration }, false);
    });
    // Keep previously-known items that may be unavailable/removed, at the end.
    for (const [id, ep] of old) if (!merged.some(x => x.id === id)) merged.push({ ...ep, order: merged.length, unavailable: ep.manuallyAdded ? false : true });
    series.title = title || series.title;
    series.episodes = merged;
    series.updatedAt = Date.now();
    series.lastSyncedAt = Date.now();
    db.lastSync = Date.now();
    saveDB();
    return series;
  }
  async function syncCurrentPlaylist() {
    const id = getPlaylistId();
    if (!id) { toast('Open a YouTube playlist first.'); return; }
    if (syncBusy) return;
    syncBusy = true; toast('Syncing the full playlist…');
    try {
      const { items, title, pages } = await fetchFullPlaylist(id);
      if (!items.length) throw new Error('No playlist episodes found. Wait for YouTube to finish loading and try again.');
      const s = mergeSeries(id, title, items);
      renderPanel();
      toast(`Synced “${s.title}” · ${s.episodes.length} episodes${pages ? ` · ${pages} continuation pages` : ''}`);
    } catch (e) {
      console.error('[YouTube Series] playlist sync failed', e);
      const dom = domPlaylistItems();
      if (dom.length) {
        const s = mergeSeries(id, playlistTitleFromDOM(), dom);
        renderPanel(); toast(`Partial sync: ${s.episodes.length} loaded episodes. Full sync failed: ${e.message}`);
      } else toast(e.message || 'Playlist sync failed.');
    } finally { syncBusy = false; }
  }
  function stats(s) {
    const eps = s.episodes || [];
    const watched = eps.filter(e => stateFor(e.id).watched).length;
    const active = eps.filter(e => !stateFor(e.id).watched && stateFor(e.id).position > 5).length;
    const left = eps.reduce((n,e) => { const st=stateFor(e.id); return n + (st.watched ? 0 : Math.max(0,(st.duration||e.duration||0)-(st.position||0))); },0);
    return { total: eps.length, watched, active, pct: eps.length ? Math.round(watched/eps.length*100) : 0, left };
  }
  function progress(e) {
    const st = stateFor(e.id);
    if (st.watched) return 100;
    const d = st.duration || e.duration || 0;
    return d ? Math.max(0, Math.min(99, st.position / d * 100)) : 0;
  }
  function chooseContinue(s) {
    const eps = [...(s.episodes || [])].sort((a,b) => a.order-b.order);
    return eps.find(e => !stateFor(e.id).watched && stateFor(e.id).position > 5) ||
      eps.find(e => !stateFor(e.id).watched) || null;
  }
  function chooseNext(s, id) {
    const eps = [...(s.episodes || [])].sort((a,b) => a.order-b.order);
    const idx = eps.findIndex(e => e.id === id);
    if (idx >= 0) return eps.slice(idx+1).find(e => !stateFor(e.id).watched) || null;
    return chooseContinue(s);
  }
  function openEpisode(s, e, resume = true) {
    if (!s || !e) return;
    const st = stateFor(e.id);
    location.href = urlFor(e.id, s.playlistId, s.playlistId ? e.order : undefined, resume && !st.watched ? st.position : 0);
  }
  function markEpisode(id, watched) {
    const st = stateFor(id);
    setState(id, { watched, position: watched ? (st.duration || st.position) : 0 });
    renderPanel();
  }
  function episodeHTML(s,e) {
    const st = stateFor(e.id), p = progress(e);
    const status = st.watched ? 'Watched' : st.position > 5 ? `${Math.round(p)}% watched · ${fmt(st.position)} / ${fmt(st.duration || e.duration)}` : 'Not watched';
    return `<article class="yst2-ep ${st.watched?'is-watched':''}">
      <img class="yst2-thumb" loading="lazy" src="${esc(e.thumb || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`)}">
      <div class="yst2-epbody"><button class="yst2-epname" data-play="${esc(e.id)}" data-sid="${esc(s.id)}">${esc(e.title || st.title || e.id)}</button>
      <div class="yst2-muted">${esc(status)}${(st.duration||e.duration)?` · ${fmt(st.duration||e.duration)}`:''}</div>
      <div class="yst2-bar"><i style="width:${p}%"></i></div></div>
      <button class="yst2-mark ${st.watched?'checked':''}" data-mark="${esc(e.id)}" title="${st.watched?'Mark unwatched':'Mark watched'}">${st.watched?'✓':'○'}</button>
    </article>`;
  }
  function saveVideoToSeries(series, meta) {
    if (!series || !meta) return false;
    if (series.episodes.some(ep => ep.id === meta.id)) {
      toast('This video is already in "' + series.title + '".');
      return false;
    }
    const order = series.episodes.reduce((max, ep) => Math.max(max, Number.isFinite(ep.order) ? ep.order : -1), -1) + 1;
    series.episodes.push({ ...meta, order, manuallyAdded: true });
    series.updatedAt = Date.now();
    const old = stateFor(meta.id);
    setState(meta.id, { title: meta.title || old.title, duration: meta.duration || old.duration });
    saveDB();
    document.getElementById('yst2-add-video-dialog')?.remove();
    renderPanel();
    toast('Added "' + meta.title + '" to "' + series.title + '".');
    return true;
  }

  function defaultManualSeriesName() {
    const names = new Set(db.series.map(series => String(series.title || '').trim().toLocaleLowerCase()));
    if (!names.has('new series')) return 'New Series';
    let suffix = 2;
    while (names.has(('New Series ' + suffix).toLocaleLowerCase())) suffix++;
    return 'New Series ' + suffix;
  }

  function createManualSeries(title, meta) {
    const cleanTitle = String(title || '').trim() || defaultManualSeriesName();
    if (!meta) {
      toast('Open a YouTube video before creating a series.');
      return false;
    }
    let id = 'manual-' + Date.now().toString(36) + '-' + meta.id;
    while (db.series.some(series => series.id === id)) id += '-x';
    const series = {
      id: id,
      playlistId: null,
      manual: true,
      title: cleanTitle,
      episodes: [],
      addedAt: Date.now(),
      updatedAt: Date.now()
    };
    db.series.unshift(series);
    series.episodes.push({ ...meta, order: 0, manuallyAdded: true });
    const old = stateFor(meta.id);
    setState(meta.id, { title: meta.title || old.title, duration: meta.duration || old.duration });
    saveDB();
    document.getElementById('yst2-add-video-dialog')?.remove();
    renderPanel();
    toast('Created "' + cleanTitle + '" with its first video.');
    return true;
  }

  function showAddVideoDialog() {
    const meta = videoMeta();
    if (!meta) {
      toast('Open a YouTube video first, then add it to a series.');
      return;
    }
    const panel = document.getElementById(PANEL);
    if (!panel) return;
    panel.querySelector('#yst2-add-video-dialog')?.remove();
    const options = db.series.map(series =>
      '<option value="' + esc(series.id) + '">' + esc(series.title) + ' (' + series.episodes.length + ' videos)</option>'
    ).join('');
    const modal = document.createElement('div');
    modal.id = 'yst2-add-video-dialog';
    modal.className = 'yst2-modal-backdrop';
    modal.innerHTML =
      '<section class="yst2-modal" role="dialog" aria-modal="true" aria-labelledby="yst2-dialog-title">' +
        '<header class="yst2-modal-head">' +
          '<div><h3 id="yst2-dialog-title">Add video to a series</h3>' +
          '<p class="yst2-muted">Add this video now, then repeat from other videos to build your own order.</p></div>' +
          '<button type="button" id="yst2-dialog-close" class="yst2-icon" aria-label="Close">×</button>' +
        '</header>' +
        '<div class="yst2-current-video"><img src="' + esc(meta.thumb) + '" alt="">' +
          '<div><strong>' + esc(meta.title) + '</strong><span>Current YouTube video</span></div></div>' +
        '<label class="yst2-dialog-label" for="yst2-existing-series">Add to an existing series</label>' +
        '<select id="yst2-existing-series" class="yst2-dialog-select">' +
          '<option value="">Choose a series…</option>' + options +
        '</select>' +
        '<button type="button" id="yst2-add-existing" class="yst2-mainbtn" disabled>Add video to selected series</button>' +
        '<div class="yst2-modal-or"><span>or create a new series</span></div>' +
        '<label class="yst2-dialog-label" for="yst2-new-series-title">New series name</label>' +
        '<input id="yst2-new-series-title" class="yst2-dialog-input" type="text" maxlength="160" placeholder="Optional — defaults to New Series">' +
        '<button type="button" id="yst2-create-series" class="yst2-mainbtn">Create series with this video</button>' +
        (getPlaylistId() ? '<button type="button" id="yst2-dialog-sync-playlist" class="yst2-subbtn">Sync the entire current playlist instead</button>' : '') +
        '<button type="button" id="yst2-dialog-cancel" class="yst2-subbtn yst2-dialog-cancel">Cancel</button>' +
      '</section>';
    panel.appendChild(modal);

    const select = modal.querySelector('#yst2-existing-series');
    const addButton = modal.querySelector('#yst2-add-existing');
    const titleInput = modal.querySelector('#yst2-new-series-title');
    select.addEventListener('change', () => { addButton.disabled = !select.value; });
    addButton.addEventListener('click', () => {
      const series = db.series.find(item => item.id === select.value);
      saveVideoToSeries(series, meta);
    });
    modal.querySelector('#yst2-create-series').addEventListener('click', () => {
      createManualSeries(titleInput.value, meta);
    });
    modal.querySelector('#yst2-dialog-sync-playlist')?.addEventListener('click', () => {
      modal.remove();
      activeTab = 'library';
      syncCurrentPlaylist();
    });
    const close = () => modal.remove();
    modal.querySelector('#yst2-dialog-close').addEventListener('click', close);
    modal.querySelector('#yst2-dialog-cancel').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    titleInput.focus();
  }

  function seriesHTML(s) {
    const st = stats(s), cont = chooseContinue(s);
    return `<section class="yst2-series">
      <header class="yst2-serieshead"><div class="yst2-seriestitle">${esc(s.title)}</div>
      ${s.playlistId ? '<button class="yst2-icon" data-sync="${esc(s.id)}" title="Refresh entire playlist">↻</button>' : '<span class="yst2-manual-label">Manual series</span>'}
      <button class="yst2-icon" data-edit="${esc(s.id)}" title="Rename series">✎</button>
      <button class="yst2-icon danger" data-remove="${esc(s.id)}" title="Remove series">×</button></header>
      <div class="yst2-muted">${st.watched}/${st.total} watched · ${st.pct}% complete · ${st.active} in progress${st.left?` · ${fmt(st.left)} remaining`:''}</div>
      <div class="yst2-bar big"><i style="width:${st.pct}%"></i></div>
      ${cont?`<button class="yst2-continue" data-continue="${esc(s.id)}">▶ Continue watching <span>${esc(cont.title)}</span></button>`:'<div class="yst2-done">✓ All episodes watched</div>'}
      <details class="yst2-details"><summary>Episodes <span>${st.total}</span></summary>
        <div class="yst2-episode-list">${[...s.episodes].sort((a,b)=>a.order-b.order).map(e=>episodeHTML(s,e)).join('')}</div>
      </details>
    </section>`;
  }
  function renderPanel() {
    const p = document.getElementById(PANEL); if (!p) return;
    const total = db.series.reduce((n,s)=>n+s.episodes.length,0);
    const watched = db.series.reduce((n,s)=>n+s.episodes.filter(e=>stateFor(e.id).watched).length,0);
    const allCont = db.series.map(s=>({s,e:chooseContinue(s)})).filter(x=>x.e);
    let body = '';
    if (activeTab === 'library') body = db.series.length ? db.series.map(seriesHTML).join('') :
      `<div class="yst2-empty"><div class="symbol">▤</div><h3>Your series library is empty</h3><p>Open a YouTube playlist and select <b>Sync full playlist</b>, or play a video and use <b>Add current video</b> to start a series manually.</p></div>`;
    if (activeTab === 'continue') body = allCont.length ? allCont.map(({s,e})=>`<section class="yst2-series"><div class="yst2-muted">${esc(s.title)}</div>${episodeHTML(s,e)}<button class="yst2-continue" data-continue="${esc(s.id)}">▶ Resume / play next</button></section>`).join('') :
      `<div class="yst2-empty"><h3>Nothing to continue</h3><p>Start watching a series episode and progress will appear here.</p></div>`;
    if (activeTab === 'history') body = renderHistory();
    if (activeTab === 'settings') body = settingsHTML();
    p.innerHTML = `<div class="yst2-top"><div><div class="yst2-logo">Series</div><div class="yst2-muted">${db.series.length} series · ${watched}/${total} episodes watched</div></div><button id="yst2-close" class="yst2-icon">×</button></div>
      <div class="yst2-actions"><button id="yst2-add-current" class="yst2-mainbtn">＋ Add current video</button><button id="yst2-sync" class="yst2-subbtn">Sync full playlist</button><button id="yst2-export" class="yst2-subbtn">Export</button><button id="yst2-import" class="yst2-subbtn">Import</button></div>
      <nav class="yst2-tabs">${[['library','Library'],['continue','Continue'],['history','History'],['settings','Settings']].map(([k,v])=>`<button data-tab="${k}" class="${activeTab===k?'active':''}">${v}</button>`).join('')}</nav>
      <div class="yst2-content">${body}</div><footer class="yst2-footer">Local-only tracker · ${db.lastSync?`Last playlist sync ${new Date(db.lastSync).toLocaleString()}`:'No playlist sync yet'}</footer>`;
    bindPanel();
  }
  function settingsHTML() {
    const s = db.settings;
    return `<section class="yst2-series"><h3>Playback & tracking</h3>
      <label class="yst2-setting">Mark watched at <select id="yst2-threshold">
        ${[[0.5,'50%'],[0.75,'75%'],[0.9,'90%'],[0.95,'95%'],[1,'Video ends only']].map(([v,l])=>`<option value="${v}" ${Number(s.watchedThreshold)===v?'selected':''}>${l}</option>`).join('')}
      </select></label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-autonext" ${s.autoNext?'checked':''}> Automatically play the next unwatched episode when a tracked episode ends</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-autosync" ${s.autoSyncOnOpen?'checked':''}> Automatically refresh the current tracked playlist when opened</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-historyscan" ${s.historyScan?'checked':''}> Match YouTube History page videos to known episodes</label>
      <p class="yst2-muted">Progress is stored in this Firefox profile on YouTube. It does not sync to Morphe or your Google account. You can export a backup at any time.</p>
      <button id="yst2-clear" class="yst2-subbtn dangerbtn">Delete all series and progress</button></section>
      <section class="yst2-series"><h3>Data tools</h3><button id="yst2-recount" class="yst2-subbtn">Recalculate watched status from saved positions</button><button id="yst2-markall" class="yst2-subbtn">Mark current series watched</button></section>`;
  }
  function renderHistory() {
    const rows = Object.entries(db.history).sort((a,b)=>(b[1].lastSeen||0)-(a[1].lastSeen||0)).slice(0,100);
    if (!rows.length) return `<div class="yst2-empty"><h3>No history matches yet</h3><p>Open YouTube History while logged in; the tracker will match visible videos against your saved series.</p><button id="yst2-scanhistory" class="yst2-mainbtn">Scan current History page</button></div>`;
    return `<section class="yst2-series"><h3>History matches</h3><div class="yst2-muted">${rows.length} recently seen tracked episodes</div>${rows.map(([id,h])=>`<article class="yst2-ep"><img class="yst2-thumb" src="https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg"><div class="yst2-epbody"><button class="yst2-epname" data-history-play="${esc(id)}">${esc(h.title||stateFor(id).title||id)}</button><div class="yst2-muted">Seen ${new Date(h.lastSeen||Date.now()).toLocaleDateString()}</div></div></article>`).join('')}</section>`;
  }
  function bindPanel() {
    const p = document.getElementById(PANEL);
    p.querySelector('#yst2-close')?.addEventListener('click', closePanel);
    p.querySelector('#yst2-add-current')?.addEventListener('click', showAddVideoDialog);
    p.querySelector('#yst2-sync')?.addEventListener('click', syncCurrentPlaylist);
    p.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{activeTab=b.dataset.tab;renderPanel();if(activeTab==='history')scanHistoryPage();}));
    p.querySelectorAll('[data-play]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.sid),e=s?.episodes.find(x=>x.id===b.dataset.play);if(s&&e)openEpisode(s,e);}));
    p.querySelectorAll('[data-continue]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.continue);if(s)openEpisode(s,chooseContinue(s));}));
    p.querySelectorAll('[data-mark]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.mark;markEpisode(id,!stateFor(id).watched);}));
    p.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.remove);if(s&&confirm(`Remove “${s.title}” from the library? Progress will be retained for videos that appear in other series.`)){db.series=db.series.filter(x=>x.id!==s.id);saveDB();renderPanel();}}));
    p.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',async()=>{if(getPlaylistId()!==b.dataset.sync){toast('Open this series playlist first, then refresh it.');return;}await syncCurrentPlaylist();}));
    p.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.edit);if(!s)return;const n=prompt('Series name',s.title);if(n?.trim()){s.title=n.trim();saveDB();renderPanel();}}));
    p.querySelectorAll('[data-history-play]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.historyPlay;const s=db.series.find(x=>x.episodes.some(e=>e.id===id));const e=s?.episodes.find(x=>x.id===id);if(s&&e)openEpisode(s,e);else location.href=urlFor(id);}));
    p.querySelector('#yst2-export')?.addEventListener('click',exportBackup);
    p.querySelector('#yst2-import')?.addEventListener('click',importBackup);
    p.querySelector('#yst2-threshold')?.addEventListener('change',e=>{db.settings.watchedThreshold=Number(e.target.value);saveDB();});
    p.querySelector('#yst2-autonext')?.addEventListener('change',e=>{db.settings.autoNext=e.target.checked;saveDB();});
    p.querySelector('#yst2-autosync')?.addEventListener('change',e=>{db.settings.autoSyncOnOpen=e.target.checked;saveDB();});
    p.querySelector('#yst2-historyscan')?.addEventListener('change',e=>{db.settings.historyScan=e.target.checked;saveDB();});
    p.querySelector('#yst2-clear')?.addEventListener('click',()=>{if(confirm('Permanently delete all series, episode progress, and history matches? Export a backup first if needed.')){db=emptyDB();saveDB();renderPanel();toast('Tracker data deleted.');}});
    p.querySelector('#yst2-recount')?.addEventListener('click',()=>{for(const [id,st] of Object.entries(db.episodes)){if(!st.watched&&st.duration>0&&st.position/st.duration>=db.settings.watchedThreshold)setState(id,{watched:true});}renderPanel();toast('Watched status recalculated.');});
    p.querySelector('#yst2-markall')?.addEventListener('click',()=>{const s=findSeries(getPlaylistId());if(!s){toast('Open a tracked series playlist first.');return;}if(confirm(`Mark all ${s.episodes.length} episodes watched?`)){const now=Date.now();for(const e of s.episodes){const old=stateFor(e.id);db.episodes[e.id]={...old,watched:true,position:old.duration||e.duration||old.position,duration:old.duration||e.duration||0,updatedAt:now,lastWatchedAt:old.watched?old.lastWatchedAt:now};}saveDB();renderPanel();toast('All episodes marked watched.');}});
    p.querySelector('#yst2-scanhistory')?.addEventListener('click',scanHistoryPage);
  }
  function exportBackup() {
    const blob = new Blob([JSON.stringify(db,null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='youtube-series-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
  }
  function importBackup() {
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.onchange=async()=>{try{const p=JSON.parse(await input.files[0].text());if(!Array.isArray(p.series)||!p.episodes||typeof p.episodes!=='object')throw new Error('invalid');if(!confirm('Replace current tracker data with this backup?'))return;const base=emptyDB();db={...base,...p,settings:{...base.settings,...(p.settings||{})}};saveDB();renderPanel();toast('Backup imported.');}catch(_){toast('Invalid backup file.');}};
    input.click();
  }
  function scanHistoryPage() {
    if (!location.pathname.startsWith('/feed/history')) { toast('Open youtube.com/feed/history first, then select Scan History.'); return; }
    const matched = new Set(db.series.flatMap(s=>s.episodes.map(e=>e.id)));
    let count=0;
    for(const node of document.querySelectorAll('ytd-video-renderer,ytd-grid-video-renderer,ytd-rich-item-renderer')) {
      const a=node.querySelector('a#video-title, a#thumbnail[href*="watch"]');if(!a)continue;
      try {
        const id=new URL(a.href,location.origin).searchParams.get('v');if(!id||!matched.has(id))continue;
        const title=text(node.querySelector('#video-title'))||a.title||stateFor(id).title;
        db.history[id]={title,lastSeen:Date.now()};count++;
        const st=stateFor(id);if(!st.watched)setState(id,{watched:true},false);
      }catch(_){}
    }
    saveDB();renderPanel();toast(`History scan found ${count} tracked episode(s). Scroll down to load more history, then scan again.`);
  }
  function addSidebarButton() {
    let button = document.getElementById(BTN);
    if (!button) {
      button = document.createElement('button');
      button.id = BTN;
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 3v12h12V6H6zm2 2h8v2H8V8zm0 4h8v2H8v-2z"/></svg><span>Series</span>';
      button.addEventListener('click', togglePanel);
    }

    const host = document.querySelector('ytd-guide-section-renderer #items')
      || document.querySelector('ytd-guide-renderer #sections')
      || document.querySelector('ytd-mini-guide-renderer');
    let wrap = document.getElementById('yst2-sidebar-wrap');

    if (host) {
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'yst2-sidebar-wrap';
      }
      if (button.parentElement !== wrap) wrap.appendChild(button);
      if (wrap.parentElement !== host) host.appendChild(wrap);
      button.classList.remove('floating');
    } else {
      if (wrap) wrap.remove();
      if (button.parentElement !== document.body) document.body.appendChild(button);
      button.classList.add('floating');
    }
  }
  function addPlayerButton() {
    const player = document.querySelector('#movie_player');
    if (!player) return;
    const host = player.querySelector('.ytp-chrome-top-buttons')
      || player.querySelector('.ytp-right-controls');
    if (!host) return;

    let button = document.getElementById(PLAYER_BTN);
    if (button && button.parentElement === host) return;
    if (button) button.remove();

    button = document.createElement('button');
    button.type = 'button';
    button.id = PLAYER_BTN;
    button.className = 'ytp-button yst2-player-button';
    button.title = 'YouTube Series Tracker';
    button.setAttribute('aria-label', 'Open YouTube Series Tracker');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 3.5A2.5 2.5 0 0 1 6.5 1h11A2.5 2.5 0 0 1 20 3.5v17a.5.5 0 0 1-.8.4L12 15.5l-7.2 5.4a.5.5 0 0 1-.8-.4v-17ZM7 5v2h10V5H7Zm0 4v2h7V9H7Z"/></svg>';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openFromPlayer();
    });
    host.appendChild(button);
  }

  function openFromPlayer() {
    const videoId = getVideoId();
    const listId = getPlaylistId();
    activeTab = 'library';
    openPanel();

    // A playing video should offer the one-by-one builder first, even when its
    // URL also contains list=. The dialog retains a separate whole-playlist action.
    if (videoId) {
      showAddVideoDialog();
      return;
    }

    if (listId) {
      const existing = findSeries(listId);
      if (existing) {
        toast('Series "' + existing.title + '" is already in your library.');
        return;
      }
      syncCurrentPlaylist();
      return;
    }
    toast('Open a YouTube video or playlist first.');
  }

  function ensureUI() {
    addStyles();
    if(!document.getElementById(PANEL)){const p=document.createElement('aside');p.id=PANEL;document.body.appendChild(p);}
    addSidebarButton();
    addPlayerButton();
  }
  function openPanel(){document.getElementById(PANEL)?.classList.add('open');renderPanel();}
  function closePanel(){document.getElementById(PANEL)?.classList.remove('open');}
  function togglePanel(){document.getElementById(PANEL)?.classList.contains('open')?closePanel():openPanel();}
  function toast(message) {
    let el=document.getElementById('yst2-toast');if(!el){el=document.createElement('div');el.id='yst2-toast';document.body.appendChild(el);}
    el.textContent=message;el.classList.add('show');clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove('show'),4000);
  }
  function addStyles() {
    if(document.getElementById(STYLE))return;
    const st=document.createElement('style');st.id=STYLE;st.textContent=`
      #${PANEL}{display:none;position:fixed;z-index:999999;top:12px;right:12px;bottom:12px;width:min(470px,calc(100vw - 24px));background:#111216;color:#f4f4f5;border:1px solid #35363d;border-radius:16px;box-shadow:0 16px 60px #000a;font:14px/1.4 Roboto,Arial,sans-serif;overflow:hidden}
      #${PANEL}.open{display:flex;flex-direction:column}#${PANEL} *{box-sizing:border-box}#${PANEL} button{font:inherit;cursor:pointer}
      .yst2-top{display:flex;justify-content:space-between;align-items:center;padding:17px 18px 12px;border-bottom:1px solid #292a30}
      .yst2-logo{font-size:25px;font-weight:800;letter-spacing:-.8px}.yst2-muted{color:#a5a6b0;font-size:11px}
      .yst2-actions{display:flex;gap:7px;padding:11px 14px;flex-wrap:wrap}.yst2-mainbtn,.yst2-subbtn,.yst2-icon{border:0;border-radius:9px;padding:9px 11px}
      .yst2-mainbtn{background:#ff1744;color:white;font-weight:700}.yst2-subbtn,.yst2-icon{background:#292a31;color:#f0f0f3}.yst2-icon{padding:3px 8px;font-size:18px}.yst2-icon.danger{color:#ff808f}
      .yst2-tabs{display:flex;gap:3px;padding:0 12px 10px;border-bottom:1px solid #292a30}.yst2-tabs button{border:0;background:transparent;color:#a8a8b1;padding:8px 10px;border-radius:8px;font-size:12px}.yst2-tabs button.active{background:#2a2b32;color:white}
      .yst2-content{overflow:auto;flex:1;min-height:0;padding:12px 14px}.yst2-series{background:#191a20;border:1px solid #303139;border-radius:12px;padding:12px;margin-bottom:12px}
      .yst2-serieshead{display:flex;align-items:center;gap:5px;margin-bottom:5px}.yst2-seriestitle{font-weight:750;font-size:15px;overflow-wrap:anywhere;flex:1}
      .yst2-bar{height:4px;border-radius:99px;background:#393a43;overflow:hidden;margin:8px 0}.yst2-bar i{display:block;height:100%;background:#ff1744;border-radius:99px}.yst2-bar.big{height:5px}
      .yst2-continue{display:block;width:100%;text-align:left;border:0;border-radius:8px;background:#302129;color:#fff;padding:10px;margin-top:7px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .yst2-continue span{font-weight:400;color:#ffc0cb}.yst2-done{color:#65d6a1;padding:9px 0}.yst2-details{margin-top:9px}.yst2-details summary{cursor:pointer;color:#ddd;padding:5px 0;font-size:12px}.yst2-details summary span{color:#999;margin-left:5px}
      .yst2-ep{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid #292a30}.yst2-thumb{width:86px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#292a30}.yst2-epbody{flex:1;min-width:0}
      .yst2-epname{display:block;background:none;border:0;color:#eee;text-align:left;padding:0;font-weight:650;font-size:12px;line-height:1.4;max-height:2.8em;overflow:hidden}.yst2-epbody .yst2-muted{margin-top:4px}.yst2-epbody .yst2-bar{margin-top:5px}
      .yst2-mark{background:none;border:0;color:#aaa;font-size:19px;min-width:28px}.yst2-mark.checked{color:#62d5a0}.yst2-ep.is-watched .yst2-epname{color:#b5b5bc}
      .yst2-empty{text-align:center;padding:42px 16px;color:#ddd}.yst2-empty h3{margin:10px 0 5px}.yst2-empty p{color:#a5a6b0;font-size:12px}.yst2-empty .symbol{font-size:38px;color:#ff1744}
      .yst2-setting{display:flex;align-items:center;gap:8px;margin:13px 0;font-size:12px}.yst2-setting select{margin-left:auto;background:#292a31;color:#eee;border:1px solid #444;border-radius:6px;padding:5px}
      .yst2-setting input{accent-color:#ff1744}.dangerbtn{color:#ff8b9b}.yst2-footer{padding:10px 15px;border-top:1px solid #292a30;color:#8d8f99;font-size:10px}
      .yst2-manual-label{font-size:10px;color:#a5a6b0;margin-left:auto}
      .yst2-modal-backdrop{position:absolute;inset:0;z-index:10;background:#000b;display:flex;align-items:center;justify-content:center;padding:16px}
      .yst2-modal{width:100%;max-width:390px;max-height:100%;overflow:auto;background:#191a20;border:1px solid #444650;border-radius:14px;box-shadow:0 18px 60px #000c;padding:15px}
      .yst2-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}
      .yst2-modal-head h3{margin:0 0 4px;font-size:17px}.yst2-modal-head p{margin:0;line-height:1.4}
      .yst2-current-video{display:flex;align-items:center;gap:10px;padding:9px;background:#24252c;border-radius:9px;margin-bottom:15px;min-width:0}
      .yst2-current-video img{width:92px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;flex:none}
      .yst2-current-video div{min-width:0;display:flex;flex-direction:column;gap:4px}.yst2-current-video strong{font-size:12px;line-height:1.35;overflow-wrap:anywhere}.yst2-current-video span{font-size:10px;color:#a5a6b0}
      .yst2-dialog-label{display:block;margin:10px 0 6px;font-size:12px;color:#dadbe1}
      .yst2-dialog-select,.yst2-dialog-input{width:100%;border:1px solid #454650;border-radius:8px;background:#101116;color:#f4f4f5;padding:10px;font:inherit;margin-bottom:9px}
      .yst2-modal .yst2-mainbtn,.yst2-modal .yst2-subbtn{width:100%;padding:10px;margin:2px 0}
      .yst2-modal button:disabled{opacity:.42;cursor:not-allowed}
      .yst2-modal-or{display:flex;align-items:center;gap:10px;margin:14px 0;color:#a5a6b0;font-size:11px}
      .yst2-modal-or:before,.yst2-modal-or:after{content:"";height:1px;background:#383941;flex:1}
      .yst2-dialog-cancel{margin-top:7px!important}
      #${BTN}{display:flex;align-items:center;gap:20px;width:100%;padding:10px 12px;border:0;border-radius:10px;background:transparent;color:var(--yt-spec-text-primary,#f1f1f1);font:500 14px Roboto,Arial,sans-serif;cursor:pointer}
      #${BTN}:hover{background:var(--yt-spec-10-percent-layer,#272727)}#${BTN} svg{width:24px;height:24px;fill:currentColor;flex:none}
      #${BTN}.floating{position:fixed;z-index:999990;left:12px;bottom:18px;width:auto;background:#ff1744;color:white;border-radius:22px;padding:10px 15px;box-shadow:0 5px 20px #0007}
      #${PLAYER_BTN}{display:inline-flex!important;align-items:center;justify-content:center;width:48px;height:48px;padding:0;margin:0;border:0;background:transparent;color:#f1f1f1;cursor:pointer;flex:0 0 48px;vertical-align:top}
      #${PLAYER_BTN} svg{display:block;width:24px;height:24px;fill:currentColor}
      #${PLAYER_BTN}:hover{opacity:.82}
      #${PLAYER_BTN}:focus-visible{outline:2px solid #fff;outline-offset:-4px;border-radius:8px}
      #yst2-toast{position:fixed;z-index:1000001;left:50%;bottom:26px;transform:translate(-50%,15px);opacity:0;pointer-events:none;background:#292a31;color:white;padding:12px 16px;border-radius:10px;box-shadow:0 5px 25px #0008;transition:.2s;font:13px Roboto,Arial,sans-serif;max-width:90vw}
      #yst2-toast.show{opacity:1;transform:translate(-50%,0)}@media(max-width:600px){#${PANEL}{top:6px;right:6px;bottom:6px;width:calc(100vw - 12px)}.yst2-thumb{width:72px}}
    `;document.head.appendChild(st);
  }
  function trackCurrentVideo() {
    const meta=videoMeta(), video=document.querySelector('video');
    if(!meta||!video)return;
    if(currentVideoId===meta.id&&activeVideo===video)return;
    currentVideoId=meta.id;activeVideo=video;
    const list=getPlaylistId(), s=list?findSeries(list):db.series.find(x=>x.episodes.some(e=>e.id===meta.id));
    if(s&&!s.episodes.some(e=>e.id===meta.id)){
      s.episodes.push({id:meta.id,title:meta.title,duration:meta.duration,thumb:meta.thumb,url:meta.url,order:s.episodes.length});saveDB();
    }
    const savePosition=()=>{
      if(!Number.isFinite(video.currentTime))return;
      const dur=Number.isFinite(video.duration)?video.duration:meta.duration;
      const old=stateFor(meta.id), threshold=Number(db.settings.watchedThreshold);
      const watched=old.watched || (dur>0 && (video.ended || (threshold<1 && video.currentTime/dur>=threshold)));
      setState(meta.id,{title:meta.title||old.title,position:watched?(dur||video.currentTime):video.currentTime,duration:dur||old.duration,watched},false);
      if(s) db.history[meta.id]={title:meta.title,lastSeen:Date.now()};
      saveDB();
      if(document.getElementById(PANEL)?.classList.contains('open')&&Date.now()-lastSave>1500){lastSave=Date.now();renderPanel();}
    };
    const onTime=()=>{if(Date.now()-lastSave>=SAVE_MS){lastSave=Date.now();savePosition();}};
    video.addEventListener('timeupdate',onTime);
    video.addEventListener('loadedmetadata',savePosition,{once:true});
    video.addEventListener('pause',savePosition);
    video.addEventListener('ended',()=>{
      setState(meta.id,{title:meta.title,position:video.duration||meta.duration,duration:video.duration||meta.duration,watched:true},false);
      if(s) db.history[meta.id]={title:meta.title,lastSeen:Date.now()};
      saveDB();
      if(db.settings.autoNext && s) {
        const next=chooseNext(s,meta.id);
        if(next && next.id!==meta.id) {
          toast(`Playing next episode: ${next.title}`);
          setTimeout(()=>{if(video.ended&&getVideoId()===meta.id)openEpisode(s,next,false);},900);
        }
      }
      if(document.getElementById(PANEL)?.classList.contains('open'))renderPanel();
    });
    if(s){db.history[meta.id]={title:meta.title,lastSeen:Date.now()};saveDB();}
  }
  function routeChanged() {
    clearTimeout(routeTimer);
    routeTimer=setTimeout(()=>{
      ensureUI();
      currentVideoId='';activeVideo=null;
      trackCurrentVideo();
      if(db.settings.autoSyncOnOpen && getPlaylistId() && !syncBusy) {
        const id=getPlaylistId(), s=findSeries(id), last=Number(sessionStorage.getItem(AUTO_SYNC_KEY)||0);
        if(s && Date.now()-last>15*60*1000){sessionStorage.setItem(AUTO_SYNC_KEY,String(Date.now()));syncCurrentPlaylist();}
      }
      if(location.pathname.startsWith('/feed/history')&&db.settings.historyScan) scanHistoryPage();
    },450);
  }
  function observeSidebar() {
    const mo=new MutationObserver(()=>{
      if(!document.getElementById(BTN)) addSidebarButton();
      addPlayerButton();
    });
    mo.observe(document.documentElement,{childList:true,subtree:true});
  }
  function boot() {
    ensureUI();routeChanged();
    document.addEventListener('yt-navigate-finish',routeChanged);
    window.addEventListener('popstate',routeChanged);
    observeSidebar();
    // YouTube may replace its video element without firing SPA navigation.
    if(tickTimer)clearInterval(tickTimer);
    tickTimer=setInterval(()=>{
      if(getVideoId() && (getVideoId()!==currentVideoId || document.querySelector('video')!==activeVideo))trackCurrentVideo();
      if(!document.getElementById(BTN)) addSidebarButton();
      addPlayerButton();
    },1500);
  }
  boot();
})();