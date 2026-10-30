// ==UserScript==
// @name         YouTube Series Tracker
// @namespace    https://github.com/GraveEaterMadison/youtube-series-tracker
// @version      2.6.1
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
  const AUTO_WATCHED_DEFAULT = 0.92;
  const AUTO_WATCHED_REMAINING_SECONDS = 30;
  let lastUndo = null;
  const SAVE_MS = 5000;
  const UNDO_WINDOW_MS = 8000;
  const MAX_BACKUP_CHARS = 8 * 1024 * 1024;
  const MAX_BACKUP_SERIES = 500;
  const MAX_BACKUP_EPISODES = 50000;
  const PLAYER_PREV_BTN = 'yst2-player-previous';
  const PLAYER_NEXT_BTN = 'yst2-player-next';
  const PLAYLIST_BTN = 'yst2-playlist-action';
  let undoExpiryTimer = null;
  let activePlaybackSession = null;
  let staleRefreshBusy = false;
  let staleRefreshTimer = null;
  const AUTO_SYNC_KEY = 'yst2-last-sync';
  let db = loadDB();
  let activeTab = 'library';
  let librarySearch = '';
  let currentVideoId = '';
  let activeVideo = null;
  let tickTimer = null;
  let routeTimer = null;
  let lastSave = 0;
  let lastPanelRender = 0;
  const EPISODE_BATCH_SIZE = 50;
  let syncBusy = false;
  let playerActionBusy = false;
  const discoveryCache = new Map();
  let currentHistoryScan = '';
  let activeVideoCleanup = null;

  function emptyDB() {
    return {
      version: VERSION,
      settings: {
        watchedThreshold: AUTO_WATCHED_DEFAULT,
        watchedRemainingSeconds: AUTO_WATCHED_REMAINING_SECONDS,
        autoNext: false,
        autoSyncOnOpen: true,
        showSidebarButton: true,
        historyScan: true,
        catalogAutoRefresh: true,
        recordPlaybackProgress: true,
        importHistoryProgress: false,
        showPlayerButton: true
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
      const series = (Array.isArray(p.series) ? p.series : []).map(item => ({
        ...item,
        catalogRevision: Number.isInteger(item.catalogRevision) ? item.catalogRevision : (Array.isArray(item.episodes) && item.episodes.length ? 1 : 0),
        cursorRevision: Number.isInteger(item.cursorRevision) ? item.cursorRevision : 0,
        newEpisodeIds: Array.isArray(item.newEpisodeIds) ? item.newEpisodeIds.filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)) : [],
        startHereVideoId: /^[A-Za-z0-9_-]{11}$/.test(String(item.startHereVideoId || '')) ? item.startHereVideoId : '',
        startHereOrder: Number.isInteger(item.startHereOrder) ? item.startHereOrder : -1,
        lastRefreshAttemptAt: Number(item.lastRefreshAttemptAt) || 0,
        refreshRetryAt: Number(item.refreshRetryAt) || 0,
        refreshError: String(item.refreshError || '').slice(0, 240),
        recoveryRequired: Boolean(item.recoveryRequired),
        recoveryVideoId: /^[A-Za-z0-9_-]{11}$/.test(String(item.recoveryVideoId || '')) ? item.recoveryVideoId : ''
      }));
      return {
        ...base, ...p,
        settings: { ...base.settings, ...(p.settings || {}) },
        series,
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
    return db.episodes[id] || { watched: false, completionOverride: 'AUTO', position: 0, duration: 0, title: '', updatedAt: 0, lastWatchedAt: 0 };
  }
  function isWatchedState(state) {
    if (!state) return false;
    if (state.completionOverride === 'WATCHED') return true;
    if (state.completionOverride === 'UNWATCHED') return false;
    return Boolean(state.watched);
  }
  function isWatched(id) { return isWatchedState(stateFor(id)); }
  function shouldAutoComplete(position, duration, threshold, remainingSeconds, ended = false) {
    if (ended) return true;
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0) return false;
    const fraction = Math.max(0, Math.min(1, Number(threshold)));
    // HTMLMediaElement.currentTime and duration are seconds; native Morphe code stores milliseconds.
    return (position / duration >= fraction && duration - position <= 90) ||
      (duration > 60 && remainingSeconds > 0 && duration - position <= remainingSeconds);
  }
  function expireUndo(reference) {
    if (undoExpiryTimer) clearTimeout(undoExpiryTimer);
    undoExpiryTimer = setTimeout(() => {
      if (lastUndo === reference) {
        lastUndo = null;
        undoExpiryTimer = null;
        if (document.getElementById(PANEL)?.classList.contains('open')) renderPanel();
      }
    }, UNDO_WINDOW_MS + 10);
  }
  function shouldAutoCompletePercentage(observedPercent, duration, threshold = db.settings.watchedThreshold) {
    if (!Number.isFinite(observedPercent) || observedPercent < Number(threshold) * 100 || observedPercent > 100 || !Number.isFinite(duration) || duration <= 0) return false;
    return duration * (100 - observedPercent) / 100 <= 90;
  }
  function rememberUndo(ids, description) {
    const before = {};
    for (const id of new Set(ids)) before[id] = Object.prototype.hasOwnProperty.call(db.episodes, id) ? { ...db.episodes[id] } : null;
    lastUndo = { before, description, expiresAt: Date.now() + UNDO_WINDOW_MS };
    expireUndo(lastUndo);
  }
  function rememberDatabaseUndo(description) {
    lastUndo = {
      database: {
        series: JSON.parse(JSON.stringify(db.series)),
        episodes: JSON.parse(JSON.stringify(db.episodes)),
        history: JSON.parse(JSON.stringify(db.history))
      },
      description,
      expiresAt: Date.now() + UNDO_WINDOW_MS
    };
    expireUndo(lastUndo);
  }
  function undoLastChange() {
    if (!lastUndo || Date.now() > Number(lastUndo.expiresAt || 0)) {
      lastUndo = null;
      if (undoExpiryTimer) clearTimeout(undoExpiryTimer);
      undoExpiryTimer = null;
      return false;
    }
    if (lastUndo.database) {
      db.series = JSON.parse(JSON.stringify(lastUndo.database.series));
      db.episodes = JSON.parse(JSON.stringify(lastUndo.database.episodes));
      db.history = JSON.parse(JSON.stringify(lastUndo.database.history));
    }
    for (const [id, old] of Object.entries(lastUndo.before || {})) {
      if (old === null) delete db.episodes[id];
      else db.episodes[id] = { ...old };
    }
    const description = lastUndo.description;
    if (undoExpiryTimer) clearTimeout(undoExpiryTimer);
    undoExpiryTimer = null;
    lastUndo = null;
    saveDB();
    renderPanel();
    toast('Undone: ' + description);
    return true;
  }
  function markThrough(series, targetEpisode) {
    if (!series || !targetEpisode) return false;
    const playable = orderedEpisodes(series).filter(ep => ep.available !== false && !ep.unavailable && /^[A-Za-z0-9_-]{11}$/.test(ep.id));
    const index = playable.findIndex(ep => ep.id === targetEpisode.id && ep.order === targetEpisode.order);
    if (index < 0) return false;
    const selected = playable.slice(0, index + 1);
    rememberUndo(selected.map(ep => ep.id), 'mark watched through episode');
    const now = Date.now();
    for (const ep of selected) {
      const old = stateFor(ep.id);
      const already = isWatched(ep.id);
      db.episodes[ep.id] = {
        ...old, watched: true, completionOverride: 'WATCHED',
        position: old.duration || ep.duration || old.position,
        duration: old.duration || ep.duration || 0,
        updatedAt: now, lastWatchedAt: already ? old.lastWatchedAt : now
      };
    }
    saveDB();
    renderPanel();
    toast('Marked ' + selected.length + ' episodes watched.');
    return true;
  }
  function setState(id, patch, persist = true) {
    const old = stateFor(id);
    const next = { ...old, ...patch, updatedAt: Date.now() };
    if (patch.watched === true && !isWatched(id)) next.lastWatchedAt = Date.now();
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
  function rendererText(node) {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map(run => String(run && run.text || '')).join('');
    return '';
  }

  function isSuggestiblePlaylistId(id) {
    const value = String(id || '').trim();
    return /^[A-Za-z0-9_-]{2,200}$/.test(value) && !/^(?:RD|UL)/.test(value) && value !== 'WL' && value !== 'LL';
  }

  function isDiscoveryPlaylistId(id) {
    return isSuggestiblePlaylistId(id) && !/^(?:UU|UUL)/.test(id);
  }

  function playlistRowEpisode(row, listId, ordinal) {
    const wrapper = row && row.playlistPanelVideoWrapperRenderer;
    const v = row && (row.playlistVideoRenderer || row.playlistPanelVideoRenderer
      || wrapper && wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer
      || wrapper && wrapper.playlistPanelVideoRenderer);
    if (!v) return null;
    const rawId = String(v.videoId || '');
    const validId = /^[A-Za-z0-9_-]{11}$/.test(rawId);
    const title = rendererText(v.title) || (validId ? 'Untitled episode' : 'Unavailable video');
    const overlays = Array.isArray(v.thumbnailOverlays) ? v.thumbnailOverlays : [];
    const upcoming = Boolean(v.upcomingEventData) || overlays.some(item => item && item.thumbnailOverlayTimeStatusRenderer && item.thumbnailOverlayTimeStatusRenderer.style === 'UPCOMING');
    const unavailableTitle = title === '[Private video]' || title === '[Deleted video]';
    const available = validId && v.isPlayable !== false && !upcoming && !unavailableTitle;
    const safeList = String(listId || 'playlist').replace(/[^A-Za-z0-9_-]/g, '_');
    const id = validId ? rawId : '__yst_unavailable__' + safeList + '_' + String(ordinal + 1);
    const thumbnails = v.thumbnail && v.thumbnail.thumbnails;
    const thumb = Array.isArray(thumbnails) && thumbnails.length ? String(thumbnails[thumbnails.length - 1].url || '') : (validId ? 'https://i.ytimg.com/vi/' + rawId + '/hqdefault.jpg' : '');
    const seconds = v.lengthSeconds ? Number(v.lengthSeconds) : parseDuration(rendererText(v.lengthText));
    const displayedIndex = Number(rendererText(v.index));
    const order = Number.isInteger(displayedIndex) && displayedIndex > 0 ? displayedIndex - 1 : ordinal;
    return { id, title, duration: Number.isFinite(seconds) ? Math.max(0, seconds) : 0, thumb, url: available ? 'https://www.youtube.com/watch?v=' + rawId : '', order, available, unavailable: !available, videoInfo: rendererText(v.videoInfo) };
  }

  function playlistTitleFromPayload(data) {
    return rendererText(data && data.metadata && data.metadata.playlistMetadataRenderer && data.metadata.playlistMetadataRenderer.title)
      || rendererText(data && data.header && data.header.playlistHeaderRenderer && data.header.playlistHeaderRenderer.title)
      || String(data && data.header && data.header.pageHeaderRenderer && data.header.pageHeaderRenderer.pageTitle || '')
      || rendererText(data && data.header && data.header.playlistSidebarPrimaryInfoRenderer && data.header.playlistSidebarPrimaryInfoRenderer.title)
      || '';
  }

  function playlistPanelFor(data, listId) {
    let found = null;
    walk(data, node => {
      const panel = node && node.playlistPanelRenderer;
      if (!found && panel && String(panel.playlistId || '') === listId && Array.isArray(panel.contents)) found = panel;
    });
    return found;
  }

  function selectedPlaylistContent(data) {
    const root = data && data.contents && (data.contents.singleColumnBrowseResultsRenderer || data.contents.twoColumnBrowseResultsRenderer);
    const tabs = root && root.tabs;
    if (Array.isArray(tabs) && tabs.length) {
      const selected = tabs.find(tab => tab && tab.tabRenderer && tab.tabRenderer.selected) || tabs[0];
      return selected && selected.tabRenderer && selected.tabRenderer.content || root;
    }
    return root || data && data.contents || data;
  }

  function findPlaylistVideoListRenderer(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 18) return null;
    if (node.playlistVideoListRenderer && Array.isArray(node.playlistVideoListRenderer.contents)) return node.playlistVideoListRenderer;
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = findPlaylistVideoListRenderer(child, depth + 1);
        if (result) return result;
      }
      return null;
    }
    for (const key of ['sectionListRenderer', 'itemSectionRenderer', 'contents', 'content', 'tabs', 'tabRenderer']) {
      if (node[key] === undefined) continue;
      const result = findPlaylistVideoListRenderer(node[key], depth + 1);
      if (result) return result;
    }
    return null;
  }

  function playlistContinuation(container, rows) {
    const tokens = new Set();
    const continuations = container && container.continuations;
    if (Array.isArray(continuations)) {
      for (const item of continuations) {
        const token = item && item.nextContinuationData && item.nextContinuationData.continuation || item && item.nextRadioContinuationData && item.nextRadioContinuationData.continuation || '';
        if (token) tokens.add(token);
      }
    }
    for (const row of rows || []) {
      const token = row && row.continuationItemRenderer && row.continuationItemRenderer.continuationEndpoint && row.continuationItemRenderer.continuationEndpoint.continuationCommand && row.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      if (token) tokens.add(token);
    }
    if (tokens.size > 1) throw new Error('YouTube returned ambiguous playlist continuation tokens; no partial catalog was saved.');
    return tokens.values().next().value || '';
  }

  function parsePlaylistRows(rows, listId, offset, container) {
    if (!Array.isArray(rows)) throw new Error('YouTube did not return a recognized playlist episode list.');
    const items = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error('YouTube returned an invalid playlist row; no partial catalog was saved.');
      if (row.playlistVideoRenderer || row.playlistPanelVideoRenderer || row.playlistPanelVideoWrapperRenderer) {
        const episode = playlistRowEpisode(row, listId, offset + items.length);
        if (episode) items.push(episode);
        continue;
      }
      if (row.continuationItemRenderer) continue;
      const banner = rendererText(row.messageRenderer && row.messageRenderer.text);
      if (banner && /unavailable videos will be hidden|no videos available/i.test(banner)) continue;
      const keys = Object.keys(row);
      throw new Error('Unsupported playlist row (' + (keys[0] || 'unknown') + '); refresh stopped to avoid saving an incomplete episode list.');
    }
    return { items, token: playlistContinuation(container, rows) };
  }

  function parsePlaylistPage(data, listId, continuation, offset) {
    continuation = Boolean(continuation);
    offset = Number(offset || 0);
    if (!data || typeof data !== 'object' || data.error) throw new Error('YouTube returned an invalid playlist response.');
    let container = null;
    if (continuation) {
      container = data.continuationContents && (data.continuationContents.playlistVideoListContinuation || data.continuationContents.playlistPanelContinuation) || null;
      if (!container) {
        const actions = data.onResponseReceivedActions || data.onResponseReceivedEndpoints || [];
        for (const action of actions) {
          const append = action && action.appendContinuationItemsAction;
          if (append && Array.isArray(append.continuationItems)) {
            container = { contents: append.continuationItems, continuations: [] };
            break;
          }
        }
      }
      if (!container || !Array.isArray(container.contents)) throw new Error('YouTube continuation did not contain playlist rows.');
    } else {
      const panel = playlistPanelFor(data, listId);
      if (panel) container = panel;
      else {
        const renderer = findPlaylistVideoListRenderer(selectedPlaylistContent(data), 0);
        if (renderer) container = renderer;
      }
      if (!container || !Array.isArray(container.contents)) throw new Error('YouTube did not return the requested playlist. It may be private, unavailable, or YouTube may have changed its page structure.');
    }
    const parsed = parsePlaylistRows(container.contents, listId, offset, container);
    return { items: parsed.items, token: parsed.token, title: playlistTitleFromPayload(data), visitorData: String(data.responseContext && data.responseContext.visitorData || '') };
  }

  async function requestInnerTube(endpoint, payload, budget) {
    if (endpoint !== 'browse' && endpoint !== 'search') throw new Error('Unsupported YouTube endpoint.');
    const key = getApiKey();
    if (!key) throw new Error('YouTube did not expose its InnerTube key. Reload the page and try again.');
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0 || budget.requests >= budget.maxRequests || budget.bytes >= budget.maxBytes) throw new Error('YouTube catalog discovery reached its request, time, or size limit. No partial series was saved.');
    budget.requests++;
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(12000, remaining));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const context = getClientContext();
      const client = context && context.client || {};
      const version = String(client.clientVersion || '2.20260101.00.00');
      const response = await fetch('/youtubei/v1/' + endpoint + '?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': version },
        body: JSON.stringify({ context, ...payload })
      });
      const length = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
      if (length > budget.pageBytes) throw new Error('YouTube returned a response larger than the safe page limit.');
      const body = await response.text();
      const size = new TextEncoder().encode(body).length;
      budget.bytes += size;
      if (size > budget.pageBytes || budget.bytes > budget.maxBytes) throw new Error('YouTube playlist response exceeded the safe download limit. Existing episodes were kept.');
      if (response.status === 429 || response.status === 503) throw new Error('YouTube is temporarily rate-limiting playlist discovery (HTTP ' + response.status + '). Try again later.');
      if (!response.ok) throw new Error('YouTube playlist request failed (HTTP ' + response.status + ').');
      try { return JSON.parse(body); } catch (_) { throw new Error('YouTube returned malformed playlist data. No partial catalog was saved.'); }
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('YouTube playlist request timed out. No partial catalog was saved.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchFullPlaylist(listId, options) {
    options = options || {};
    if (!isSuggestiblePlaylistId(listId)) throw new Error('This YouTube list is a mix, Watch Later, or another list type that cannot be followed as a series.');
    const budget = options.budget || { requests: 0, bytes: 0, maxRequests: 100, maxBytes: 20 * 1024 * 1024, pageBytes: 5 * 1024 * 1024, deadline: Date.now() + 60000 };
    const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : 100;
    let first = null;
    let firstError = null;
    for (const params of ['wgYCCAA%3D', '']) {
      try {
        const payload = { browseId: 'VL' + listId };
        if (params) payload.params = params;
        const response = await requestInnerTube('browse', payload, budget);
        first = parsePlaylistPage(response, listId, false, 0);
        break;
      } catch (error) {
        firstError = error;
        if (Date.now() >= budget.deadline || budget.requests >= budget.maxRequests || budget.bytes >= budget.maxBytes) break;
      }
    }
    if (!first) throw firstError || new Error('Could not load the complete playlist catalog.');
    const items = [];
    let title = first.title || '';
    const appendItems = pageItems => {
      for (const item of pageItems) {
        if (!item || !item.id) continue;
        const order = Number.isInteger(item.order) && item.order >= 0 ? item.order : items.length;
        items.push({ ...item, order });
        if (items.length > 5000) throw new Error('Playlist contains more than 5,000 rows; no partial catalog was saved.');
      }
    };
    appendItems(first.items);
    let token = first.token;
    let pages = 0;
    const seenTokens = new Set();
    while (token) {
      if (pages >= maxPages) throw new Error('Playlist catalog remains incomplete after ' + pages + ' continuation pages; no partial catalog was saved.');
      if (seenTokens.has(token)) throw new Error('YouTube repeated a continuation token; no partial catalog was saved.');
      seenTokens.add(token);
      pages++;
      const response = await requestInnerTube('browse', { continuation: token }, budget);
      const page = parsePlaylistPage(response, listId, true, items.length);
      if (page.title) title = page.title;
      appendItems(page.items);
      token = page.token;
    }
    if (!items.length) throw new Error('No episodes were found in this playlist.');
    if (Date.now() >= budget.deadline) throw new Error('Playlist catalog exceeded its time limit; no partial catalog was saved.');
    const domTitle = listId === getPlaylistId() ? playlistTitleFromDOM() : '';
    const inferredTitle = listId === getPlaylistId() ? (seriesSearchTitle(videoTitle()) || videoTitle()) : '';
    return { items, title: title || domTitle || inferredTitle, pages };
  }

  function playlistTitleFromDOM() {
    return text(document.querySelector('ytd-playlist-header-renderer #title'))
      || text(document.querySelector('ytd-playlist-header-renderer h1'))
      || text(document.querySelector('ytd-playlist-sidebar-primary-info-renderer h1'))
      || text(document.querySelector('ytd-playlist-panel-renderer #header-description #view-more'))
      || (location.pathname.startsWith('/playlist') ? document.title.replace(/\s+-\s+YouTube$/, '').trim() : '')
      || '';
  }

  function domPlaylistItems(listId) {
    listId = listId || getPlaylistId();
    const out = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer')) {
      if (node.matches('ytd-playlist-panel-video-renderer')) {
        const panel = node.closest('ytd-playlist-panel-renderer');
        const panelId = panel && (panel.getAttribute('playlist-id') || panel.data && panel.data.playlistId) || '';
        if (panelId && panelId !== listId) continue;
      }
      const a = node.querySelector('a#video-title, a#thumbnail[href*="watch"], a[href*="/watch?v="]');
      if (!a) continue;
      let u;
      try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { continue; }
      const id = u.searchParams.get('v') || '';
      if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const title = text(node.querySelector('#video-title')) || a.title || 'Untitled episode';
      const durationNode = node.querySelector('ytd-thumbnail-overlay-time-status-renderer, #overlays #text');
      out.push({ id, title, duration: parseDuration(text(durationNode)), thumb: node.querySelector('img') && node.querySelector('img').src || 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=' + id, order: out.length, available: true, unavailable: false });
    }
    return out;
  }
  function seriesSearchTitle(title) {
    const value = String(title || '').replace(/\[[^\]]*\]|\([^)]*(?:sub|dub|1080p|720p|official|english)[^)]*\)/gi, ' ');
    const season = /\b(?:season|series)\s*0*(\d{1,3})\b/i.exec(value);
    const parts = value.split(/[|｜]/).map(part => part.trim()).filter(Boolean).map(part => part
      .replace(/\bS\d{1,3}[ ._-]*E\d{1,4}\b/gi, ' ')
      .replace(/(?:\b(?:episode|ep\.?|part|chapter)|épisode)\s*#?\s*\d{1,4}\b/giu, ' ')
      .replace(/\b\d{1,4}\s*\/\s*\d{1,4}\b/g, ' ')
      .replace(/\b(?:full\s+episodes?|official\s+video|english\s+sub(?:titles?)?|english\s+dub|subbed|dubbed|1080p|720p|4k|hd)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim()).filter(Boolean);
    let name = parts.sort((a,b) => b.length - a.length)[0] || '';
    if (season && name && !new RegExp('\\b(?:season|series)\\s*0*' + season[1] + '\\b', 'i').test(name)) {
      name = (name + ' Season ' + season[1]).trim();
    }
    return name.slice(0, 160);
  }

  function episodeNumberFromTitle(title) {
    const value = String(title || '');
    const compact = /\bS(\d{1,3})[ ._-]*E(\d{1,4})\b/i.exec(value);
    if (compact) {
      if (/\bS\d{1,3}[ ._-]*E\d{1,4}\b/i.test(value.slice(compact.index + compact[0].length))) return null;
      return Number(compact[1]) * 10000 + Number(compact[2]);
    }
    const all = [...value.matchAll(/(?:\b(?:episode|ep\.?|part|chapter)|épisode)\s*#?\s*(\d{1,4})\b/giu)];
    if (all.length !== 1) return null;
    const season = /\b(?:season|series|saison)\s*0*(\d{1,3})\b/i.exec(value);
    return (season ? Number(season[1]) : 0) * 10000 + Number(all[0][1]);
  }

  function episodeAgeRange(metadata) {
    const agePattern = /^(?:streamed |premiered )?(\d{1,6})\s+(second|minute|hour|day|week|month|year)s? ago$/i;
    for (const part of String(metadata || '').split(/[•·]/)) {
      const match = agePattern.exec(part.trim());
      if (!match) continue;
      const count = Number(match[1]);
      const unit = match[2].toLowerCase();
      let low, high;
      switch (unit) {
        case 'second': low = high = 1; break;
        case 'minute': low = high = 60; break;
        case 'hour': low = high = 3600; break;
        case 'day': low = high = 86400; break;
        case 'week': low = high = 604800; break;
        case 'month': low = 28 * 86400; high = 31 * 86400; break;
        default: low = 365 * 86400; high = 366 * 86400; break;
      }
      return [count * low, (count + 1) * high];
    }
    return null;
  }

  function inferReverseOrder(items) {
    const playable = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item || item.available === false || item.unavailable || !/^[A-Za-z0-9_-]{11}$/.test(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      playable.push(item);
    }
    if (playable.length < 2) return false;

    const numbered = playable.map(item => ({
      number: episodeNumberFromTitle(item.title),
      seasonal: /\b(?:season|series|saison)\s*0*\d{1,3}\b/i.test(item.title)
    })).filter(item => Number.isFinite(item.number));
    if (numbered.length >= 2 && numbered.length * 5 >= playable.length * 3) {
      const seasonal = numbered[0].seasonal;
      if (numbered.some(item => item.seasonal !== seasonal)) return false;
      let direction = 0;
      for (let i = 1; i < numbered.length; i++) {
        const next = Math.sign(numbered[i].number - numbered[i - 1].number);
        if (!next || (direction && next !== direction)) return false;
        direction = next;
      }
      return direction < 0;
    }

    let dated = 0;
    let votes = 0;
    let direction = 0;
    let earliestUpper = Number.MAX_SAFE_INTEGER;
    let latestLower = Number.MIN_SAFE_INTEGER;
    for (const item of playable) {
      const age = episodeAgeRange(item.videoInfo);
      if (!age) continue;
      dated++;
      const older = age[0] >= earliestUpper;
      const newer = age[1] <= latestLower;
      if (older && newer) return false;
      const next = older ? -1 : newer ? 1 : 0;
      if (next) {
        if (direction && next !== direction) return false;
        direction = next;
        votes++;
      }
      earliestUpper = Math.min(earliestUpper, age[1]);
      latestLower = Math.max(latestLower, age[0]);
    }
    if (dated < 3 || dated * 5 < playable.length * 3 || votes < 2) return false;
    return direction < 0;
  }
  function orderedEpisodes(series) {
    const episodes = [...(series && series.episodes || [])].sort((a,b) => a.order - b.order);
    return series && series.playbackReverse ? episodes.reverse() : episodes;
  }

  function playlistIdsInDescription(description) {
    const ids = [];
    const seen = new Set();
    const urls = /https?:\/\/[^\s<>"']+/g;
    let match;
    while ((match = urls.exec(String(description || '').slice(0, 20000))) && ids.length < 4) {
      try {
        const parsed = new URL(match[0].replace(/[).,;]+$/, ''));
        const id = parsed.searchParams.get('list') || '';
        if (isDiscoveryPlaylistId(id) && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      } catch (_) {}
    }
    return ids;
  }

  function currentVideoDetails(videoId) {
    let playerResponse = null;
    try {
      const player = document.getElementById('movie_player');
      playerResponse = player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
    } catch (_) {}
    const initial = window.ytInitialPlayerResponse;
    const details = playerResponse && playerResponse.videoDetails
      || initial && initial.videoDetails;
    if (details && details.videoId === videoId) {
      const descriptionNode = document.querySelector('#description-inline-expander #content, ytd-text-inline-expander #content-text, #description ytd-text-inline-expander');
      const descriptionLinks = descriptionNode ? [...descriptionNode.querySelectorAll('a[href]')].map(a => a.href).join(' ') : '';
      return {
        id: videoId,
        title: String(details.title || videoTitle()),
        author: String(details.author || ''),
        channelId: String(details.channelId || ''),
        description: String(details.shortDescription || '') + ' ' + descriptionLinks
      };
    }
    const channel = document.querySelector('ytd-video-owner-renderer a[href*="/channel/"], #owner #channel-name a');
    const descriptionNode = document.querySelector('#description-inline-expander #content, ytd-text-inline-expander #content-text, #description ytd-text-inline-expander');
    let channelId = '';
    try {
      if (channel && channel.href) {
        const url = new URL(channel.href, location.origin);
        channelId = url.pathname.split('/channel/')[1]?.split(/[/?#]/)[0] || '';
      }
    } catch (_) {}
    const descriptionText = descriptionNode ? text(descriptionNode) : '';
    const descriptionLinks = descriptionNode ? [...descriptionNode.querySelectorAll('a[href]')].map(a => a.href).join(' ') : '';
    return {
      id: videoId,
      title: videoTitle(),
      author: text(channel),
      channelId,
      description: (descriptionText + ' ' + descriptionLinks).slice(0, 20000)
    };
  }
  function normalizeSearchTokens(value) {
    return String(value || '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2);
  }

  function parsePlaylistSearchCandidates(data, details) {
    const results = new Map();
    const expectedTitle = seriesSearchTitle(details.title).toLocaleLowerCase();
    const expectedTokens = new Set(normalizeSearchTokens(expectedTitle));
    const expectedSeason = /\b(?:season|series|saison)\s*0*(\d{1,3})\b/i.exec(details.title)?.[1] || '';
    let visited = 0;

    const addCandidate = (id, title, owner, thumb, ownerMatches) => {
      id = String(id || '');
      if (!isDiscoveryPlaylistId(id) || results.has(id)) return;
      title = String(title || id);
      owner = String(owner || '');
      const titleTokens = new Set(normalizeSearchTokens(title));
      let overlap = 0;
      for (const token of expectedTokens) if (titleTokens.has(token)) overlap++;
      let score = ownerMatches ? 1000 : 0;
      score += overlap * 8;
      if (expectedTitle && title.toLocaleLowerCase().includes(expectedTitle)) score += 60;
      const candidateSeason = /\b(?:season|series|saison)\s*0*(\d{1,3})\b/i.exec(title)?.[1] || '';
      if (expectedSeason && candidateSeason) score += expectedSeason === candidateSeason ? 80 : -80;
      results.set(id, { id, title, owner, thumb: String(thumb || ''), score, items: null, reverse: false });
    };

    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 24 || visited++ >= 20000) return;
      if (Array.isArray(node)) {
        for (const child of node) {
          if (visited >= 20000) break;
          visit(child, depth + 1);
        }
        return;
      }

      const lockup = node.lockupViewModel;
      if (lockup && lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
        const metadata = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
        const title = metadata && metadata.title && metadata.title.content || '';
        const imageSources = lockup.contentImage && lockup.contentImage.thumbnailViewModel
          && lockup.contentImage.thumbnailViewModel.image && lockup.contentImage.thumbnailViewModel.image.sources;
        const thumb = Array.isArray(imageSources) && imageSources.length ? imageSources[imageSources.length - 1].url : '';
        addCandidate(lockup.contentId, title, '', thumb, false);
      }

      for (const key of ['playlistRenderer', 'compactPlaylistRenderer', 'gridPlaylistRenderer']) {
        const playlist = node[key];
        if (!playlist) continue;
        const byline = playlist.shortBylineText || playlist.longBylineText || playlist.ownerText || null;
        const owner = rendererText(byline);
        let ownerMatches = false;
        for (const run of byline && byline.runs || []) {
          const browseId = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint && run.navigationEndpoint.browseEndpoint.browseId || '';
          if (details.channelId && browseId === details.channelId) ownerMatches = true;
        }
        const thumbnails = playlist.thumbnail && playlist.thumbnail.thumbnails;
        const thumb = Array.isArray(thumbnails) && thumbnails.length ? thumbnails[thumbnails.length - 1].url : '';
        addCandidate(playlist.playlistId, rendererText(playlist.title), owner, thumb, ownerMatches);
      }

      for (const key of Object.keys(node)) {
        if (visited >= 20000) break;
        visit(node[key], depth + 1);
      }
    };

    visit(data && (data.contents || data), 0);
    return [...results.values()].sort((a,b) => b.score - a.score).slice(0, 30);
  }

  function channelBrowseTabs(data) {
    const contents = data && data.contents || {};
    const browse = contents.twoColumnBrowseResultsRenderer || contents.singleColumnBrowseResultsRenderer || {};
    return Array.isArray(browse.tabs) ? browse.tabs : [];
  }

  function channelPlaylistEndpoint(data, channelId) {
    const externalId = data && data.metadata && data.metadata.channelMetadataRenderer
      && data.metadata.channelMetadataRenderer.externalId || '';
    if (externalId !== channelId) return '';
    for (const tab of channelBrowseTabs(data)) {
      const renderer = tab && tab.tabRenderer;
      const endpoint = renderer && renderer.endpoint && renderer.endpoint.browseEndpoint;
      if (renderer && renderer.title === 'Playlists'
          && endpoint && endpoint.browseId === channelId && endpoint.params) return String(endpoint.params);
    }
    return '';
  }

  function scopedContinuationTokens(root) {
    const tokens = new Set();
    let visits = 0;
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 18 || visits++ >= 10000) return;
      if (Array.isArray(node)) {
        for (const child of node) {
          if (visits >= 10000) break;
          visit(child, depth + 1);
        }
        return;
      }
      const direct = node.continuationItemRenderer
        && node.continuationItemRenderer.continuationEndpoint
        && node.continuationItemRenderer.continuationEndpoint.continuationCommand
        && node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      if (direct) tokens.add(String(direct));
      if (Array.isArray(node.continuations)) {
        for (const item of node.continuations) {
          const token = item && item.nextContinuationData && item.nextContinuationData.continuation;
          if (token) tokens.add(String(token));
        }
      }
      for (const key of ['sectionListRenderer','itemSectionRenderer','gridRenderer','richGridRenderer','richItemRenderer','content','contents','items','continuationItemRenderer','appendContinuationItemsAction','gridContinuation']) {
        if (node[key] !== undefined) visit(node[key], depth + 1);
      }
    };
    visit(root, 0);
    return tokens;
  }

  async function channelPlaylistCandidates(details, budget) {
    const channelId = String(details.channelId || '');
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return [];
    try {
      const home = await requestInnerTube('browse', { browseId: channelId }, budget);
      const params = channelPlaylistEndpoint(home, channelId);
      if (!params) return [];
      let response = await requestInnerTube('browse', { browseId: channelId, params }, budget);
      const externalId = response && response.metadata && response.metadata.channelMetadataRenderer
        && response.metadata.channelMetadataRenderer.externalId || '';
      if (externalId !== channelId) return [];

      const findPlaylistTab = payload => {
        const tabs = channelBrowseTabs(payload);
        return tabs.find(tab => tab && tab.tabRenderer && tab.tabRenderer.title === 'Playlists'
          && tab.tabRenderer.selected)
          || tabs.find(tab => tab && tab.tabRenderer && tab.tabRenderer.title === 'Playlists')
          || null;
      };
      const selected = findPlaylistTab(response);
      if (!selected || !selected.tabRenderer || !selected.tabRenderer.content) return [];
      const allCandidates = new Map();
      const ingest = root => {
        for (const candidate of parsePlaylistSearchCandidates({ contents: root }, details)) {
          allCandidates.set(candidate.id, {
            ...candidate,
            owner: candidate.owner || details.author || 'Channel playlists',
            // This channel's Playlists tab was verified against the video's own channel.
            score: candidate.score + 1000
          });
          if (allCandidates.size >= 96) break;
        }
      };
      let content = selected.tabRenderer.content;
      ingest(content);
      let tokens = scopedContinuationTokens(content);
      let pages = 0;
      const seenTokens = new Set();
      while (tokens.size === 1 && pages < 2 && allCandidates.size < 96
          && budget.requests < budget.maxRequests && Date.now() < budget.deadline) {
        const token = tokens.values().next().value;
        if (!token || seenTokens.has(token)) break;
        seenTokens.add(token);
        pages++;
        response = await requestInnerTube('browse', { continuation: token }, budget);
        let nextRoot = response && response.continuationContents && response.continuationContents.gridContinuation;
        if (!nextRoot) {
          const actions = response && (response.onResponseReceivedActions || response.onResponseReceivedEndpoints) || [];
          for (const action of actions) {
            const append = action && action.appendContinuationItemsAction;
            if (append && Array.isArray(append.continuationItems)) {
              nextRoot = { contents: append.continuationItems };
              break;
            }
          }
        }
        if (!nextRoot) break;
        ingest(nextRoot);
        tokens = scopedContinuationTokens(nextRoot);
      }
      return [...allCandidates.values()].sort((a,b) => b.score - a.score).slice(0, 30);
    } catch (error) {
      console.debug('[YouTube Series] channel playlist discovery unavailable:', error && error.message || error);
      return [];
    }
  }


  async function discoverPlaylistsForVideo(videoId) {
    const cached = discoveryCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return cached.matches;
    const details = currentVideoDetails(videoId);
    const budget = {
      requests: 0,
      bytes: 0,
      maxRequests: 18,
      maxBytes: 16 * 1024 * 1024,
      pageBytes: 5 * 1024 * 1024,
      deadline: Date.now() + 25000
    };
    const verified = [];
    const checked = new Set();
    const linked = playlistIdsInDescription(details.description);
    const verifyCandidate = async candidate => {
      if (checked.has(candidate.id) || budget.requests >= budget.maxRequests || Date.now() >= budget.deadline) return;
      checked.add(candidate.id);
      try {
        const catalog = await fetchFullPlaylist(candidate.id, { budget, maxPages: 18 });
        if (!catalog.items.some(item => item.id === videoId && item.available !== false && !item.unavailable)) return;
        verified.push({
          id: candidate.id,
          title: catalog.title || candidate.title || seriesSearchTitle(details.title) || details.title || candidate.id,
          owner: candidate.owner || '',
          thumb: catalog.items.find(item => item.available !== false && !item.unavailable)?.thumb || candidate.thumb || '',
          items: catalog.items,
          reverse: inferReverseOrder(catalog.items),
          score: Number(candidate.score || 0)
        });
      } catch (error) {
        console.debug('[YouTube Series] candidate catalog could not be verified:', candidate.id, error && error.message || error);
      }
    };
    for (const id of linked) await verifyCandidate({ id, title: '', owner: '', thumb: '', score: 2000 });
    if (verified.length) {
      const matches = verified.sort((a,b) => b.score - a.score);
      discoveryCache.set(videoId, { expiresAt: Date.now() + 60 * 60 * 1000, matches });
      return matches;
    }
    if (details.channelId && budget.requests < budget.maxRequests && Date.now() < budget.deadline) {
      const channelCandidates = await channelPlaylistCandidates(details, budget);
      for (const candidate of channelCandidates.slice(0, 8)) {
        if (budget.requests >= budget.maxRequests || Date.now() >= budget.deadline) break;
        await verifyCandidate(candidate);
        if (verified.length >= 4) break;
      }
      if (verified.length) {
        const matches = verified.sort((a,b) => b.score - a.score);
        discoveryCache.set(videoId, { expiresAt: Date.now() + 60 * 60 * 1000, matches });
        return matches;
      }
    }

    const seriesTitle = seriesSearchTitle(details.title) || details.title;
    const queries = [...new Set([
      (details.author ? details.author + ' ' : '') + seriesTitle,
      (details.author ? details.author + ' ' : '') + details.title
    ].map(value => value.trim().slice(0, 180)).filter(value => value.length >= 3))].slice(0, 2);
    const candidates = new Map();
    for (const query of queries) {
      if (budget.requests >= budget.maxRequests || Date.now() >= budget.deadline) break;
      try {
        const response = await requestInnerTube('search', { query, params: 'EgIQAw==' }, budget);
        for (const candidate of parsePlaylistSearchCandidates(response, details)) {
          const previous = candidates.get(candidate.id);
          if (!previous || candidate.score > previous.score) candidates.set(candidate.id, candidate);
        }
      } catch (error) {
        console.debug('[YouTube Series] playlist search unavailable:', error && error.message || error);
        break;
      }
    }
    for (const candidate of [...candidates.values()].sort((a,b) => b.score - a.score).slice(0, 8)) {
      if (budget.requests >= budget.maxRequests || Date.now() >= budget.deadline) break;
      await verifyCandidate(candidate);
      if (verified.length >= 4) break;
    }
    const matches = verified.sort((a,b) => b.score - a.score);
    discoveryCache.set(videoId, { expiresAt: Date.now() + (matches.length ? 60 : 5) * 60 * 1000, matches });
    return matches;
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
    const previousCatalog = Array.isArray(series.episodes) ? series.episodes : [];
    const previousIds = new Set(previousCatalog.filter(ep => ep.available !== false && !ep.unavailable).map(ep => ep.id));
    const newIds = new Set(Array.isArray(series.newEpisodeIds) ? series.newEpisodeIds : []);
    const oldByOccurrence = new Map();
    previousCatalog.forEach((ep,index) => {
      const order = Number.isInteger(ep.order) ? ep.order : index;
      oldByOccurrence.set(ep.id + ':' + order, { ...ep, order });
    });
    const usedOld = new Set();
    const merged = [];
    items.forEach((ep, i) => {
      const order = Number.isInteger(ep.order) && ep.order >= 0 ? ep.order : i;
      const occurrenceKey = ep.id + ':' + order;
      const prev = oldByOccurrence.get(occurrenceKey) || previousCatalog.find((oldEp,index) => !usedOld.has(index) && oldEp.id === ep.id);
      const prevIndex = prev ? previousCatalog.indexOf(prev) : -1;
      if (prevIndex >= 0) usedOld.add(prevIndex);
      const next = { ...prev, ...ep, order, unavailable: Boolean(ep.unavailable || ep.available === false) };
      merged.push(next);
      if (previousCatalog.length && !next.unavailable && !previousIds.has(next.id)) newIds.add(next.id);
      if (!next.unavailable && /^[A-Za-z0-9_-]{11}$/.test(ep.id)) {
        const st = stateFor(ep.id);
        setState(ep.id, { title: ep.title || st.title, duration: ep.duration || st.duration }, false);
      }
    });
    // Keep previously-known items that may be unavailable/removed, after the verified catalog.
    let tailOrder = merged.reduce((max, ep) => Math.max(max, Number.isInteger(ep.order) ? ep.order : -1), -1) + 1;
    previousCatalog.forEach((ep,index) => {
      if (usedOld.has(index)) return;
      if (merged.some(item => item.id === ep.id && item.order === ep.order)) return;
      merged.push({ ...ep, order: tailOrder++, unavailable: ep.manuallyAdded ? false : true });
    });
    series.title = title || series.title;
    if (typeof series.playbackReverse !== 'boolean') series.playbackReverse = inferReverseOrder(merged);
    series.episodes = merged;
    series.catalogRevision = (Number(series.catalogRevision) || 0) + 1;
    series.newEpisodeIds = [...newIds].filter(id => merged.some(ep => ep.id === id && ep.available !== false && !ep.unavailable));
    if (series.cursorVideoId) {
      const matches = merged.filter(ep => ep.id === series.cursorVideoId && ep.available !== false && !ep.unavailable);
      const exact = matches.find(ep => ep.order === series.cursorOrder);
      if (exact) {
        series.cursorRevision = series.catalogRevision;
        series.recoveryRequired = false;
        series.recoveryVideoId = '';
      } else if (matches.length === 1) {
        series.cursorOrder = matches[0].order;
        series.cursorRevision = series.catalogRevision;
        series.recoveryRequired = false;
        series.recoveryVideoId = '';
      } else {
        series.recoveryRequired = true;
        series.recoveryVideoId = series.cursorVideoId;
      }
    }
    if (series.startHereVideoId && !merged.some(ep => ep.id === series.startHereVideoId && ep.available !== false && !ep.unavailable)) {
      series.startHereVideoId = '';
      series.startHereOrder = -1;
    }
    series.updatedAt = Date.now();
    series.lastSyncedAt = Date.now();
    series.lastRefreshAttemptAt = Date.now();
    series.refreshRetryAt = 0;
    series.refreshError = '';
    db.lastSync = Date.now();
    saveDB();
    return series;
  }
  async function refreshSeries(seriesId, quiet = false) {
    const series = findSeries(seriesId);
    if (!series || !series.playlistId || syncBusy) return false;
    syncBusy = true;
    series.lastRefreshAttemptAt = Date.now();
    saveDB();
    if (!quiet) toast('Refreshing “' + series.title + '”…');
    try {
      const catalog = await fetchFullPlaylist(series.playlistId);
      const latest = findSeries(seriesId);
      if (!latest) return false;
      const merged = mergeSeries(seriesId, catalog.title || latest.title, catalog.items);
      merged.refreshRetryAt = 0;
      merged.refreshError = '';
      saveDB();
      renderPanel();
      if (!quiet) toast('Refreshed “' + merged.title + '” · ' + merged.episodes.length + ' episodes.');
      return true;
    } catch (error) {
      const latest = findSeries(seriesId);
      if (latest) {
        latest.refreshRetryAt = Date.now() + 30 * 60 * 1000;
        latest.refreshError = String(error?.message || 'Catalog refresh failed').slice(0, 240);
        saveDB();
      }
      if (!quiet) toast((error?.message || 'Could not refresh playlist.') + ' The saved catalog was kept.');
      return false;
    } finally {
      syncBusy = false;
    }
  }
  async function refreshStaleSeries() {
    if (!db.settings.catalogAutoRefresh || staleRefreshBusy || syncBusy) return;
    staleRefreshBusy = true;
    try {
      const due = db.series.filter(series => catalogRefreshDue(series)).slice(0, 2);
      for (const series of due) {
        if (syncBusy) break;
        await refreshSeries(series.id, true);
      }
    } finally {
      staleRefreshBusy = false;
    }
  }
  async function syncCurrentPlaylist() {
    const id = getPlaylistId();
    if (!id) { toast('Open a YouTube playlist first.'); return; }
    const existing = findSeries(id);
    if (existing) { await refreshSeries(id,false); return; }
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
      toast((e.message || 'Playlist sync failed.') + ' Existing saved episodes were kept; no partial catalog was saved.');
    } finally { syncBusy = false; }
  }
  function stats(s) {
    const eps = s.episodes || [];
    const playable = eps.filter(e => e.available !== false && !e.unavailable && /^[A-Za-z0-9_-]{11}$/.test(e.id));
    const watched = playable.filter(e => isWatched(e.id)).length;
    const active = playable.filter(e => !isWatched(e.id) && stateFor(e.id).position > 5).length;
    const left = playable.reduce((n,e) => {
      const st = stateFor(e.id);
      return n + (isWatched(e.id) ? 0 : Math.max(0, (st.duration || e.duration || 0) - (st.position || 0)));
    }, 0);
    return {
      total: eps.length,
      playable: playable.length,
      watched,
      active,
      newCount: Array.isArray(s.newEpisodeIds) ? s.newEpisodeIds.length : 0,
      pct: playable.length ? Math.round(watched / playable.length * 100) : 0,
      left
    };
  }
  function progress(e) {
    if (e.unavailable || e.available === false || !/^[A-Za-z0-9_-]{11}$/.test(e.id)) return 0;
    const st = stateFor(e.id);
    if (isWatched(e.id)) return 100;
    const d = st.duration || e.duration || 0;
    return d ? Math.max(0, Math.min(99, st.position / d * 100)) : 0;
  }
  function currentPlaylistIndex(url) {
    try {
      const value = new URL(url || location.href, location.origin).searchParams.get('index');
      const index = Number(value);
      return Number.isInteger(index) && index > 0 ? index - 1 : -1;
    } catch (_) {
      return -1;
    }
  }

  function episodeOccurrence(series, videoId, requestedOrder) {
    const episodes = (series && series.episodes || []).filter(e =>
      e && e.id === videoId && e.available !== false && !e.unavailable && /^[A-Za-z0-9_-]{11}$/.test(e.id));
    if (Number.isInteger(requestedOrder) && requestedOrder >= 0) {
      const exact = episodes.find(e => e.order === requestedOrder);
      if (exact) return exact;
    }
    return episodes[0] || null;
  }
  function catalogRefreshDue(series, now = Date.now()) {
    if (!series?.playlistId) return false;
    const fetchedAt = Number(series.lastSyncedAt) || 0;
    const attemptedAt = Number(series.lastRefreshAttemptAt) || 0;
    const retryAt = Number(series.refreshRetryAt) || 0;
    return now >= retryAt
      && (!attemptedAt || now - attemptedAt >= 30 * 60 * 1000)
      && (!fetchedAt || now < fetchedAt || now - fetchedAt >= 6 * 60 * 60 * 1000);
  }
  function resumePlan(series) {
    const episodes = orderedEpisodes(series).filter(ep =>
      ep.available !== false && !ep.unavailable && /^[A-Za-z0-9_-]{11}$/.test(ep.id));
    if (!episodes.length) return { kind: 'NO_PLAYABLE', episode: null, position: 0 };
    const startHere = series.startHereVideoId
      ? episodes.find(ep => ep.id === series.startHereVideoId && (!Number.isInteger(series.startHereOrder) || ep.order === series.startHereOrder))
      : null;
    if (startHere) return { kind: 'RESUME', episode: startHere, position: 0 };
    if (series.cursorVideoId) {
      const matches = episodes.filter(ep => ep.id === series.cursorVideoId);
      const exact = matches.find(ep => ep.order === series.cursorOrder);
      const sameRevision = Number(series.cursorRevision || 0) === Number(series.catalogRevision || 0);
      if (exact) {
        if (!sameRevision) {
          series.cursorRevision = Number(series.catalogRevision) || 0;
          series.recoveryRequired = false;
          series.recoveryVideoId = '';
          saveDB();
        }
        if (!isWatched(exact.id)) return { kind: 'RESUME', episode: exact, position: stateFor(exact.id).position || 0 };
        const next = episodes.find(ep => ep.order > exact.order && !isWatched(ep.id));
        return next ? { kind: 'NEXT', episode: next, position: stateFor(next.id).position || 0 }
          : { kind: 'CAUGHT_UP', episode: null, position: 0 };
      }
      if (matches.length === 1) {
        series.cursorOrder = matches[0].order;
        series.cursorRevision = Number(series.catalogRevision) || 0;
        series.recoveryRequired = false;
        series.recoveryVideoId = '';
        saveDB();
        if (!isWatched(matches[0].id)) return { kind: 'RESUME', episode: matches[0], position: stateFor(matches[0].id).position || 0 };
      } else {
        series.recoveryRequired = true;
        series.recoveryVideoId = series.cursorVideoId;
        return { kind: 'CHOOSE', episode: null, position: 0 };
      }
    }
    const occurrences = new Map();
    for (const ep of episodes) occurrences.set(ep.id, (occurrences.get(ep.id) || 0) + 1);
    const recent = episodes
      .filter(ep => !isWatched(ep.id) && stateFor(ep.id).position > 5 && occurrences.get(ep.id) === 1)
      .sort((a,b) => (stateFor(b.id).updatedAt || 0) - (stateFor(a.id).updatedAt || 0))[0];
    if (recent) return { kind: 'RESUME', episode: recent, position: stateFor(recent.id).position || 0 };
    const first = episodes.find(ep => !isWatched(ep.id));
    return first ? { kind: 'RESUME', episode: first, position: stateFor(first.id).position || 0 }
      : { kind: 'CAUGHT_UP', episode: null, position: 0 };
  }
  function acknowledgeNewEpisodes(seriesId) {
    const series = findSeries(seriesId);
    if (!series || !series.newEpisodeIds?.length) return false;
    series.newEpisodeIds = [];
    saveDB();
    renderPanel();
    return true;
  }
  function chooseContinue(s) {
    return resumePlan(s).episode;
  }
  function chooseNext(s, id, requestedOrder) {
    const eps = orderedEpisodes(s).filter(e =>
      e.available !== false && !e.unavailable && /^[A-Za-z0-9_-]{11}$/.test(e.id));
    let idx = Number.isInteger(requestedOrder)
      ? eps.findIndex(e => e.id === id && e.order === requestedOrder)
      : -1;
    if (idx < 0) idx = eps.findIndex(e => e.id === id);
    if (idx >= 0) return eps.slice(idx + 1).find(e => !isWatched(e.id)) || null;
    return chooseContinue(s);
  }
  function navigateSeries(direction) {
    const videoId=getVideoId(), listId=getPlaylistId();
    let series=activePlaybackSession?findSeries(activePlaybackSession.seriesId):null;
    if(!series||!series.episodes.some(ep=>ep.id===videoId)){
      const candidates=db.series.filter(item=>episodeOccurrence(item,videoId,item.playlistId===listId?currentPlaylistIndex():-1));
      series=candidates.length===1?candidates[0]:null;
    }
    if(!series){toast('This video is not in a followed series.');return false;}
    const requestedOrder=series.playlistId===listId?currentPlaylistIndex():-1;
    const occurrence=episodeOccurrence(series,videoId,requestedOrder);
    if(!occurrence){toast('Could not identify this episode occurrence.');return false;}
    const episodes=orderedEpisodes(series).filter(ep=>ep.available!==false&&!ep.unavailable&&/^[A-Za-z0-9_-]{11}$/.test(ep.id));
    const index=episodes.findIndex(ep=>ep.id===videoId&&ep.order===occurrence.order);
    const target=episodes[index+direction];
    if(!target){toast(direction<0?'This is the first episode.':'This is the last episode.');return false;}
    openEpisode(series,target,true);
    return true;
  }

  function openEpisode(s, e, resume = true) {
    if (!s || !e || e.unavailable || e.available === false || !/^[A-Za-z0-9_-]{11}$/.test(e.id)) return;
    const st = stateFor(e.id);
    const startsHere = s.startHereVideoId === e.id && (!Number.isInteger(s.startHereOrder) || s.startHereOrder === e.order);
    if (startsHere) { s.startHereVideoId = ''; s.startHereOrder = -1; }
    s.cursorVideoId = e.id;
    s.cursorOrder = Number.isInteger(e.order) ? e.order : undefined;
    s.cursorUpdatedAt = Date.now();
    s.cursorRevision = Number(s.catalogRevision) || 0;
    activePlaybackSession = {seriesId:s.id,videoId:e.id,order:e.order,catalogRevision:Number(s.catalogRevision)||0};
    saveDB();
    location.href = urlFor(e.id, s.playlistId, s.playlistId ? e.order : undefined, resume && !startsHere && !isWatched(e.id) ? st.position : 0);
  }
  function setSeriesStartHere(series, episode) {
    if (!series || !episode || episode.available === false || episode.unavailable || !/^[A-Za-z0-9_-]{11}$/.test(episode.id)) return false;
    rememberDatabaseUndo('set start episode');
    series.startHereVideoId = episode.id;
    series.startHereOrder = Number.isInteger(episode.order) ? episode.order : -1;
    series.cursorVideoId = episode.id;
    series.cursorOrder = series.startHereOrder;
    series.cursorUpdatedAt = Date.now();
    series.cursorRevision = Number(series.catalogRevision) || 0;
    saveDB();
    renderPanel();
    toast('Continue watching will start here: ' + (episode.title || 'selected episode'));
    return true;
  }
  function markEpisode(id, watched) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    const st = stateFor(id);
    rememberUndo([id], watched ? 'mark episode watched' : 'mark episode unwatched');
    setState(id, { watched, completionOverride: watched ? 'WATCHED' : 'UNWATCHED', position: watched ? (st.duration || st.position) : 0 });
    renderPanel();
    toast('Episode status updated. Use Undo to reverse.');
  }
  function episodeHTML(s,e) {
    const unavailable = Boolean(e.unavailable || e.available === false || !/^[A-Za-z0-9_-]{11}$/.test(e.id));
    const st = unavailable ? { watched:false, position:0, duration:e.duration||0 } : stateFor(e.id);
    const watched = !unavailable && isWatched(e.id);
    const p = progress(e);
    const status = unavailable ? 'Unavailable on YouTube' : watched ? 'Watched' : st.position > 5 ? Math.round(p) + '% watched · ' + fmt(st.position) + ' / ' + fmt(st.duration || e.duration) : 'Not watched';
    const thumbnail = e.thumb || (/^[A-Za-z0-9_-]{11}$/.test(e.id) ? 'https://i.ytimg.com/vi/' + e.id + '/hqdefault.jpg' : '');
    return '<article class="yst2-ep ' + (watched ? 'is-watched' : '') + (unavailable ? ' is-unavailable' : '') + '">'
      + (thumbnail ? '<img class="yst2-thumb" loading="lazy" alt="" src="' + esc(thumbnail) + '">' : '<div class="yst2-thumb yst2-thumb-empty" aria-hidden="true">—</div>')
      + '<div class="yst2-epbody"><button class="yst2-epname" data-play="' + esc(e.id) + '" data-sid="' + esc(s.id) + '" data-order="' + esc(e.order) + '"' + (unavailable ? ' disabled aria-disabled="true"' : '') + '>'
      + esc(e.title || (unavailable ? 'Unavailable video' : st.title || e.id)) + '</button>'
      + '<div class="yst2-muted">' + esc(status) + (!unavailable && (st.duration || e.duration) ? ' · ' + fmt(st.duration || e.duration) : '') + '</div>'
      + '<div class="yst2-bar"><i style="width:' + p + '%"></i></div></div>'
      + '<button class="yst2-mark ' + (watched ? 'checked' : '') + '" data-mark="' + esc(e.id) + '" title="' + (watched ? 'Mark unwatched' : 'Mark watched') + '"' + (unavailable ? ' disabled aria-disabled="true"' : '') + '>' + (watched ? '✓' : '○') + '</button>'
      + '<button class="yst2-through" data-through="' + esc(e.id) + '" data-sid="' + esc(s.id) + '" data-order="' + esc(e.order) + '" title="Mark watched through this episode" aria-label="Mark watched through this episode"' + (unavailable ? ' disabled aria-disabled="true"' : '') + '>⇢</button>'
      + '<button class="yst2-start-here" data-start-here="' + esc(e.id) + '" data-sid="' + esc(s.id) + '" data-order="' + esc(e.order) + '" title="Continue this series from this episode" aria-label="Continue this series from this episode"' + (unavailable ? ' disabled aria-disabled="true"' : '') + '>↳</button>'
      + '</article>';
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

  function showRecoveryChooser(series) {
    if (!series) return;
    const panel = document.getElementById(PANEL);
    if (!panel) return;
    panel.querySelector('#yst2-recovery-dialog')?.remove();
    const remembered = series.recoveryVideoId || series.cursorVideoId || '';
    const occurrences = orderedEpisodes(series).filter(ep => ep.available !== false && !ep.unavailable && /^[A-Za-z0-9_-]{11}$/.test(ep.id));
    const modal = document.createElement('div');
    modal.id = 'yst2-recovery-dialog';
    modal.className = 'yst2-modal-backdrop';
    modal.innerHTML = '<section class="yst2-modal" role="dialog" aria-modal="true" aria-labelledby="yst2-recovery-title">'
      + '<header class="yst2-modal-head"><div><h3 id="yst2-recovery-title">Choose where to continue</h3><p class="yst2-muted">The playlist changed, so the saved episode position needs your confirmation.</p></div>'
      + '<button type="button" class="yst2-icon" data-recovery-close aria-label="Close">×</button></header>'
      + '<p class="yst2-muted">' + (remembered ? 'Previous saved video: ' + esc(remembered) : 'Select an episode to continue from.') + '</p>'
      + '<div class="yst2-candidate-list">' + occurrences.map(ep => '<button class="yst2-candidate" type="button" data-recovery-episode="' + esc(ep.id) + '" data-order="' + esc(ep.order) + '">'
        + '<span class="yst2-candidate-copy"><strong>' + esc(ep.title || ep.id) + '</strong><small>' + (isWatched(ep.id) ? 'Watched' : (stateFor(ep.id).position > 5 ? 'Resume at ' + fmt(stateFor(ep.id).position) : 'Not started')) + '</small></span><span class="yst2-candidate-arrow">›</span></button>').join('')
      + '</div><button type="button" class="yst2-subbtn" data-recovery-close>Cancel</button></section>';
    panel.appendChild(modal);
    modal.querySelectorAll('[data-recovery-episode]').forEach(button => button.addEventListener('click', () => {
      const episode = occurrences.find(ep => ep.id === button.dataset.recoveryEpisode && ep.order === Number(button.dataset.order));
      if (!episode) return;
      series.cursorVideoId = episode.id;
      series.cursorOrder = episode.order;
      series.cursorRevision = Number(series.catalogRevision) || 0;
      series.cursorUpdatedAt = Date.now();
      series.recoveryRequired = false;
      series.recoveryVideoId = '';
      series.startHereVideoId = '';
      series.startHereOrder = -1;
      saveDB();
      modal.remove();
      renderPanel();
      openEpisode(series, episode);
    }));
    modal.querySelectorAll('[data-recovery-close]').forEach(button => button.addEventListener('click', () => modal.remove()));
    modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') modal.remove(); });
  }

  function seriesHTML(s) {
    const st = stats(s), plan = resumePlan(s), cont = plan.episode;
    const coverEpisode = orderedEpisodes(s).find(e => e.available !== false && !e.unavailable && /^[A-Za-z0-9_-]{11}$/.test(e.id));
    const cover = coverEpisode?.thumb || (coverEpisode?.id ? 'https://i.ytimg.com/vi/' + coverEpisode.id + '/hqdefault.jpg' : '');
    return '<section class="yst2-series yst2-filter-item" data-series-card="' + esc(s.id) + '">'
      + '<div class="yst2-series-overview">'
      + '<div class="yst2-series-art">' + (cover ? '<img loading="lazy" src="' + esc(cover) + '" alt="">' : '<div class="yst2-series-art-placeholder">▶</div>') + '<span>' + st.total + ' eps</span></div>'
      + '<div class="yst2-series-info"><header class="yst2-serieshead">'
      + '<div class="yst2-seriestitle">' + esc(s.title) + '</div>'
      + (st.newCount ? '<button class="yst2-new-count" data-ack-new="' + esc(s.id) + '" title="Acknowledge new episodes">+' + st.newCount + ' new</button>' : '')
      + (s.playlistId ? '<button class="yst2-icon" data-sync="' + esc(s.id) + '" title="Refresh entire playlist" aria-label="Refresh ' + esc(s.title) + '">↻</button>' : '<span class="yst2-manual-label">Manual</span>')
      + (s.playlistId ? '<button class="yst2-icon" data-open-playlist="' + esc(s.id) + '" title="Open playlist in YouTube" aria-label="Open playlist in YouTube">↗</button>' : '')
      + '<button class="yst2-icon" data-hide-watched="' + esc(s.id) + '" title="' + (s.hideWatched ? 'Show watched episodes' : 'Hide watched episodes') + '" aria-label="' + (s.hideWatched ? 'Show watched episodes' : 'Hide watched episodes') + '">' + (s.hideWatched ? '◉' : '◌') + '</button>'
      + '<button class="yst2-icon" data-order="' + esc(s.id) + '" title="' + (s.playbackReverse ? 'Use playlist order' : 'Use chronological episode order') + '" aria-label="Change episode order">⇅</button>'
      + '<button class="yst2-icon" data-edit="' + esc(s.id) + '" title="Rename series" aria-label="Rename ' + esc(s.title) + '">✎</button>'
      + '<button class="yst2-icon danger" data-remove="' + esc(s.id) + '" title="Remove series" aria-label="Remove ' + esc(s.title) + '">×</button>'
      + '</header><div class="yst2-muted">' + st.watched + '/' + st.playable + ' playable watched <span class="yst2-dot">·</span> ' + st.active + ' in progress</div>'
      + '<div class="yst2-bar big" role="progressbar" aria-label="' + esc(s.title) + ' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + st.pct + '"><i style="width:' + st.pct + '%"></i></div>'
      + '<div class="yst2-series-footline"><span class="yst2-progress-label">' + st.pct + '% complete</span>' + (st.left ? '<span>' + fmt(st.left) + ' left</span>' : '') + '</div>'
      + (plan.kind === 'CHOOSE' ? '<button class="yst2-continue" data-recovery="' + esc(s.id) + '"><span class="yst2-continue-icon">↗</span><span class="yst2-continue-copy"><strong>Choose where to continue</strong><small>The playlist changed; select an episode</small></span></button>' : cont ? '<button class="yst2-continue" data-continue="' + esc(s.id) + '"><span class="yst2-continue-icon">▶</span><span class="yst2-continue-copy"><strong>Continue watching</strong><small>' + esc(cont.title) + '</small></span><span class="yst2-continue-arrow">↗</span></button>' : plan.kind === 'NO_PLAYABLE' ? '<div class="yst2-done">No playable episodes in this playlist</div>' : '<div class="yst2-done">✓ All episodes watched</div>')
      + '</div></div>'
      + '<details class="yst2-details" data-series-details="' + esc(s.id) + '"><summary><span>Episodes</span><span class="yst2-summary-count">' + st.total + '</span><span class="yst2-summary-spacer"></span><span class="yst2-summary-hint">View list</span><span class="yst2-chevron">⌄</span></summary>'
      + '<div class="yst2-episode-list" data-episode-list="' + esc(s.id) + '" data-offset="0"></div>'
      + '<button class="yst2-subbtn yst2-load-more" type="button" data-load-more="' + esc(s.id) + '" hidden>Load more episodes</button>'
      + '</details></section>';
  }
  function bindEpisodeBatch(article) {
    const play = article.querySelector('[data-play]');
    play?.addEventListener('click', () => {
      if (play.disabled) return;
      const series = db.series.find(item => item.id === play.dataset.sid);
      const episode = series?.episodes.find(item => item.id === play.dataset.play && item.available !== false && !item.unavailable);
      if (series && episode) openEpisode(series, episode);
    });
    const mark = article.querySelector('[data-mark]');
    mark?.addEventListener('click', () => {
      if (!mark.disabled) markEpisode(mark.dataset.mark, !isWatched(mark.dataset.mark));
    });
    const through = article.querySelector('[data-through]');
    through?.addEventListener('click', () => {
      if (through.disabled) return;
      const series = db.series.find(item => item.id === through.dataset.sid);
      const episode = series?.episodes.find(item => item.id === through.dataset.through && item.order === Number(through.dataset.order));
      if (series && episode) markThrough(series, episode);
    });
    const start = article.querySelector('[data-start-here]');
    start?.addEventListener('click', () => {
      if (start.disabled) return;
      const series = db.series.find(item => item.id === start.dataset.sid);
      const episode = series?.episodes.find(item => item.id === start.dataset.startHere && item.order === Number(start.dataset.order));
      if (series && episode) setSeriesStartHere(series, episode);
    });
  }

  function appendEpisodeBatch(details, requestedTotal) {
    const series = db.series.find(item => item.id === details.dataset.seriesDetails);
    const list = details.querySelector('[data-episode-list]');
    const more = details.querySelector('[data-load-more]');
    if (!series || !list || !more) return;
    const episodes = orderedEpisodes(series).filter(episode => !series.hideWatched || !isWatched(episode.id));
    const offset = list.children.length;
    if (offset >= episodes.length) {
      more.hidden = true;
      return;
    }
    const target = Number.isInteger(requestedTotal)
      ? Math.min(episodes.length, Math.max(offset + 1, requestedTotal))
      : Math.min(episodes.length, offset + EPISODE_BATCH_SIZE);
    const batch = episodes.slice(offset, target);
    const html = batch.map(episode => episodeHTML(series, episode)).join('');
    list.insertAdjacentHTML('beforeend', html);
    for (const article of Array.from(list.children).slice(offset)) bindEpisodeBatch(article);
    list.dataset.offset = String(list.children.length);
    const remaining = episodes.length - list.children.length;
    more.hidden = remaining <= 0;
    more.textContent = remaining > 0 ? 'Load next ' + Math.min(EPISODE_BATCH_SIZE, remaining) + ' (' + remaining + ' remaining)' : 'All episodes loaded';
  }

  function renderPanel() {
    const p = document.getElementById(PANEL); if (!p) return;
    const episodeUiState = new Map();
    p.querySelectorAll('details[data-series-details]').forEach(details => {
      const list = details.querySelector('[data-episode-list]');
      episodeUiState.set(details.dataset.seriesDetails, {
        open: details.open,
        loaded: list ? list.children.length : 0,
        scrollTop: list ? list.scrollTop : 0
      });
    });
    const allEpisodes = db.series.flatMap(s => s.episodes || []).filter(e => e.available !== false && !e.unavailable && /^[A-Za-z0-9_-]{11}$/.test(e.id));
    const total = allEpisodes.length;
    const watched = allEpisodes.filter(e => isWatched(e.id)).length;
    const allCont = db.series.map(s=>({s,e:chooseContinue(s)})).filter(x=>x.e);
    const pct = total ? Math.round(watched / total * 100) : 0;
    const historyCount = Object.keys(db.history).length;
    let body = '';
    if (activeTab === 'library') body = db.series.length ? db.series.map(seriesHTML).join('') :
      `<div class="yst2-empty"><div class="yst2-empty-art"><span>▶</span></div><h3>Your library starts here</h3><p>Collect playlists or add individual videos to build a personal watchlist. Your progress stays in this browser.</p><div class="yst2-empty-actions"><button id="yst2-empty-add" class="yst2-mainbtn">＋ Add current video</button><button id="yst2-empty-sync" class="yst2-subbtn">Sync a playlist</button></div></div>`;
    if (activeTab === 'continue') body = allCont.length ? allCont.map(({s,e})=>
      `<section class="yst2-series yst2-filter-item"><div class="yst2-continue-series-title">${esc(s.title)}</div>${episodeHTML(s,e)}<button class="yst2-continue" data-continue="${esc(s.id)}"><span class="yst2-continue-icon">▶</span><span class="yst2-continue-copy"><strong>Resume episode</strong><small>${esc(e.title)}</small></span><span class="yst2-continue-arrow">↗</span></button></section>`).join('') :
      `<div class="yst2-empty"><div class="yst2-empty-art"><span>Ⅱ</span></div><h3>All caught up?</h3><p>When you start an episode, your in-progress videos will show up here for quick resuming.</p></div>`;
    if (activeTab === 'history') body = renderHistory();
    if (activeTab === 'settings') body = settingsHTML();
    const tabs = [
      ['library','Library',db.series.length],
      ['continue','Continue',allCont.length],
      ['history','History',historyCount],
      ['settings','Settings',null]
    ];
    p.innerHTML = `<header class="yst2-top">
        <div class="yst2-brand-row"><div class="yst2-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8ZM9.6 15.6V8.4L15.9 12l-6.3 3.6Z"/></svg></div>
          <div><div class="yst2-logo">Series Tracker</div><div class="yst2-tagline">Your YouTube, in order.</div></div></div>
        <button id="yst2-close" class="yst2-icon yst2-close" aria-label="Close tracker" title="Close">×</button>
      </header>
      <section id="yst2-dashboard" class="yst2-dashboard" aria-label="Your tracking overview">
        <div class="yst2-metric"><span>Series</span><strong>${db.series.length}</strong></div>
        <div class="yst2-metric"><span>Episodes</span><strong>${total}</strong></div>
        <div class="yst2-metric"><span>Watched</span><strong>${pct}<small>%</small></strong></div>
        <div class="yst2-overall-progress"><div class="yst2-overall-label"><span>Overall progress</span><span>${watched} of ${total}</span></div><div class="yst2-bar big" role="progressbar" aria-label="Overall progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div></div>
      </section>
      <section class="yst2-toolbar" aria-label="Tracker actions">
        <div class="yst2-primary-actions"><button id="yst2-add-current" class="yst2-mainbtn"><span aria-hidden="true">＋</span> Add video</button><button id="yst2-sync" class="yst2-subbtn"><span aria-hidden="true">↻</span> Sync playlist</button></div>
        <div class="yst2-data-actions"><button id="yst2-export" class="yst2-icon" title="Export backup" aria-label="Export backup">⇩</button><button id="yst2-import" class="yst2-icon" title="Import backup" aria-label="Import backup">⇧</button></div>
      </section>
      <nav class="yst2-tabs" role="tablist" aria-label="Tracker sections">${tabs.map(([k,v,count])=>`<button role="tab" data-tab="${k}" aria-selected="${activeTab===k?'true':'false'}" class="${activeTab===k?'active':''}"><span>${v}</span>${count===null?'':`<span class="yst2-tab-count">${count}</span>`}</button>`).join('')}</nav>
      ${activeTab === 'settings' ? '' : `<div class="yst2-searchwrap"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 5 5"></path></svg><input id="yst2-search" type="search" value="${esc(librarySearch)}" placeholder="${activeTab==='history'?'Search history matches':'Search series and episodes'}" aria-label="Search ${activeTab==='history'?'history matches':'series and episodes'}"><kbd>⌕</kbd></div>`}
      <div id="yst2-search-empty" class="yst2-search-empty" hidden>No matches. Try another title.</div>
      <div class="yst2-content">${body}</div>
      <footer class="yst2-footer"><span class="yst2-privacy"><span></span> Stored locally in this browser</span><span>${db.lastSync?`Synced ${new Date(db.lastSync).toLocaleDateString()}`:'Not synced yet'}</span>${lastUndo?'<button id="yst2-undo" class="yst2-subbtn" type="button">Undo last change</button>':''}</footer>`;
    bindPanel();
    for (const [id, state] of episodeUiState) {
      const details = p.querySelector('details[data-series-details="' + CSS.escape(id) + '"]');
      if (!details) continue;
      details.open = state.open;
      if (state.loaded > 0) {
        while (details.querySelector('[data-episode-list]').children.length < state.loaded) {
          const before = details.querySelector('[data-episode-list]').children.length;
          appendEpisodeBatch(details, state.loaded);
          const after = details.querySelector('[data-episode-list]').children.length;
          if (after <= before) break;
        }
        const list = details.querySelector('[data-episode-list]');
        if (list) list.scrollTop = state.scrollTop;
      }
    }
  }
  function settingsHTML() {
    const s = db.settings;
    return `<section class="yst2-series"><h3>Playback & tracking</h3>
      <label class="yst2-setting">Mark watched at <select id="yst2-threshold">
        ${[[0.5,'50%'],[0.75,'75%'],[0.9,'90%'],[0.95,'95%'],[1,'Video ends only']].map(([v,l])=>`<option value="${v}" ${Number(s.watchedThreshold)===v?'selected':''}>${l}</option>`).join('')}
      </select></label>
      <label class="yst2-setting">Complete when this much time remains <select id="yst2-remaining">${[[0,'Disabled'],[15,'15 seconds'],[30,'30 seconds'],[60,'1 minute'],[90,'90 seconds']].map(([v,l])=>`<option value="${v}" ${Number(s.watchedRemainingSeconds ?? AUTO_WATCHED_REMAINING_SECONDS)===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-autonext" ${s.autoNext?'checked':''}> Automatically play the next unwatched episode when a tracked episode ends</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-autosync" ${s.autoSyncOnOpen?'checked':''}> Automatically refresh the current tracked playlist when opened</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-sidebar" ${s.showSidebarButton!==false?'checked':''}> Show Series in YouTube navigation</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-player-visible" ${s.showPlayerButton!==false?'checked':''}> Show Series and previous/next controls in the player</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-record-progress" ${s.recordPlaybackProgress!==false?'checked':''}> Record local playback progress for followed episodes</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-import-history" ${s.importHistoryProgress?'checked':''}> Use visible History progress bars for completion</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-auto-catalog" ${s.catalogAutoRefresh!==false?'checked':''}> Refresh stale followed playlists automatically</label>
      <label class="yst2-setting"><input type="checkbox" id="yst2-historyscan" ${s.historyScan?'checked':''}> Match YouTube History page videos to known episodes</label>
      <p class="yst2-muted">History import uses only progress indicators currently rendered on the History page. It never reads account identifiers or sends progress to a server.</p>
      <button id="yst2-clear-progress" class="yst2-subbtn">Clear playback progress (keep series)</button>
      <button id="yst2-clear-history" class="yst2-subbtn">Clear History matches</button>
      <p class="yst2-muted">Progress is stored in this Firefox profile on YouTube. It does not sync to Morphe or your Google account. You can export a backup at any time.</p>
      <button id="yst2-clear" class="yst2-subbtn dangerbtn">Delete all series and progress</button></section>
      <section class="yst2-series"><h3>Data tools</h3><button id="yst2-recount" class="yst2-subbtn">Recalculate watched status from saved positions</button><button id="yst2-markall" class="yst2-subbtn">Mark current series watched</button></section>`;
  }
  function renderHistory() {
    const rows = Object.entries(db.history).sort((a,b)=>(b[1].lastSeen||0)-(a[1].lastSeen||0)).slice(0,100);
    if (!rows.length) return `<div class="yst2-empty"><h3>No history matches yet</h3><p>Open YouTube History while logged in; the tracker will match visible videos against your saved series.</p><button id="yst2-scanhistory" class="yst2-mainbtn">Scan current History page</button></div>`;
    return `<section class="yst2-series"><div class="yst2-history-heading"><div><h3>History matches</h3><div class="yst2-muted">${rows.length} tracked videos found in your history</div></div><button id="yst2-scanhistory" class="yst2-subbtn">↻ Scan again</button></div>${rows.map(([id,h])=>`<article class="yst2-ep yst2-filter-item yst2-history-row"><img class="yst2-thumb" loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg"><div class="yst2-epbody"><button class="yst2-epname" data-history-play="${esc(id)}">${esc(h.title||stateFor(id).title||id)}</button><div class="yst2-muted">Seen ${new Date(h.lastSeen||Date.now()).toLocaleDateString()}</div></div><span class="yst2-history-play" aria-hidden="true">↗</span></article>`).join('')}</section>`;
  }
  function bindPanel() {
    const p = document.getElementById(PANEL);
    p.querySelector('#yst2-close')?.addEventListener('click', closePanel);
    p.querySelector('#yst2-empty-add')?.addEventListener('click', showAddVideoDialog);
    p.querySelector('#yst2-empty-sync')?.addEventListener('click', syncCurrentPlaylist);
    const search = p.querySelector('#yst2-search');
    const applySearch = () => {
      if (!search) return;
      librarySearch = search.value;
      const query = librarySearch.trim().toLocaleLowerCase();
      let visible = 0;
      p.querySelectorAll('.yst2-filter-item').forEach(item => {
        let haystack = item.textContent.toLocaleLowerCase();
        const seriesId = item.dataset.seriesCard || item.querySelector('[data-continue]')?.dataset.continue || '';
        const series = seriesId ? db.series.find(value => value.id === seriesId) : null;
        if (series) haystack += ' ' + [series.title, ...series.episodes.map(ep => ep.title || '')].join(' ').toLocaleLowerCase();
        const show = !query || haystack.includes(query);
        item.hidden = !show;
        if (show) visible++;
      });
      const empty = p.querySelector('#yst2-search-empty');
      if (empty) empty.hidden = !query || visible > 0;
    };
    search?.addEventListener('input', applySearch);
    applySearch();
    p.querySelector('#yst2-add-current')?.addEventListener('click', showAddVideoDialog);
    p.querySelector('#yst2-sync')?.addEventListener('click', syncCurrentPlaylist);
    p.querySelectorAll('details[data-series-details]').forEach(details => {
      details.addEventListener('toggle', () => {
        if (details.open && details.querySelector('[data-episode-list]')?.children.length === 0) {
          appendEpisodeBatch(details);
        }
      });
      details.querySelector('[data-load-more]')?.addEventListener('click', () => appendEpisodeBatch(details));
    });
    p.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{activeTab=b.dataset.tab;renderPanel();if(activeTab==='history')scanHistoryPage();}));
    p.querySelectorAll('[data-play]').forEach(b=>b.addEventListener('click',()=>{if(b.disabled)return;const s=db.series.find(x=>x.id===b.dataset.sid),e=s?.episodes.find(x=>x.id===b.dataset.play);if(s&&e)openEpisode(s,e);}));
    p.querySelectorAll('[data-hide-watched]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.hideWatched);if(!s)return;s.hideWatched=!s.hideWatched;saveDB();renderPanel();toast(s.hideWatched?'Watched episodes hidden.':'Watched episodes shown.');}));
    p.querySelectorAll('[data-order]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.order);if(!s)return;s.playbackReverse=!s.playbackReverse;saveDB();renderPanel();toast('Episode order: '+(s.playbackReverse?'chronological':'playlist')+'.');}));
    p.querySelectorAll('[data-continue]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.continue);const plan=s&&resumePlan(s);if(s&&plan?.episode){acknowledgeNewEpisodes(s.id);openEpisode(s,plan.episode);}}));
    p.querySelectorAll('[data-recovery]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.recovery);if(s)showRecoveryChooser(s);}));
    p.querySelectorAll('[data-ack-new]').forEach(b=>b.addEventListener('click',()=>acknowledgeNewEpisodes(b.dataset.ackNew)));
    p.querySelectorAll('[data-open-playlist]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.openPlaylist);if(s?.playlistId)location.href='/playlist?list='+encodeURIComponent(s.playlistId);}));
    p.querySelectorAll('[data-mark]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.mark;markEpisode(id,!isWatched(id));}));
    p.querySelectorAll('[data-through]').forEach(b=>b.addEventListener('click',()=>{const series=db.series.find(item=>item.id===b.dataset.sid);const ep=series?.episodes.find(item=>item.id===b.dataset.through&&item.order===Number(b.dataset.order));if(series&&ep)markThrough(series,ep);}));
    p.querySelectorAll('[data-start-here]').forEach(b=>b.addEventListener('click',()=>{const series=db.series.find(item=>item.id===b.dataset.sid);const ep=series?.episodes.find(item=>item.id===b.dataset.startHere&&item.order===Number(b.dataset.order));if(series&&ep)setSeriesStartHere(series,ep);}));
    p.querySelector('#yst2-undo')?.addEventListener('click',undoLastChange);
    p.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.remove);if(s&&confirm(`Remove “${s.title}” from the library? You can undo for 8 seconds.`)){rememberDatabaseUndo('remove series');db.series=db.series.filter(x=>x.id!==s.id);saveDB();renderPanel();toast('Series removed. Undo is available for 8 seconds.');}}));
    p.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',async()=>{await refreshSeries(b.dataset.sync,false);}));
    p.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>{const s=db.series.find(x=>x.id===b.dataset.edit);if(!s)return;const n=prompt('Series name',s.title);if(n?.trim()){s.title=n.trim();saveDB();renderPanel();}}));
    p.querySelectorAll('[data-history-play]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.historyPlay;const s=db.series.find(x=>x.episodes.some(e=>e.id===id));const e=s?.episodes.find(x=>x.id===id);if(s&&e)openEpisode(s,e);else location.href=urlFor(id);}));
    p.querySelector('#yst2-export')?.addEventListener('click',exportBackup);
    p.querySelector('#yst2-import')?.addEventListener('click',importBackup);
    p.querySelector('#yst2-threshold')?.addEventListener('change',e=>{db.settings.watchedThreshold=Number(e.target.value);saveDB();});
    p.querySelector('#yst2-remaining')?.addEventListener('change',e=>{db.settings.watchedRemainingSeconds=Number(e.target.value);saveDB();});
    p.querySelector('#yst2-autonext')?.addEventListener('change',e=>{db.settings.autoNext=e.target.checked;saveDB();});
    p.querySelector('#yst2-autosync')?.addEventListener('change',e=>{db.settings.autoSyncOnOpen=e.target.checked;saveDB();});
    p.querySelector('#yst2-historyscan')?.addEventListener('change',e=>{db.settings.historyScan=e.target.checked;saveDB();});
    p.querySelector('#yst2-sidebar')?.addEventListener('change',e=>{db.settings.showSidebarButton=e.target.checked;saveDB();addSidebarButton();});
    p.querySelector('#yst2-player-visible')?.addEventListener('change',e=>{db.settings.showPlayerButton=e.target.checked;saveDB();addPlayerButton();});
    p.querySelector('#yst2-record-progress')?.addEventListener('change',e=>{db.settings.recordPlaybackProgress=e.target.checked;saveDB();if(!e.target.checked)activePlaybackSession=null;});
    p.querySelector('#yst2-import-history')?.addEventListener('change',e=>{db.settings.importHistoryProgress=e.target.checked;saveDB();});
    p.querySelector('#yst2-auto-catalog')?.addEventListener('change',e=>{db.settings.catalogAutoRefresh=e.target.checked;saveDB();if(e.target.checked)refreshStaleSeries();});
    p.querySelector('#yst2-clear-progress')?.addEventListener('click',()=>{if(confirm('Clear all playback positions and watched states but keep series catalogs?')){rememberDatabaseUndo('clear playback progress');db.episodes={};saveDB();renderPanel();toast('Playback progress cleared. Undo is available for 8 seconds.');}});
    p.querySelector('#yst2-clear-history')?.addEventListener('click',()=>{if(confirm('Clear local History matches only?')){rememberDatabaseUndo('clear History matches');db.history={};saveDB();renderPanel();toast('History matches cleared. Undo is available for 8 seconds.');}});
    p.querySelector('#yst2-clear')?.addEventListener('click',()=>{if(confirm('Permanently delete all series, episode progress, and History matches?')){rememberDatabaseUndo('delete all tracker data');db=emptyDB();saveDB();renderPanel();toast('Tracker data deleted. Undo is available for 8 seconds.');}});
    p.querySelector('#yst2-recount')?.addEventListener('click',()=>{rememberUndo(Object.keys(db.episodes),'recalculate completion');for(const [id,st] of Object.entries(db.episodes)){setState(id,{watched:shouldAutoComplete(st.position,st.duration,Number(db.settings.watchedThreshold),Number(db.settings.watchedRemainingSeconds ?? AUTO_WATCHED_REMAINING_SECONDS)),completionOverride:'AUTO'},false);}saveDB();renderPanel();toast('Automatic completion recalculated.');});
    p.querySelector('#yst2-markall')?.addEventListener('click',()=>{const s=findSeries(getPlaylistId());if(!s){toast('Open a tracked series playlist first.');return;}const playable=s.episodes.filter(e=>e.available!==false&&!e.unavailable&&/^[A-Za-z0-9_-]{11}$/.test(e.id));if(confirm(`Mark all ${playable.length} playable episodes watched?`)){rememberUndo(playable.map(e=>e.id),'mark all episodes watched');const now=Date.now();for(const e of playable){const old=stateFor(e.id);const already=isWatched(e.id);db.episodes[e.id]={...old,watched:true,completionOverride:'WATCHED',position:old.duration||e.duration||old.position,duration:old.duration||e.duration||0,updatedAt:now,lastWatchedAt:already?old.lastWatchedAt:now};}saveDB();renderPanel();toast('All playable episodes marked watched.');}});
    p.querySelector('#yst2-scanhistory')?.addEventListener('click',scanHistoryPage);
  }
  function validateBackupDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Backup must be a JSON object.');
    const raw = document.data && document.format === 'youtube-series-tracker'
      ? document.data
      : document;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.series)
        || !raw.episodes || typeof raw.episodes !== 'object' || Array.isArray(raw.episodes)) {
      throw new Error('Backup does not contain a series list and progress map.');
    }
    if (raw.series.length > MAX_BACKUP_SERIES) throw new Error('Backup contains too many series.');
    const progressEntries = Object.entries(raw.episodes);
    if (progressEntries.length > MAX_BACKUP_EPISODES) throw new Error('Backup contains too many progress records.');
    const defaults = emptyDB();
    const settings = { ...defaults.settings };
    const supplied = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    if (Number.isFinite(Number(supplied.watchedThreshold)) && Number(supplied.watchedThreshold) >= 0.5 && Number(supplied.watchedThreshold) <= 1) settings.watchedThreshold = Number(supplied.watchedThreshold);
    if (Number.isFinite(Number(supplied.watchedRemainingSeconds)) && Number(supplied.watchedRemainingSeconds) >= 0 && Number(supplied.watchedRemainingSeconds) <= 300) settings.watchedRemainingSeconds = Number(supplied.watchedRemainingSeconds);
    for (const key of Object.keys(defaults.settings)) if (typeof supplied[key] === 'boolean') settings[key] = supplied[key];

    const seenSeries = new Set();
    let episodeCount = 0;
    const series = raw.series.map((row, seriesIndex) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid series record at index ' + seriesIndex + '.');
      const id = String(row.id || '');
      const title = String(row.title || '').trim();
      if (!/^[A-Za-z0-9_-]{2,200}$/.test(id) || seenSeries.has(id) || !title || title.length > 500) {
        throw new Error('Invalid or duplicate series identity.');
      }
      seenSeries.add(id);
      if (!Array.isArray(row.episodes) || row.episodes.length > MAX_BACKUP_EPISODES) throw new Error('Invalid episode catalog size.');
      episodeCount += row.episodes.length;
      if (episodeCount > MAX_BACKUP_EPISODES) throw new Error('Backup contains too many episode entries.');
      const occurrences = new Set();
      const episodes = row.episodes.map((ep,index) => {
        if (!ep || typeof ep !== 'object' || Array.isArray(ep)) throw new Error('Invalid episode record.');
        const videoId = String(ep.id || '');
        const unavailable = Boolean(ep.unavailable || ep.available === false || videoId.startsWith('__yst_unavailable__'));
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) && !(unavailable && /^__yst_unavailable__[A-Za-z0-9_-]{1,180}$/.test(videoId))) {
          throw new Error('Invalid episode ID in series ' + title + '.');
        }
        const order = Number.isInteger(ep.order) && ep.order >= 0 && ep.order <= 1000000 ? ep.order : index;
        const occurrence = videoId + ':' + order;
        if (occurrences.has(occurrence)) throw new Error('Duplicate episode occurrence in series ' + title + '.');
        occurrences.add(occurrence);
        const duration = Number(ep.duration) || 0;
        if (!Number.isFinite(duration) || duration < 0 || duration > 604800) throw new Error('Invalid episode duration.');
        const thumb = String(ep.thumb || '');
        return {
          id: videoId,
          title: String(ep.title || '').slice(0,500),
          duration,
          thumb: thumb.startsWith('https://') ? thumb.slice(0,2048) : '',
          url: unavailable ? '' : 'https://www.youtube.com/watch?v=' + videoId,
          order,
          available: !unavailable,
          unavailable,
          videoInfo: String(ep.videoInfo || '').slice(0,240),
          manuallyAdded: Boolean(ep.manuallyAdded)
        };
      });
      const cursorVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(row.cursorVideoId || '')) ? row.cursorVideoId : '';
      const startHereVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(row.startHereVideoId || '')) ? row.startHereVideoId : '';
      const newEpisodeIds = Array.isArray(row.newEpisodeIds) ? [...new Set(row.newEpisodeIds.filter(value => /^[A-Za-z0-9_-]{11}$/.test(value)))].slice(0,10000) : [];
      return {
        id,
        playlistId: row.playlistId ? String(row.playlistId).slice(0,200) : null,
        manual: Boolean(row.manual || !row.playlistId),
        title,
        episodes,
        addedAt: Math.max(0,Number(row.addedAt)||Date.now()),
        updatedAt: Math.max(0,Number(row.updatedAt)||Date.now()),
        lastSyncedAt: Math.max(0,Number(row.lastSyncedAt)||0),
        playbackReverse: Boolean(row.playbackReverse),
        hideWatched: Boolean(row.hideWatched),
        cursorVideoId,
        cursorOrder: Number.isInteger(row.cursorOrder) ? row.cursorOrder : -1,
        cursorUpdatedAt: Math.max(0,Number(row.cursorUpdatedAt)||0),
        catalogRevision: Number.isInteger(row.catalogRevision) ? Math.max(0,row.catalogRevision) : (episodes.length ? 1 : 0),
        cursorRevision: Number.isInteger(row.cursorRevision) ? Math.max(0,row.cursorRevision) : 0,
        newEpisodeIds,
        startHereVideoId,
        startHereOrder: Number.isInteger(row.startHereOrder) ? row.startHereOrder : -1,
        lastRefreshAttemptAt: Math.max(0,Number(row.lastRefreshAttemptAt)||0),
        refreshRetryAt: Math.max(0,Number(row.refreshRetryAt)||0),
        refreshError: String(row.refreshError||'').slice(0,240),
        recoveryRequired: Boolean(row.recoveryRequired),
        recoveryVideoId: /^[A-Za-z0-9_-]{11}$/.test(String(row.recoveryVideoId||'')) ? row.recoveryVideoId : ''
      };
    });

    const episodes = {};
    for (const [id,state] of progressEntries) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !state || typeof state !== 'object' || Array.isArray(state)) continue;
      const duration = Number(state.duration) || 0;
      const position = Number(state.position) || 0;
      if (!Number.isFinite(duration) || !Number.isFinite(position) || duration < 0 || duration > 604800 || position < 0 || position > 604800) continue;
      const completionOverride = ['AUTO','WATCHED','UNWATCHED'].includes(state.completionOverride) ? state.completionOverride : 'AUTO';
      episodes[id] = {
        watched: Boolean(state.watched),
        completionOverride,
        position: Math.min(position,duration || position),
        duration,
        title: String(state.title||'').slice(0,500),
        updatedAt: Math.max(0,Number(state.updatedAt)||0),
        lastWatchedAt: Math.max(0,Number(state.lastWatchedAt)||0)
      };
    }
    const history = {};
    if (raw.history && typeof raw.history === 'object' && !Array.isArray(raw.history)) {
      for (const [id,item] of Object.entries(raw.history).slice(0,MAX_BACKUP_EPISODES)) {
        if (/^[A-Za-z0-9_-]{11}$/.test(id) && item && typeof item === 'object' && !Array.isArray(item)) {
          history[id] = {
            title: String(item.title||'').slice(0,500),
            lastSeen: Math.max(0,Number(item.lastSeen)||0),
            percent: Number.isFinite(Number(item.percent)) ? Math.max(0,Math.min(100,Number(item.percent))) : null
          };
        }
      }
    }
    return { ...defaults, version: VERSION, settings, series, episodes, history, lastSync: Math.max(0,Number(raw.lastSync)||0) };
  }
  function exportBackup() {
    const document = { format: 'youtube-series-tracker', formatVersion: 1, exportedAt: new Date().toISOString(), data: db };
    const blob = new Blob([JSON.stringify(document,null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='youtube-series-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
  }
  function importBackup() {
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.onchange=async()=>{
      try {
        if (!input.files || !input.files[0]) return;
        if (input.files[0].size > MAX_BACKUP_CHARS) throw new Error('Backup exceeds the 8 MB size limit.');
        const parsed = JSON.parse(await input.files[0].text());
        const restored = validateBackupDocument(parsed);
        const existingIds = new Set(db.series.map(series => series.id));
        const overlap = restored.series.filter(series => existingIds.has(series.id)).length;
        const episodeCount = restored.series.reduce((count,series) => count + series.episodes.length,0);
        const progressCount = Object.keys(restored.episodes).length;
        const preview = 'Backup preview\n'
          + restored.series.length + ' series\n'
          + episodeCount + ' episode entries\n'
          + progressCount + ' progress records\n'
          + overlap + ' series will replace existing entries.\n\n'
          + 'Restore this backup? Current data will be replaced.';
        if (!confirm(preview)) return;
        rememberDatabaseUndo('restore backup');
        db = restored;
        saveDB();
        renderPanel();
        toast('Backup restored and validated. Undo is available for 8 seconds.');
      } catch(error) {
        console.warn('[YouTube Series] Backup import rejected:', error?.message || error);
        toast('Could not import backup: ' + (error?.message || 'invalid file'));
      }
    };
    input.click();
  }
  function historyProgressPercent(node) {
    if (!node) return null;
    const selectors = [
      'ytd-thumbnail-overlay-resume-playback-renderer #progress',
      'ytd-thumbnail-overlay-resume-playback-renderer [style*="width"]',
      '[aria-label*="watched"] [style*="width"]',
      'yt-progress-bar[aria-valuenow]',
      '[role="progressbar"][aria-valuenow]'
    ];
    for (const selector of selectors) {
      const bar = node.querySelector(selector);
      if (!bar) continue;
      const aria = Number(bar.getAttribute('aria-valuenow'));
      if (Number.isFinite(aria) && aria >= 0 && aria <= 100) return aria;
      const width = /([0-9]+(?:\.[0-9]+)?)%/.exec(bar.getAttribute('style') || '');
      if (width) return Math.max(0,Math.min(100,Number(width[1])));
    }
    return null;
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
        const percent = historyProgressPercent(node);
        const previous = db.history[id] || {};
        db.history[id] = {
          title,
          lastSeen: Date.now(),
          percent,
          signature: String(percent ?? '') + ':' + String(text(node.querySelector('#video-title')) || title)
        };
        count++;
        if (db.settings.importHistoryProgress && percent !== null && shouldAutoCompletePercentage(percent, stateFor(id).duration || db.series.flatMap(series=>series.episodes).find(ep=>ep.id===id)?.duration || 0)) {
          const state = stateFor(id);
          if (state.completionOverride !== 'UNWATCHED' && state.completionOverride !== 'WATCHED') {
            setState(id,{watched:true,completionOverride:'AUTO'},false);
          }
        }
      }catch(_){}
    }
    saveDB();renderPanel();toast(`History scan found ${count} tracked episode(s). Scroll down to load more history, then scan again.`);
  }
  function addSidebarButton() {
    let button = document.getElementById(BTN);
    if (db.settings.showSidebarButton === false) {
      button?.remove();
      document.getElementById('yst2-sidebar-wrap')?.remove();
      return;
    }
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
  function addPlaylistFollowButton() {
    const listId=getPlaylistId();
    const onPlaylist=location.pathname==='/playlist'||location.pathname.startsWith('/playlist');
    const host=document.querySelector('ytd-playlist-header-renderer #top-level-buttons-computed')
      || document.querySelector('ytd-playlist-header-renderer #actions')
      || document.querySelector('ytd-playlist-header-renderer #primary');
    const existing=document.getElementById(PLAYLIST_BTN);
    if(!onPlaylist||!isSuggestiblePlaylistId(listId)||!host){existing?.remove();return;}
    const followed=findSeries(listId);
    if(existing&&existing.parentElement===host){
      existing.textContent=followed?'View series':'Follow series';
      existing.dataset.playlist=listId;
      return;
    }
    existing?.remove();
    const button=document.createElement('button');
    button.type='button';button.id=PLAYLIST_BTN;
    button.className='yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono';
    button.textContent=followed?'View series':'Follow series';
    button.title='Open or follow this playlist as a series';
    button.dataset.playlist=listId;
    button.addEventListener('click',async()=>{
      const id=button.dataset.playlist;
      const saved=findSeries(id);
      if(saved){showSeriesInLibrary(saved);return;}
      if(getPlaylistId()!==id){toast('Playlist changed. Refresh the page and try again.');return;}
      await syncCurrentPlaylist();
      const newlySaved=findSeries(id);
      if(newlySaved)showSeriesInLibrary(newlySaved);
    });
    host.appendChild(button);
  }

  function addPlayerButton() {
    const player = document.querySelector('#movie_player');
    if (!player) return;
    const host = player.querySelector('.ytp-chrome-top-buttons')
      || player.querySelector('.ytp-right-controls');
    if (!host) return;
    if (db.settings.showPlayerButton === false) {
      document.getElementById(PLAYER_BTN)?.remove();
      document.getElementById(PLAYER_PREV_BTN)?.remove();
      document.getElementById(PLAYER_NEXT_BTN)?.remove();
      return;
    }
    const addNav=(id,label,glyph,direction)=>{
      let nav=document.getElementById(id);
      if(nav&&nav.parentElement===host)return;
      nav?.remove();
      nav=document.createElement('button');nav.type='button';nav.id=id;nav.className='ytp-button';
      nav.title=label;nav.setAttribute('aria-label',label);nav.textContent=glyph;
      nav.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();navigateSeries(direction);});
      host.appendChild(nav);
    };
    addNav(PLAYER_PREV_BTN,'Previous series episode','‹',-1);
    addNav(PLAYER_NEXT_BTN,'Next series episode','›',1);
    let button = document.getElementById(PLAYER_BTN);
    if (button && button.parentElement === host) return;
    if (button) button.remove();

    button = document.createElement('button');
    button.type = 'button';
    button.id = PLAYER_BTN;
    button.className = 'ytp-button yst2-player-button';
    button.title = 'Follow or open this YouTube series';
    button.setAttribute('aria-label', 'Follow or open this YouTube series');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 3.5A2.5 2.5 0 0 1 6.5 1h11A2.5 2.5 0 0 1 20 3.5v17a.5.5 0 0 1-.8.4L12 15.5l-7.2 5.4a.5.5 0 0 1-.8-.4v-17ZM7 5v2h10V5H7Zm0 4v2h7V9H7Z"/></svg>';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openFromPlayer();
    });
    host.appendChild(button);
  }

  function showSeriesInLibrary(series) {
    if (!series) return;
    activeTab = 'library';
    librarySearch = '';
    openPanel();
    setTimeout(() => {
      const panel = document.getElementById(PANEL);
      const card = panel && [...panel.querySelectorAll('[data-series-card]')].find(node => node.dataset.seriesCard === series.id);
      if (!card) return;
      card.classList.add('yst2-series-highlight');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => card.classList.remove('yst2-series-highlight'), 2200);
    }, 120);
  }

  function seriesMatchesVideo(videoId) {
    return db.series.filter(series => series.episodes.some(episode =>
      episode.id === videoId && episode.available !== false && !episode.unavailable));
  }

  function recordCurrentProgressInSeries(series, videoId) {
    const requestedOrder = series && series.playlistId && getPlaylistId() === series.playlistId
      ? currentPlaylistIndex() : -1;
    const episode = episodeOccurrence(series, videoId, requestedOrder);
    if (!episode) return;
    const video = document.querySelector('video');
    const old = stateFor(videoId);
    const duration = Number.isFinite(video && video.duration) && video.duration > 0 ? video.duration : episode.duration || old.duration || 0;
    const position = Number.isFinite(video && video.currentTime) && video.currentTime > 0 ? video.currentTime : old.position || 0;
    const threshold = Number(db.settings.watchedThreshold);
    const watched = old.completionOverride === 'WATCHED' || (old.completionOverride !== 'UNWATCHED' && (old.watched || shouldAutoComplete(position,duration,threshold,Number(db.settings.watchedRemainingSeconds ?? AUTO_WATCHED_REMAINING_SECONDS),Boolean(video && video.ended))));
    if (db.settings.recordPlaybackProgress !== false) {
      setState(videoId, {
        title: episode.title || old.title,
        position: watched ? (duration || position) : position,
        duration: duration || old.duration,
        watched
      }, false);
      db.history[videoId] = { title: episode.title || old.title, lastSeen: Date.now() };
    }
    series.cursorVideoId = videoId;
    series.cursorOrder = episode.order;
    series.cursorUpdatedAt = Date.now();
    series.cursorRevision = Number(series.catalogRevision) || 0;
  }
  function showFollowSetupDialog(candidate, videoId) {
    if (!candidate || getVideoId() !== videoId) return;
    const panel = document.getElementById(PANEL);
    if (!panel) return;
    panel.querySelector('#yst2-follow-setup')?.remove();
    const catalog = [...candidate.items].sort((a,b)=>(a.order??0)-(b.order??0));
    const reverseDefault = typeof candidate.reverse === 'boolean' ? candidate.reverse : inferReverseOrder(catalog);
    const requestedOrder = candidate.id === getPlaylistId() ? currentPlaylistIndex() : -1;
    const index = catalog.findIndex(ep => ep.id === videoId && ep.available !== false && !ep.unavailable && (requestedOrder < 0 || ep.order === requestedOrder));
    if (index < 0) { toast('The selected playlist does not contain the current video.'); return; }
    const previousCount = reverseDefault ? catalog.length - index - 1 : index;
    const video = document.querySelector('video');
    const position = Number.isFinite(video?.currentTime) ? Math.max(0,video.currentTime) : 0;
    const modal = document.createElement('div');
    modal.id = 'yst2-follow-setup';
    modal.className = 'yst2-modal-backdrop';
    modal.innerHTML = '<section class="yst2-modal" role="dialog" aria-modal="true" aria-labelledby="yst2-follow-setup-title">'
      + '<header class="yst2-modal-head"><div><h3 id="yst2-follow-setup-title">Follow this series</h3><p class="yst2-muted">' + esc(candidate.title || 'YouTube playlist') + '</p></div><button class="yst2-icon" data-close aria-label="Close">×</button></header>'
      + '<label class="yst2-dialog-label" for="yst2-follow-order">Episode playback order</label>'
      + '<select id="yst2-follow-order" class="yst2-dialog-select"><option value="playlist"' + (!reverseDefault?' selected':'') + '>YouTube playlist order</option><option value="reverse"' + (reverseDefault?' selected':'') + '>Reverse playlist order</option></select>'
      + '<div class="yst2-current-video"><img src="' + esc(candidate.thumb || 'https://i.ytimg.com/vi/'+videoId+'/hqdefault.jpg') + '" alt=""><div><strong>' + esc(currentVideoDetails(videoId).title || videoTitle()) + '</strong><span>' + (position > 1 ? 'Resume from ' + fmt(position) : 'Current episode') + '</span></div></div>'
      + '<label class="yst2-setting"><input id="yst2-follow-watch-previous" type="checkbox" ' + (previousCount>0?'':'disabled') + '> Mark the ' + previousCount + ' earlier episode(s) as watched</label>'
      + '<p class="yst2-muted">The current episode position is saved locally. YouTube History is not changed.</p>'
      + '<button type="button" id="yst2-follow-save" class="yst2-mainbtn">Follow series</button><button type="button" class="yst2-subbtn" data-close>Cancel</button></section>';
    panel.appendChild(modal);
    modal.querySelector('#yst2-follow-order')?.addEventListener('change',event=>{
      const reverse=event.target.value==='reverse';
      const count=reverse?catalog.length-index-1:index;
      const checkbox=modal.querySelector('#yst2-follow-watch-previous');
      checkbox.disabled=count<=0;
      if(count<=0)checkbox.checked=false;
      checkbox.parentElement.lastChild.textContent=' Mark the '+count+' earlier episode(s) as watched';
    });
    modal.querySelector('#yst2-follow-save')?.addEventListener('click',()=>{
      if(getVideoId()!==videoId){modal.remove();toast('The active video changed. Tap Follow again.');return;}
      const reverse=modal.querySelector('#yst2-follow-order')?.value==='reverse';
      const watchPrevious=Boolean(modal.querySelector('#yst2-follow-watch-previous')?.checked);
      modal.remove();
      finishAutoFollow(candidate,videoId,{reverse,watchPrevious});
    });
    modal.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>modal.remove()));
    modal.addEventListener('click',event=>{if(event.target===modal)modal.remove();});
    modal.addEventListener('keydown',event=>{if(event.key==='Escape')modal.remove();});
  }

  function finishAutoFollow(candidate, videoId, options = {}) {
    const series = mergeSeries(candidate.id, candidate.title || seriesSearchTitle(currentVideoDetails(videoId).title) || candidate.id, candidate.items);
    const reverse = typeof options.reverse === 'boolean'
      ? options.reverse
      : (typeof candidate.reverse === 'boolean' ? candidate.reverse : inferReverseOrder(candidate.items));
    series.playbackReverse = reverse;
    const ordered = [...series.episodes].sort((a,b)=>(a.order??0)-(b.order??0));
    if (reverse) ordered.reverse();
    const requestedOrder = candidate.id===getPlaylistId()?currentPlaylistIndex():-1;
    const startIndex = ordered.findIndex(ep=>ep.id===videoId&&ep.available!==false&&!ep.unavailable&&(requestedOrder<0||ep.order===requestedOrder));
    if (options.watchPrevious && startIndex>0) {
      const preceding=ordered.slice(0,startIndex).filter(ep=>ep.available!==false&&!ep.unavailable&&/^[A-Za-z0-9_-]{11}$/.test(ep.id));
      rememberUndo(preceding.map(ep=>ep.id),'follow series and mark previous episodes watched');
      const now=Date.now();
      for(const ep of preceding){
        const old=stateFor(ep.id),already=isWatched(ep.id);
        db.episodes[ep.id]={...old,watched:true,completionOverride:'WATCHED',
          position:old.duration||ep.duration||old.position,duration:old.duration||ep.duration||0,
          updatedAt:now,lastWatchedAt:already?old.lastWatchedAt:now};
      }
    }
    recordCurrentProgressInSeries(series, videoId);
    saveDB();
    showSeriesInLibrary(series);
    toast('Followed "' + series.title + '" · ' + series.episodes.length + ' episodes added.');
    return series;
  }

  function showPlaylistCandidateDialog(videoId, candidates) {
    activeTab = 'library';
    librarySearch = '';
    openPanel();
    const panel = document.getElementById(PANEL);
    if (!panel) return;
    panel.querySelector('#yst2-auto-follow-chooser')?.remove();
    const modal = document.createElement('div');
    modal.id = 'yst2-auto-follow-chooser';
    modal.className = 'yst2-modal-backdrop';
    modal.innerHTML = '<section class="yst2-modal" role="dialog" aria-modal="true" aria-labelledby="yst2-auto-follow-title">'
      + '<header class="yst2-modal-head"><div><h3 id="yst2-auto-follow-title">Choose the series playlist</h3>'
      + '<p class="yst2-muted">These playlists were checked to ensure they contain the current video.</p></div>'
      + '<button type="button" id="yst2-auto-follow-close" class="yst2-icon" aria-label="Close">×</button></header>'
      + '<div class="yst2-candidate-list">' + candidates.map((candidate,index) =>
        '<button type="button" class="yst2-candidate" data-follow-candidate="' + index + '">'
          + (candidate.thumb ? '<img loading="lazy" alt="" src="' + esc(candidate.thumb) + '">' : '<span class="yst2-candidate-play">▶</span>')
          + '<span class="yst2-candidate-copy"><strong>' + esc(candidate.title) + '</strong><small>'
          + esc(candidate.owner || 'YouTube playlist') + ' · ' + candidate.items.length + ' episodes</small></span><span class="yst2-candidate-arrow">›</span></button>'
      ).join('') + '</div>'
      + '<button type="button" id="yst2-auto-follow-manual" class="yst2-subbtn">Add only this video manually</button>'
      + '<button type="button" id="yst2-auto-follow-cancel" class="yst2-subbtn yst2-dialog-cancel">Cancel</button>'
      + '</section>';
    panel.appendChild(modal);
    modal.querySelectorAll('[data-follow-candidate]').forEach(button => {
      button.addEventListener('click', () => {
        const candidate = candidates[Number(button.dataset.followCandidate)];
        if (candidate && getVideoId() === videoId) showFollowSetupDialog(candidate, videoId);
        modal.remove();
      });
    });
    const close = () => modal.remove();
    modal.querySelector('#yst2-auto-follow-close')?.addEventListener('click', close);
    modal.querySelector('#yst2-auto-follow-cancel')?.addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    modal.querySelector('#yst2-auto-follow-manual')?.addEventListener('click', () => {
      modal.remove();
      showAddVideoDialog();
    });
  }

  function showKnownSeriesChooser(videoId, seriesList) {
    const candidates = seriesList.map(series => ({
      id: series.id,
      title: series.title,
      owner: 'Already in your library',
      thumb: series.episodes.find(item => item.available !== false && !item.unavailable)?.thumb || '',
      items: series.episodes,
      knownSeries: series
    }));
    activeTab = 'library';
    librarySearch = '';
    openPanel();
    const panel = document.getElementById(PANEL);
    if (!panel) return;
    panel.querySelector('#yst2-auto-follow-chooser')?.remove();
    const modal = document.createElement('div');
    modal.id = 'yst2-auto-follow-chooser';
    modal.className = 'yst2-modal-backdrop';
    modal.innerHTML = '<section class="yst2-modal" role="dialog" aria-modal="true" aria-labelledby="yst2-auto-follow-title">'
      + '<header class="yst2-modal-head"><div><h3 id="yst2-auto-follow-title">Choose a saved series</h3><p class="yst2-muted">This video appears in more than one saved series.</p></div>'
      + '<button type="button" id="yst2-auto-follow-close" class="yst2-icon" aria-label="Close">×</button></header>'
      + '<div class="yst2-candidate-list">' + candidates.map((candidate,index) =>
        '<button type="button" class="yst2-candidate" data-follow-candidate="' + index + '">'
          + (candidate.thumb ? '<img loading="lazy" alt="" src="' + esc(candidate.thumb) + '">' : '<span class="yst2-candidate-play">▶</span>')
          + '<span class="yst2-candidate-copy"><strong>' + esc(candidate.title) + '</strong><small>Saved series · ' + candidate.items.length + ' episodes</small></span><span class="yst2-candidate-arrow">›</span></button>'
      ).join('') + '</div><button type="button" id="yst2-auto-follow-cancel" class="yst2-subbtn">Cancel</button></section>';
    panel.appendChild(modal);
    modal.querySelectorAll('[data-follow-candidate]').forEach(button => button.addEventListener('click', () => {
      const series = candidates[Number(button.dataset.followCandidate)]?.knownSeries;
      modal.remove();
      if (series && getVideoId() === videoId) showSeriesInLibrary(series);
    }));
    modal.querySelector('#yst2-auto-follow-close')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#yst2-auto-follow-cancel')?.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') modal.remove(); });
  }

  async function followSeriesFromPlayer() {
    if (playerActionBusy) return;
    const videoId = getVideoId();
    const rawList = getPlaylistId();
    const listId = isSuggestiblePlaylistId(rawList) ? rawList : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      if (listId) {
        activeTab = 'library';
        openPanel();
        await syncCurrentPlaylist();
      } else {
        activeTab = 'library';
        openPanel();
        toast('Open a YouTube video or playlist first.');
      }
      return;
    }
    const playerId = document.getElementById('movie_player')?.getVideoData?.().video_id
      || window.ytInitialPlayerResponse?.videoDetails?.videoId || '';
    if (playerId && playerId !== videoId) {
      toast('YouTube is switching videos. Tap Series again when playback settles.');
      return;
    }
    if (listId) {
      const already = findSeries(listId);
      if (already && already.episodes.some(episode => episode.id === videoId && episode.available !== false && !episode.unavailable)) {
        showSeriesInLibrary(already);
        toast('Already following "' + already.title + '".');
        return;
      }
    } else {
      const saved = seriesMatchesVideo(videoId);
      if (saved.length === 1) {
        showSeriesInLibrary(saved[0]);
        toast('Opened "' + saved[0].title + '".');
        return;
      }
      if (saved.length > 1) {
        showKnownSeriesChooser(videoId, saved);
        return;
      }
    }
    playerActionBusy = true;
    const capturedVideo = videoId;
    toast('Finding this series and loading its episodes…');
    try {
      if (listId) {
        try {
          const catalog = await fetchFullPlaylist(listId);
          if (getVideoId() === capturedVideo && catalog.items.some(item => item.id === capturedVideo && item.available !== false && !item.unavailable)) {
            showFollowSetupDialog({
              id: listId,
              title: catalog.title || playlistTitleFromDOM() || seriesSearchTitle(currentVideoDetails(capturedVideo).title) || currentVideoDetails(capturedVideo).title || listId,
              items: catalog.items,
              reverse: inferReverseOrder(catalog.items),
              score: 2000
            }, capturedVideo);
            return;
          }
        } catch (error) {
          console.debug('[YouTube Series] direct playlist follow failed:', error && error.message || error);
        }
      }
      const matches = await discoverPlaylistsForVideo(capturedVideo);
      if (getVideoId() !== capturedVideo) return;
      if (matches.length === 1) {
        showFollowSetupDialog(matches[0], capturedVideo);
      } else if (matches.length > 1) {
        const first = matches[0], second = matches[1];
        if (first.score >= 100 && first.score - second.score >= 50) showFollowSetupDialog(first, capturedVideo);
        else showPlaylistCandidateDialog(capturedVideo, matches);
      } else {
        activeTab = 'library';
        librarySearch = '';
        openPanel();
        toast('No matching playlist was found. Add this video manually or paste a playlist link.');
        showAddVideoDialog();
      }
    } catch (error) {
      console.warn('[YouTube Series] smart follow failed', error);
      if (getVideoId() === capturedVideo) {
        activeTab = 'library';
        librarySearch = '';
        openPanel();
        toast(error && error.message || 'Could not discover the complete series.');
        showAddVideoDialog();
      }
    } finally {
      playerActionBusy = false;
    }
  }

  function openFromPlayer() {
    followSeriesFromPlayer();
  }
  function ensureUI() {
    addStyles();
    if(!document.getElementById(PANEL)){const p=document.createElement('aside');p.id=PANEL;document.body.appendChild(p);}
    addSidebarButton();
    addPlayerButton();
    addPlaylistFollowButton();
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
      .yst2-mark{background:none;border:0;color:#aaa;font-size:19px;min-width:28px}.yst2-mark.checked{color:#62d5a0}.yst2-through,.yst2-start-here{border:0;background:transparent;color:#aab0bf;padding:5px 7px;cursor:pointer}.yst2-through:hover,.yst2-start-here:hover{color:#ff8da3}.yst2-through:focus-visible,.yst2-start-here:focus-visible{outline:2px solid #ff6682;outline-offset:2px}.yst2-ep.is-watched .yst2-epname{color:#b5b5bc}
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
      #${PLAYLIST_BTN}{margin:8px!important;border-radius:9px!important;padding:0 13px!important;min-height:36px!important;font-size:12px!important}#${PLAYER_PREV_BTN},#${PLAYER_NEXT_BTN}{display:inline-flex!important;align-items:center;justify-content:center;width:30px;height:40px;border:0;background:transparent;color:#f2f2f2;cursor:pointer;font-size:21px;vertical-align:top}#${PLAYER_PREV_BTN}:hover,#${PLAYER_NEXT_BTN}:hover{opacity:.72}#${PLAYER_BTN}{display:inline-flex!important;align-items:center;justify-content:center;width:48px;height:48px;padding:0;margin:0;border:0;background:transparent;color:#f1f1f1;cursor:pointer;flex:0 0 48px;vertical-align:top}
      #${PLAYER_BTN} svg{display:block;width:24px;height:24px;fill:currentColor}
      #${PLAYER_BTN}:hover{opacity:.82}
      #${PLAYER_BTN}:focus-visible{outline:2px solid #fff;outline-offset:-4px;border-radius:8px}
      #yst2-toast{position:fixed;z-index:1000001;left:50%;bottom:26px;transform:translate(-50%,15px);opacity:0;pointer-events:none;background:#292a31;color:white;padding:12px 16px;border-radius:10px;box-shadow:0 5px 25px #0008;transition:.2s;font:13px Roboto,Arial,sans-serif;max-width:90vw}
      #yst2-toast.show{opacity:1;transform:translate(-50%,0)}@media(max-width:600px){#${PANEL}{top:6px;right:6px;bottom:6px;width:calc(100vw - 12px)}.yst2-thumb{width:72px}}
      /* Series Tracker UI refresh */
      #${PANEL}{width:min(510px,calc(100vw - 24px));background:linear-gradient(160deg,#17191f 0%,#101116 56%);border-color:#353945;box-shadow:0 24px 90px #000b;font-size:13px;color:#f3f4f8}
      .yst2-top{padding:18px 18px 15px;border-bottom:1px solid #2a2d35;background:#15161c}
      .yst2-brand-row{display:flex;align-items:center;gap:11px;min-width:0}.yst2-brand-mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(145deg,#ff254b,#d90032);display:grid;place-items:center;box-shadow:0 5px 18px #ff174426;flex:none}
      .yst2-brand-mark svg{width:19px;height:19px;fill:#fff}.yst2-logo{font-size:18px;line-height:1.2;font-weight:800;letter-spacing:-.45px}.yst2-tagline{margin-top:4px;color:#9094a2;font-size:11px;letter-spacing:.1px}
      .yst2-close{width:34px;height:34px;border:1px solid #343742;padding:0;border-radius:11px;font-size:21px;color:#b4b8c3;background:#20222a;line-height:1}
      .yst2-dashboard{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:13px 16px 10px;background:#15161c}
      .yst2-metric{display:flex;flex-direction:column;gap:5px;border:1px solid #2a2d36;background:#1b1d25;border-radius:12px;padding:10px 12px;min-width:0}
      .yst2-metric>span{font-size:10px;text-transform:uppercase;letter-spacing:.9px;color:#969baa;font-weight:700}.yst2-metric>strong{font-size:23px;line-height:1.15;font-weight:800;letter-spacing:-.7px;color:#f5f6f9}.yst2-metric strong small{font-size:13px;color:#aeb2be;margin-left:1px}
      .yst2-overall-progress{grid-column:1/-1;border:1px solid #2a2d36;background:#1b1d25;border-radius:12px;padding:10px 12px}
      .yst2-overall-label{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#b0b4c0}.yst2-overall-label span:last-child{font-variant-numeric:tabular-nums}
      .yst2-bar{height:5px;background:#323540;margin:9px 0 2px}.yst2-bar i{background:linear-gradient(90deg,#ff3158,#ff6377);transition:width .22s ease}.yst2-bar.big{height:5px}
      .yst2-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px 13px;background:#15161c}
      .yst2-primary-actions,.yst2-data-actions{display:flex;align-items:center;gap:7px;min-width:0}.yst2-mainbtn,.yst2-subbtn,.yst2-icon{border-radius:10px;transition:background .15s ease,border-color .15s ease,transform .15s ease}
      .yst2-mainbtn{background:linear-gradient(135deg,#ff3158,#ec1740);box-shadow:0 4px 14px #ff174420;color:#fff;padding:10px 13px;font-weight:750}.yst2-mainbtn:hover{background:linear-gradient(135deg,#ff4c6d,#ff1744);transform:translateY(-1px)}
      .yst2-subbtn{border:1px solid #363945;background:#22242d;color:#e3e5ed;padding:9px 12px}.yst2-subbtn:hover,.yst2-icon:hover{background:#2b2e39;border-color:#4b5060}
      .yst2-data-actions .yst2-icon{width:35px;height:35px;border:1px solid #353843;padding:0;font-size:17px;color:#c9cbd5}
      .yst2-tabs{gap:4px;padding:0 16px 11px;border-bottom:1px solid #2a2d35;background:#15161c}
      .yst2-tabs button{display:flex;align-items:center;justify-content:center;gap:7px;flex:1;min-width:0;border:1px solid transparent;border-radius:10px;padding:9px 8px;background:transparent;color:#9499a8;font-size:11px;font-weight:650;white-space:nowrap}
      .yst2-tabs button:hover{color:#e8eaf0;background:#1d1f27}.yst2-tabs button.active{background:#29212a;border-color:#55303b;color:#fff}
      .yst2-tab-count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:6px;background:#30323c;color:#bfc3d0;font-size:10px;font-variant-numeric:tabular-nums}
      .yst2-tabs button.active .yst2-tab-count{background:#64293b;color:#ffdce3}
      .yst2-searchwrap{display:flex;align-items:center;gap:9px;margin:13px 16px 2px;padding:0 11px;height:39px;border:1px solid #30333d;border-radius:11px;background:#191b22;color:#8f94a3}
      .yst2-searchwrap:focus-within{border-color:#aa435b;box-shadow:0 0 0 3px #ff315815}
      .yst2-searchwrap svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;flex:none}
      .yst2-searchwrap input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:#f5f6f8;font:12px Roboto,Arial,sans-serif}
      .yst2-searchwrap input::placeholder{color:#737988}.yst2-searchwrap kbd{border:1px solid #383b46;border-radius:5px;padding:1px 5px;font:10px Roboto,Arial,sans-serif;color:#7e8493}
      .yst2-search-empty{margin:12px 16px 0;padding:11px;border:1px dashed #3b3e49;border-radius:10px;text-align:center;color:#aeb2bf;font-size:11px}.yst2-search-empty[hidden]{display:none}
      .yst2-content{padding:13px 16px 18px;scrollbar-width:thin;scrollbar-color:#414450 transparent}.yst2-series{background:linear-gradient(145deg,#1b1d25,#171920);border:1px solid #30333e;border-radius:15px;padding:13px;margin-bottom:11px;box-shadow:0 4px 13px #00000012}
      .yst2-series-overview{display:flex;align-items:flex-start;gap:12px}.yst2-series-art{position:relative;width:108px;min-width:108px;aspect-ratio:16/11;display:grid;place-items:center;overflow:hidden;border-radius:10px;border:1px solid #393c47;background:linear-gradient(145deg,#292c36,#1b1d25)}
      .yst2-series-art img{width:100%;height:100%;position:absolute;inset:0;object-fit:cover}.yst2-series-art:after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(transparent,#090a0dcc);pointer-events:none}
      .yst2-series-art>span{position:absolute;bottom:6px;left:7px;z-index:1;padding:3px 6px;border-radius:5px;background:#0d0e12d9;color:#fff;font-size:9px;font-weight:700}
      .yst2-series-art-placeholder{font-size:24px;color:#ff536f}.yst2-series-info{flex:1;min-width:0}
      .yst2-serieshead{gap:4px;margin-bottom:7px}.yst2-seriestitle{font-size:14px;line-height:1.35;font-weight:750;letter-spacing:-.15px}
      .yst2-new-count{border:1px solid #754052;border-radius:7px;background:#3a202c;color:#ffb2c1;padding:4px 6px;font-size:9px;font-weight:700;white-space:nowrap}.yst2-serieshead .yst2-icon{width:27px;height:27px;flex:none;padding:0;border:1px solid #353843;color:#b5bac8;font-size:15px;line-height:1}
      .yst2-serieshead .yst2-icon.danger{color:#f18b9e}.yst2-muted{color:#999eac;font-size:10px;line-height:1.5}.yst2-dot{padding:0 3px;color:#666b79}
      .yst2-series-footline{display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:10px;color:#8e94a3}.yst2-progress-label{color:#ffc0cb;font-weight:700}
      .yst2-continue{display:flex;align-items:center;gap:10px;margin-top:10px;padding:9px 10px;border:1px solid #4c2936;background:#2b1b26;color:#fff;border-radius:10px;text-align:left;white-space:normal;overflow:visible;text-overflow:clip}
      .yst2-continue:hover{border-color:#8f3b53;background:#35202c}.yst2-continue-icon{display:grid;place-items:center;width:29px;height:29px;flex:none;border-radius:9px;background:#8c263f;color:#fff;font-size:11px}
      .yst2-continue-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.yst2-continue-copy strong{font-size:11px;font-weight:750}.yst2-continue-copy small{font-size:10px;font-weight:400;color:#e5a6b5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .yst2-continue-arrow{color:#e89bad;font-size:15px}.yst2-done{padding:9px 0 0;color:#78d9ac;font-size:11px}
      .yst2-details{margin-top:11px;border-top:1px solid #2c2f38;padding-top:7px}.yst2-details summary{display:flex;align-items:center;gap:7px;list-style:none;padding:5px 1px;color:#d2d5df;font-size:11px;font-weight:700}.yst2-details summary::-webkit-details-marker{display:none}
      .yst2-summary-count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:6px;background:#292c36;color:#aeb4c3;font-size:9px}.yst2-summary-spacer{flex:1}.yst2-summary-hint{font-size:9px;font-weight:500;color:#838998}.yst2-chevron{font-size:16px;color:#838998;transition:transform .15s ease}.yst2-details[open] .yst2-chevron{transform:rotate(180deg)}
      .yst2-ep{gap:9px;border-bottom-color:#2a2d36;padding:10px 0}.yst2-thumb{width:82px;border:1px solid #343743;border-radius:8px}.yst2-epname{font-size:11px;line-height:1.45;color:#f0f1f5;max-height:3em}.yst2-epname:hover{color:#ffb6c4}.yst2-epbody .yst2-bar{height:3px;margin-top:6px}.yst2-mark{width:30px;height:30px;min-width:30px;border-radius:9px;color:#9ca2b1;font-size:17px}.yst2-mark:hover{background:#292c35}.yst2-mark.checked{color:#72ddb0;background:#20352f}.yst2-ep.is-watched .yst2-epname{color:#b2b6c2}
      .yst2-manual-label{margin-left:auto;padding:4px 6px;border-radius:6px;background:#282a34;color:#aeb4c2;font-size:9px;white-space:nowrap}
      .yst2-empty{text-align:center;padding:34px 18px;color:#e2e4eb;border:1px dashed #353843;border-radius:15px;background:#181a21}.yst2-empty-art{width:56px;height:56px;margin:0 auto 13px;display:grid;place-items:center;border-radius:17px;background:#34202a;color:#ff6a85;font-size:25px;font-weight:800}.yst2-empty h3{font-size:15px;font-weight:750;letter-spacing:-.2px;margin:0 0 7px}.yst2-empty p{max-width:310px;margin:0 auto 15px;color:#999eac;font-size:11px;line-height:1.7}.yst2-empty-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}.yst2-empty-actions button{width:auto!important;margin:0!important}
      .yst2-setting{align-items:flex-start;line-height:1.5;font-size:11px;color:#d5d8e1}.yst2-setting input{margin-top:2px}.yst2-setting select{margin-top:-4px}.yst2-series h3{font-size:13px;margin:2px 0 12px;font-weight:750}.yst2-footer{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 16px;background:#15161c;border-top:1px solid #2a2d35;color:#787e8c;font-size:9px}
      .yst2-privacy{display:flex;align-items:center;gap:6px}.yst2-privacy span{width:6px;height:6px;display:inline-block;border-radius:50%;background:#66d9a8;box-shadow:0 0 0 3px #66d9a818}
      .yst2-history-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}.yst2-history-heading h3{margin:0 0 3px;font-size:13px}.yst2-history-heading .yst2-subbtn{font-size:10px;padding:7px 9px;white-space:nowrap}.yst2-history-play{color:#858b9b;font-size:15px}
      #${PANEL} button:focus-visible,#${PANEL} input:focus-visible,#${PANEL} select:focus-visible{outline:2px solid #ff6682;outline-offset:2px}
      #${PANEL} [hidden]{display:none!important}
      @media(max-width:600px){.yst2-dashboard{padding:10px 10px 8px;gap:6px}.yst2-metric{padding:9px}.yst2-toolbar{padding:10px;align-items:stretch}.yst2-primary-actions{flex:1}.yst2-primary-actions button{flex:1;padding:9px 7px}.yst2-data-actions{align-items:stretch}.yst2-tabs{padding:0 10px 9px}.yst2-tabs button{padding:8px 4px;gap:4px}.yst2-content{padding:10px}.yst2-series{padding:10px}.yst2-series-art{width:83px;min-width:83px;aspect-ratio:1/1}.yst2-serieshead .yst2-icon{width:24px;height:24px}.yst2-seriestitle{font-size:12px}.yst2-continue{gap:7px;padding:8px}.yst2-continue-copy strong{font-size:10px}.yst2-continue-copy small{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.yst2-footer{padding:9px 10px}.yst2-searchwrap{margin-left:10px;margin-right:10px}}
      @media(prefers-reduced-motion:reduce){#${PANEL} *,#${PANEL} *:before,#${PANEL} *:after{transition:none!important;scroll-behavior:auto!important}}
      #yst2-panel .yst2-series-highlight{border-color:#ff5b79;box-shadow:0 0 0 2px #ff315822,0 8px 28px #0006}
      #yst2-panel .yst2-thumb-empty{display:grid;place-items:center;color:#747988;font-size:18px}
      #yst2-panel .yst2-ep.is-unavailable{opacity:.72}
      #yst2-panel .yst2-epname:disabled{cursor:not-allowed;color:#8d92a0}
      #yst2-panel .yst2-mark:disabled{cursor:not-allowed;opacity:.35}
      #yst2-panel .yst2-candidate-list{display:flex;flex-direction:column;gap:7px;margin:10px 0 13px}
      #yst2-panel .yst2-candidate{display:flex;align-items:center;gap:10px;width:100%;padding:9px;border:1px solid #343743;border-radius:10px;background:#22242d;color:#f1f2f6;text-align:left}
      #yst2-panel .yst2-candidate:hover{background:#2d303b;border-color:#65505a}
      #yst2-panel .yst2-candidate img{width:84px;aspect-ratio:16/9;object-fit:cover;border-radius:7px;flex:none}
      #yst2-panel .yst2-candidate-play{width:84px;height:47px;display:grid;place-items:center;background:#34202a;border-radius:7px;color:#ff8ba0;flex:none}
      #yst2-panel .yst2-candidate-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
      #yst2-panel .yst2-candidate-copy strong{font-size:12px;line-height:1.4;overflow-wrap:anywhere}
      #yst2-panel .yst2-candidate-copy small{font-size:10px;color:#a0a5b2}
      #yst2-panel .yst2-candidate-arrow{font-size:22px;color:#a6abba}
    `;document.head.appendChild(st);
  }
  function trackCurrentVideo() {
    const meta=videoMeta(), video=document.querySelector('video');
    if(!meta||!video){
      if(activeVideoCleanup){activeVideoCleanup();activeVideoCleanup=null;}
      currentVideoId='';activeVideo=null;
      return;
    }
    if(currentVideoId===meta.id&&activeVideo===video)return;
    // YouTube may reuse the same <video> element while changing the active watch route.
    // Detach the previous episode's closures before attaching handlers for the new episode.
    if(activeVideoCleanup){activeVideoCleanup();activeVideoCleanup=null;}
    currentVideoId=meta.id;activeVideo=video;
    const list=getPlaylistId();
    const listSeries=list?findSeries(list):undefined;
    const listOrder=listSeries && listSeries.playlistId===list?currentPlaylistIndex():-1;
    const listedOccurrence=listSeries?episodeOccurrence(listSeries,meta.id,listOrder):null;
    const s=listedOccurrence?listSeries:db.series.find(x=>episodeOccurrence(x,meta.id,x.playlistId===list?listOrder:-1));
    const currentOccurrence=s?episodeOccurrence(s,meta.id,s.playlistId===list?listOrder:-1):null;
    if(s&&currentOccurrence){
      activePlaybackSession={seriesId:s.id,videoId:meta.id,order:currentOccurrence.order,catalogRevision:Number(s.catalogRevision)||0};
      s.cursorVideoId=meta.id;
      s.cursorOrder=currentOccurrence.order;
      s.cursorUpdatedAt=Date.now();
    }
    const savePosition=()=>{
      if(db.settings.recordPlaybackProgress===false||!s||location.pathname.startsWith('/shorts/'))return;
      if(!Number.isFinite(video.currentTime)||!Number.isFinite(video.duration)||video.duration<=0||video.duration>604800)return;
      const dur=video.duration;
      const old=stateFor(meta.id), threshold=Number(db.settings.watchedThreshold);
      const watched=old.completionOverride === 'WATCHED' || (old.completionOverride !== 'UNWATCHED' && (old.watched || shouldAutoComplete(video.currentTime,dur,threshold,Number(db.settings.watchedRemainingSeconds ?? AUTO_WATCHED_REMAINING_SECONDS),video.ended)));
      setState(meta.id,{title:meta.title||old.title,position:watched?(dur||video.currentTime):video.currentTime,duration:dur||old.duration,watched},false);
      if(s&&db.settings.recordPlaybackProgress!==false) db.history[meta.id]={title:meta.title,lastSeen:Date.now()};
      saveDB();
      if(document.getElementById(PANEL)?.classList.contains('open')&&Date.now()-lastPanelRender>1800){lastPanelRender=Date.now();renderPanel();}
    };
    const onTime=()=>{if(Date.now()-lastSave>=SAVE_MS){lastSave=Date.now();savePosition();}};
    video.addEventListener('timeupdate',onTime);
    video.addEventListener('loadedmetadata',savePosition,{once:true});
    video.addEventListener('pause',savePosition);
    const onEnded=()=>{
      const previous=stateFor(meta.id);
      if(db.settings.recordPlaybackProgress!==false&&s&&previous.completionOverride!=='UNWATCHED'){
        setState(meta.id,{title:meta.title,position:video.duration||meta.duration,duration:video.duration||meta.duration,watched:true},false);
      }
      if(s) db.history[meta.id]={title:meta.title,lastSeen:Date.now()};
      saveDB();
      if(db.settings.autoNext && s && isWatched(meta.id)) {
        const next=chooseNext(s,meta.id,currentOccurrence&&currentOccurrence.order);
        if(next && next.id!==meta.id) {
          toast(`Playing next episode: ${next.title}`);
          setTimeout(()=>{if(video.ended&&getVideoId()===meta.id)openEpisode(s,next,false);},900);
        }
      }
      if(document.getElementById(PANEL)?.classList.contains('open')){lastPanelRender=Date.now();renderPanel();}
    };
    video.addEventListener('ended',onEnded);
    activeVideoCleanup=()=>{
      video.removeEventListener('timeupdate',onTime);
      video.removeEventListener('loadedmetadata',savePosition);
      video.removeEventListener('pause',savePosition);
      video.removeEventListener('ended',onEnded);
    };
    if(s&&db.settings.recordPlaybackProgress!==false){db.history[meta.id]={title:meta.title,lastSeen:Date.now()};saveDB();}
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
      if(staleRefreshTimer)clearTimeout(staleRefreshTimer);
      staleRefreshTimer=setTimeout(refreshStaleSeries,1200);
    },450);
  }
  function observeSidebar() {
    const mo=new MutationObserver(()=>{
      if(db.settings.showSidebarButton!==false&&!document.getElementById(BTN)) addSidebarButton();
      addPlayerButton();
      addPlaylistFollowButton();
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
      if(db.settings.showSidebarButton!==false&&!document.getElementById(BTN)) addSidebarButton();
      addPlayerButton();
      addPlaylistFollowButton();
    },1500);
  }
  boot();
})();