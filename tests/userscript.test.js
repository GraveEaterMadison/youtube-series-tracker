const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'youtube-series-tracker.user.js'), 'utf8');

function extractSimpleFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Could not find function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

test('userscript metadata targets YouTube and requests no privileged grants', () => {
  assert.match(source, /^\/\/ ==UserScript==/);
  assert.match(source, /^\/\/ @name\s+YouTube Series Tracker$/m);
  assert.match(source, /^\/\/ @namespace\s+https:\/\/github\.com\/GraveEaterMadison\/youtube-series-tracker$/m);
  assert.match(source, /^\/\/ @match\s+https:\/\/www\.youtube\.com\/\*$/m);
  assert.match(source, /^\/\/ @grant\s+none$/m);
  assert.match(source, /^\/\/ ==\/UserScript==/m);
});

test('version and Greasy Fork listing metadata are complete and consistent', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = source.match(/^\/\/ @version\s+(.+)$/m)?.[1]?.trim();
  assert.equal(version, pkg.version);
  assert.match(source, /^\/\/ @license\s+GPL-3\.0-only$/m);
  assert.match(source, /^\/\/ @homepageURL\s+https:\/\/github\.com\/GraveEaterMadison\/youtube-series-tracker$/m);
  assert.match(source, /^\/\/ @supportURL\s+https:\/\/github\.com\/GraveEaterMadison\/youtube-series-tracker\/issues$/m);
});

test('Morphe-inspired player entry point is present and styled with real CSS newlines', () => {
  assert.match(source, /const PLAYER_BTN = 'yst2-player-button'/);
  assert.match(source, /function addPlayerButton\(\)/);
  assert.match(source, /querySelector\('#movie_player'\)/);
  assert.match(source, /\.ytp-chrome-top-buttons/);
  assert.match(source, /function openFromPlayer\(\)/);
  assert.doesNotMatch(source, /vertical-align:top\}\\n/);
});

test('sidebar button relocates when YouTube navigation loads after the userscript', () => {
  assert.match(source, /function addSidebarButton\(\)/);
  assert.match(source, /const host = document\.querySelector\('ytd-guide-section-renderer #items'\)/);
  assert.match(source, /if \(button\.parentElement !== wrap\) wrap\.appendChild\(button\)/);
  assert.match(source, /button\.classList\.remove\('floating'\)/);
});

test('one-by-one series builder actions are wired and versioned', () => {
  assert.match(source, /^\/\/ @version\s+2\.9\.0$/m);
  assert.match(source, /id="yst2-add-current"/);
  assert.match(source, /function showAddVideoDialog\(\)/);
  assert.match(source, /function saveVideoToSeries\(series, meta\)/);
  assert.match(source, /function createManualSeries\(title, meta\)/);
  assert.match(source, /manuallyAdded: true/);
  assert.match(source, /unavailable: ep\.manuallyAdded \? false : true/);
});

test('blank series names receive a unique default name', () => {
  assert.ok(source.includes('function defaultManualSeriesName()'));
  assert.ok(source.includes("String(title || '').trim() || defaultManualSeriesName()"));
  assert.ok(source.includes('placeholder="Optional — defaults to New Series"'));
  assert.doesNotMatch(source, /Enter a name for the new series/);
  assert.ok(source.includes("while (names.has(('New Series ' + suffix).toLocaleLowerCase())) suffix++;"));
});

test('player button starts automatic series following and preserves a manual fallback', () => {
  const fromPlayer = source.slice(source.indexOf('function openFromPlayer()'), source.indexOf('function ensureUI()'));
  assert.match(fromPlayer, /followSeriesFromPlayer\(\)/);
  assert.match(source, /async function followSeriesFromPlayer\(\)/);
  assert.match(source, /async function discoverPlaylistsForVideo\(videoId\)/);
  assert.match(source, /id="yst2-dialog-sync-playlist"/);
  assert.match(source, /No matching playlist was found/);
});

test('manual series does not require a playlist ID', () => {
  assert.match(source, /playlistId: null,\s+manual: true/);
  assert.match(source, /if \(!id\) return undefined/);
});

test('core series-tracking concepts remain present', () => {
  for (const concept of ['localStorage', 'playlist', 'watched', 'export', 'import']) {
    assert.ok(source.toLowerCase().includes(concept.toLowerCase()), 'Expected source to contain ' + concept);
  }
});

test('source does not contain obvious GitHub credential tokens', () => {
  assert.doesNotMatch(source, /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
});

test('userscript has no remote-script loader directives', () => {
  assert.doesNotMatch(source, /^\/\/ @require\s/m);
  assert.doesNotMatch(source, /^\/\/ @resource\s/m);
});

test('readme describes beta status and local storage limitations', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /beta/i);
  assert.match(readme, /localStorage/i);
  assert.match(readme, /end-to-end tests/i);
});

test('auto-next never repeats an already-watched episode when no unwatched episode follows', () => {
  const watched = new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  const orderedEpisodes = vm.runInNewContext(`(${extractSimpleFunction(source, 'orderedEpisodes')})`);
  const chooseNext = vm.runInNewContext(`(${extractSimpleFunction(source, 'chooseNext')})`, {
    stateFor: id => ({ watched: watched.has(id) }),
    isWatched: id => watched.has(id),
    chooseContinue: () => ({ id: 'ddddddddddd' }),
    orderedEpisodes
  });
  const series = { episodes: [
    { id: 'aaaaaaaaaaa', order: 0 },
    { id: 'bbbbbbbbbbb', order: 1 },
    { id: 'ccccccccccc', order: 2 }
  ] };
  assert.equal(chooseNext(series, 'aaaaaaaaaaa'), null);
});

test('auto-next selects the next unwatched episode in playlist order', () => {
  const watched = new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  const orderedEpisodes = vm.runInNewContext(`(${extractSimpleFunction(source, 'orderedEpisodes')})`);
  const chooseNext = vm.runInNewContext(`(${extractSimpleFunction(source, 'chooseNext')})`, {
    stateFor: id => ({ watched: watched.has(id) }),
    isWatched: id => watched.has(id),
    chooseContinue: () => null,
    orderedEpisodes
  });
  const series = { episodes: [
    { id: 'aaaaaaaaaaa', order: 0 },
    { id: 'bbbbbbbbbbb', order: 1 },
    { id: 'ccccccccccc', order: 2 }
  ] };
  assert.equal(chooseNext(series, 'aaaaaaaaaaa').id, 'ccccccccccc');
});

test('playlist refresh and history scan can batch state changes into one write', () => {
  const setState = extractSimpleFunction(source, 'setState');
  const mergeSeries = extractSimpleFunction(source, 'mergeSeries');
  const historyScan = extractSimpleFunction(source, 'scanHistoryPage');
  assert.match(setState, /persist = true/);
  assert.match(mergeSeries, /setState\(ep\.id,\s*\{[^}]+\},\s*false\)/);
  assert.match(historyScan, /setState\(id,\s*\{watched:true,completionOverride:'AUTO'\},\s*false\)/);
});

test('video listeners are detached before tracking a new YouTube route', () => {
  assert.match(source, /let activeVideoCleanup = null/);
  const track = source.slice(source.indexOf('function trackCurrentVideo()'), source.indexOf('function routeChanged()'));
  assert.ok(track.indexOf('if(activeVideoCleanup){activeVideoCleanup();activeVideoCleanup=null;}') < track.indexOf('video.addEventListener'), 'previous listeners should be removed before handlers are attached');
  assert.match(track, /video\.removeEventListener\('timeupdate',onTime\)/);
  assert.match(track, /video\.removeEventListener\('ended',onEnded\)/);
  assert.match(track, /if\(!meta\|\|!video\)\{\s*if\(activeVideoCleanup\)/);
  assert.doesNotMatch(source, /const listenerVideos = new WeakSet\(\)/);
});

test('library UI uses compact popup, creator branding, profile link, and responsive polish', () => {
  assert.match(source, /id="yst2-search"/);
  assert.match(source, /id="yst2-dashboard"/);
  assert.match(source, /class="yst2-series-art"/);
  assert.match(source, /aria-selected=/);
  assert.ok(source.includes('data-sync="\' + esc(s.id)'), "series sync action should be rendered");
  assert.ok(source.includes("const applySearch = ()"), "library search should be wired");
  assert.match(source, /prefers-reduced-motion:reduce/);
  assert.match(source, /zeroyogurt edition/);
  assert.match(source, /Made by zeroyogurt/);
  assert.ok(source.includes("https://github.com/GraveEaterMadison"), "creator profile link should be present");
  assert.ok(source.includes("width:min(490px,calc(100vw - 32px))"), "popup should remain compact");
  assert.doesNotMatch(source, /inset:0;width:100vw;height:100dvh/);
});

test('playlist fetch is scoped to the requested list and follows bounded continuation pages', () => {
  assert.match(source, /browseId: 'VL' \+ listId/);
  assert.match(source, /function parsePlaylistPage\(data, listId, continuation, offset\)/);
  assert.match(source, /playlistPanelFor\(data, listId\)/);
  assert.match(source, /maxRequests: 100/);
  assert.match(source, /no partial catalog was saved/i);
  const fetcher = source.slice(source.indexOf('async function fetchFullPlaylist'), source.indexOf('function playlistTitleFromDOM'));
  assert.doesNotMatch(fetcher, /findPlaylistRenderer\(data\)/);
  assert.doesNotMatch(fetcher, /domPlaylistItems\(\)/);
});

test('special radio mixes, Watch Later and Library lists are excluded from automatic following', () => {
  const isSuggestible = vm.runInNewContext('(' + extractSimpleFunction(source, 'isSuggestiblePlaylistId') + ')');
  assert.equal(isSuggestible('PLabcdefghijk'), true);
  assert.equal(isSuggestible('RDMMabcdefghij'), false);
  assert.equal(isSuggestible('WL'), false);
  assert.equal(isSuggestible('LL'), false);
  assert.equal(isSuggestible('not a playlist'), false);
});

test('series naming removes episode suffixes and preserves season identity', () => {
  const deriveName = vm.runInNewContext('(' + extractSimpleFunction(source, 'seriesSearchTitle') + ')');
  assert.equal(deriveName('Skybound Episode 12 | English Dub'), 'Skybound');
  assert.equal(deriveName('Blue Station Season 2 Episode 3'), 'Blue Station Season 2');
});

test('episode order inference reverses newest-first numbered catalogs only when evidence is strong', () => {
  const number = vm.runInNewContext('(' + extractSimpleFunction(source, 'episodeNumberFromTitle') + ')');
  const infer = vm.runInNewContext('(' + extractSimpleFunction(source, 'inferReverseOrder') + ')', {
    episodeNumberFromTitle: number
  });
  assert.equal(infer([
    {id:'aaaaaaaaaaa',title:'Episode 12',available:true},
    {id:'bbbbbbbbbbb',title:'Episode 11',available:true},
    {id:'ccccccccccc',title:'Episode 10',available:true}
  ]), true);
  assert.equal(infer([
    {id:'aaaaaaaaaaa',title:'Episode 1',available:true},
    {id:'bbbbbbbbbbb',title:'Episode 2',available:true},
    {id:'ccccccccccc',title:'Episode 3',available:true}
  ]), false);
  assert.equal(infer([
    {id:'aaaaaaaaaaa',title:'Episode 1',available:true},
    {id:'bbbbbbbbbbb',title:'Special',available:true},
    {id:'ccccccccccc',title:'Episode 3',available:true}
  ]), false);
});

test('visual episode order leaves original YouTube playlist indexes intact', () => {
  const ordered = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const series = {playbackReverse:true,episodes:[
    {id:'one',order:0},{id:'two',order:1},{id:'three',order:2}
  ]};
  assert.deepEqual(Array.from(ordered(series), ep => ep.id), ['three','two','one']);
  assert.equal(series.episodes[0].order, 0);
});

test('unavailable playlist slots remain visible but cannot be opened or marked watched', () => {
  assert.match(source, /__yst_unavailable__/);
  assert.match(source, /available,\s*unavailable: !available/);
  assert.match(source, /const unavailable = Boolean\(e\.unavailable \|\| e\.available === false/);
  assert.match(source, /if \(!s \|\| !e \|\| e\.unavailable \|\| e\.available === false/);
  assert.match(source, /if \(!\/\^\[A-Za-z0-9_-\]\{11\}\$\/\.test\(id\)\) return/);
});

test('playlist discovery verifies that each candidate catalog contains the currently playing video', () => {
  const discovery = source.slice(source.indexOf('async function discoverPlaylistsForVideo'), source.indexOf('function showSeriesInLibrary'));
  assert.match(discovery, /catalog\.items\.some\(item => item\.id === videoId/);
  assert.match(discovery, /fetchFullPlaylist\(candidate\.id/);
  assert.match(source, /catalog\.items\.some\(item => item\.id === capturedVideo/);
  assert.match(source, /Choose the series playlist/);
});

test('playback tracker never silently appends a video absent from the followed catalog', () => {
  const track = source.slice(source.indexOf('function trackCurrentVideo()'), source.indexOf('function routeChanged()'));
  assert.match(track, /const listedOccurrence=listSeries\?episodeOccurrence\(listSeries,meta\.id,listOrder\):null/);
  assert.match(track, /s\.cursorVideoId=meta\.id/);
  assert.doesNotMatch(track, /s\.episodes\.push\(\{id:meta\.id/);
});


test('wrapped playlist-panel rows retain the original YouTube episode index', () => {
  const rendererText = vm.runInNewContext('(' + extractSimpleFunction(source, 'rendererText') + ')');
  const rowEpisode = vm.runInNewContext('(' + extractSimpleFunction(source, 'playlistRowEpisode') + ')', {
    rendererText,
    parseDuration: () => 0
  });
  const parseRows = vm.runInNewContext('(' + extractSimpleFunction(source, 'parsePlaylistRows') + ')', {
    rendererText,
    playlistRowEpisode: rowEpisode,
    playlistContinuation: () => ''
  });
  const row = {
    playlistPanelVideoWrapperRenderer: {
      primaryRenderer: {
        playlistPanelVideoRenderer: {
          videoId: 'aaaaaaaaaaa',
          title: { simpleText: 'Episode 7' },
          index: { simpleText: '7' }
        }
      }
    }
  };
  const parsed = parseRows([row], 'PLabcdefghijk', 0, {});
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, 'aaaaaaaaaaa');
  assert.equal(parsed.items[0].order, 6);
  assert.equal(parsed.items[0].available, true);
});


test('episode-order inference falls back to relative upload ages when episode numbers are absent', () => {
  const number = vm.runInNewContext('(' + extractSimpleFunction(source, 'episodeNumberFromTitle') + ')');
  const age = vm.runInNewContext('(' + extractSimpleFunction(source, 'episodeAgeRange') + ')');
  const infer = vm.runInNewContext('(' + extractSimpleFunction(source, 'inferReverseOrder') + ')', {
    episodeNumberFromTitle: number,
    episodeAgeRange: age
  });
  const newestFirst = [
    {id:'aaaaaaaaaaa',title:'Opening',videoInfo:'3 days ago • 10K views',available:true},
    {id:'bbbbbbbbbbb',title:'Chapter continues',videoInfo:'2 weeks ago • 8K views',available:true},
    {id:'ccccccccccc',title:'Final chapter',videoInfo:'3 months ago • 2K views',available:true}
  ];
  const oldestFirst = [...newestFirst].reverse();
  assert.equal(infer(newestFirst), true);
  assert.equal(infer(oldestFirst), false);
});

test('localized episode numbers are recognized without guessing ambiguous compilations', () => {
  const number = vm.runInNewContext('(' + extractSimpleFunction(source, 'episodeNumberFromTitle') + ')');
  assert.equal(number('Épisode 7 — Saison 2'), 20007);
  assert.equal(number('Episode 1 to Episode 12 Compilation'), null);
});


test('resume planner starts from the selected cursor before falling back to the first unwatched episode', () => {
  const orderedEpisodes = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const chooseContinue = vm.runInNewContext('(' + extractSimpleFunction(source, 'chooseContinue') + ')', {
    orderedEpisodes,
    stateFor: id => ({ watched: id === 'aaaaaaaaaaa' }),
    isWatched: id => id === 'aaaaaaaaaaa'
  });
  const series = {
    cursorVideoId: 'bbbbbbbbbbb',
    cursorOrder: 1,
    episodes: [
      {id:'aaaaaaaaaaa',order:0},
      {id:'bbbbbbbbbbb',order:1},
      {id:'ccccccccccc',order:2}
    ]
  };
  assert.equal(chooseContinue(series).id, 'bbbbbbbbbbb');
  series.cursorVideoId = 'aaaaaaaaaaa';
  series.cursorOrder = 0;
  assert.equal(chooseContinue(series).id, 'bbbbbbbbbbb');
});

test('YouTube channel playlist-tab lookup verifies channel identity before enumerating its playlists', () => {
  const channelBrowseTabs = vm.runInNewContext('(' + extractSimpleFunction(source, 'channelBrowseTabs') + ')');
  const getEndpoint = vm.runInNewContext('(' + extractSimpleFunction(source, 'channelPlaylistEndpoint') + ')', {channelBrowseTabs});
  const channel = 'UCabcdefghijklmnopqrstuv';
  const valid = {
    metadata: {channelMetadataRenderer:{externalId:channel}},
    contents: {twoColumnBrowseResultsRenderer:{tabs:[
      {tabRenderer:{title:'Home',endpoint:{browseEndpoint:{browseId:channel}}}},
      {tabRenderer:{title:'Playlists',endpoint:{browseEndpoint:{browseId:channel,params:'PL_PARAMS'}}}}
    ]}}
  };
  assert.equal(getEndpoint(valid, channel), 'PL_PARAMS');
  assert.equal(getEndpoint(valid, 'UCxxxxxxxxxxxxxxxxxxxxxx'), '');
});

test('playlist discovery also parses YouTube lockup playlist cards', () => {
  const rendererText = vm.runInNewContext('(' + extractSimpleFunction(source, 'rendererText') + ')');
  const seriesSearchTitle = vm.runInNewContext('(' + extractSimpleFunction(source, 'seriesSearchTitle') + ')');
  const normalizeSearchTokens = vm.runInNewContext('(' + extractSimpleFunction(source, 'normalizeSearchTokens') + ')');
  const isSuggestiblePlaylistId = vm.runInNewContext('(' + extractSimpleFunction(source, 'isSuggestiblePlaylistId') + ')');
  const isDiscoveryPlaylistId = vm.runInNewContext('(' + extractSimpleFunction(source, 'isDiscoveryPlaylistId') + ')', {isSuggestiblePlaylistId});
  const parse = vm.runInNewContext('(' + extractSimpleFunction(source, 'parsePlaylistSearchCandidates') + ')', {
    rendererText, seriesSearchTitle, normalizeSearchTokens, isDiscoveryPlaylistId
  });
  const result = parse({
    contents: {richGridRenderer:{contents:[{richItemRenderer:{content:{lockupViewModel:{
      contentType:'LOCKUP_CONTENT_TYPE_PLAYLIST',
      contentId:'PLabcdefghijk',
      metadata:{lockupMetadataViewModel:{title:{content:'Skybound Season 1'}}},
      contentImage:{thumbnailViewModel:{image:{sources:[{url:'https://example.invalid/cover.jpg'}]}}}
    }}}}]}}
  }, {title:'Skybound Episode 4',channelId:'UCabcdefghijklmnopqrstuv'});
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'PLabcdefghijk');
  assert.equal(result[0].title, 'Skybound Season 1');
  assert.ok(result[0].score > 0);
});

test('current playlist indexes are normalized from YouTube one-based index URLs', () => {
  const currentPlaylistIndex = vm.runInNewContext('(' + extractSimpleFunction(source, 'currentPlaylistIndex') + ')', {
    URL,
    location:{origin:'https://www.youtube.com'}
  });
  assert.equal(currentPlaylistIndex('https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabcdefghijk&index=4'), 3);
  assert.equal(currentPlaylistIndex('https://www.youtube.com/watch?v=aaaaaaaaaaa'), -1);
});


test('direct playlist following has a readable series-name fallback when YouTube omits playlist metadata', () => {
  assert.match(source, /title: catalog\.title \|\| playlistTitleFromDOM\(\) \|\| seriesSearchTitle\(currentVideoDetails\(capturedVideo\)\.title\)/);
});

test('resume cursor and auto-next match the active YouTube playlist index', () => {
  assert.match(source, /function currentPlaylistIndex\(url\)/);
  assert.match(source, /function episodeOccurrence\(series, videoId, requestedOrder\)/);
  assert.match(source, /const listOrder=listSeries && listSeries\.playlistId===list\?currentPlaylistIndex\(\):-1/);
  assert.match(source, /chooseNext\(s,meta\.id,currentOccurrence&&currentOccurrence\.order\)/);
  assert.match(source, /series\.cursorOrder = episode\.order/);
});

test('discovery inspects the channel Playlists tab before falling back to general YouTube search', () => {
  const discovery = source.slice(source.indexOf('async function discoverPlaylistsForVideo'), source.indexOf('function showSeriesInLibrary'));
  const descriptionStage = discovery.indexOf('for (const id of linked)');
  const channelStage = discovery.indexOf('channelPlaylistCandidates(details, budget)');
  const searchStage = discovery.indexOf("const seriesTitle = seriesSearchTitle(details.title)");
  assert.ok(descriptionStage >= 0 && channelStage > descriptionStage && searchStage > channelStage);
  assert.match(source, /async function channelPlaylistCandidates\(details, budget\)/);
  assert.match(source, /LOCKUP_CONTENT_TYPE_PLAYLIST/);
});


test('series episode lists are lazy-rendered in bounded batches', () => {
  const seriesCard = source.slice(source.indexOf('function seriesHTML(s)'), source.indexOf('function renderPanel()'));
  assert.match(seriesCard, /data-episode-list=/);
  assert.match(seriesCard, /data-load-more=/);
  assert.doesNotMatch(seriesCard, /orderedEpisodes\(s\)\.map\(e=>episodeHTML\(s,e\)\)/);
  assert.match(source, /const EPISODE_BATCH_SIZE = 50/);
  assert.match(source, /function appendEpisodeBatch\(details, requestedTotal\)/);
});

test('lazy episode-list state and scroll position survive panel rerenders', () => {
  assert.match(source, /const episodeUiState = new Map\(\)/);
  assert.match(source, /loaded: list \? list\.children\.length : 0/);
  assert.match(source, /scrollTop: list \? list\.scrollTop : 0/);
  assert.match(source, /appendEpisodeBatch\(details, state\.loaded\)/);
  assert.match(source, /if\s*\(details\.open\s*&&\s*details\.querySelector/);
});

test('episode search includes titles even when their rows have not been loaded into the DOM', () => {
  assert.match(source, /\[series\.title, \.\.\.series\.episodes\.map\(ep => ep\.title \|\| ''\)\]/);
  assert.match(source, /let haystack = item\.textContent\.toLocaleLowerCase\(\)/);
});

test('playback progress UI has its own throttle and does not reuse the save throttle', () => {
  assert.match(source, /let lastPanelRender = 0/);
  assert.match(source, /Date\.now\(\)-lastPanelRender>1800/);
  assert.match(source, /lastPanelRender=Date\.now\(\);renderPanel\(\)/);
});


test('Morphe-style completion policy supports percentage and remaining-time completion', () => {
  const complete = vm.runInNewContext('(' + extractSimpleFunction(source, 'shouldAutoComplete') + ')');
  assert.equal(complete(920, 1000, 0.92, 30, false), true);
  assert.equal(complete(850, 1000, 0.92, 30, false), false);
  assert.equal(complete(970, 1000, 1, 30, false), true);
  assert.equal(complete(500, 1000, 0.92, 30, true), true);
  assert.equal(complete(50, 0, 0.92, 30, false), false);
});

test('manual watched and unwatched overrides take precedence over automatic state', () => {
  const isWatched = vm.runInNewContext('(' + extractSimpleFunction(source, 'isWatchedState') + ')');
  assert.equal(isWatched({watched:false, completionOverride:'WATCHED'}), true);
  assert.equal(isWatched({watched:true, completionOverride:'UNWATCHED'}), false);
  assert.equal(isWatched({watched:true, completionOverride:'AUTO'}), true);
  assert.equal(isWatched({watched:false, completionOverride:'AUTO'}), false);
});

test('manual completion is respected by recording and lazy-rendered episode actions', () => {
  assert.match(source, /old\.completionOverride !== 'UNWATCHED'/);
  assert.match(source, /markEpisode\(mark\.dataset\.mark, !isWatched\(mark\.dataset\.mark\)\)/);
  assert.match(source, /const through = article\.querySelector\('\[data-through\]'\)/);
});

test('bulk mark-through and undo are implemented for series progress', () => {
  assert.match(source, /function rememberUndo\(ids, description\)/);
  assert.match(source, /function undoLastChange\(\)/);
  assert.match(source, /function markThrough\(series, targetEpisode\)/);
  assert.match(source, /data-through=/);
  assert.match(source, /id="yst2-undo"/);
  assert.match(source, /completionOverride:'WATCHED'/);
});

test('remaining-time completion is configurable independently from auto-next', () => {
  assert.match(source, /watchedRemainingSeconds: AUTO_WATCHED_REMAINING_SECONDS/);
  assert.match(source, /id="yst2-remaining"/);
  assert.match(source, /id="yst2-autonext"/);
});


test('Morphe library controls support navigation visibility, per-series Hide watched, and Start here', () => {
  assert.match(source, /id="yst2-sidebar"/);
  assert.match(source, /function setSeriesStartHere\(series, episode\)/);
  assert.match(source, /data-start-here=/);
  assert.match(source, /data-hide-watched=/);
  assert.match(source, /filter\(episode => !series\.hideWatched \|\| !isWatched\(episode\.id\)\)/);
  assert.match(source, /const startHere = series\.startHereVideoId/);
});

test('Start here is chosen even when the selected episode is already marked watched', () => {
  const orderedEpisodes = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const chooseContinue = vm.runInNewContext('(' + extractSimpleFunction(source, 'chooseContinue') + ')', {
    orderedEpisodes,
    isWatched: () => true,
    stateFor: () => ({ watched: true })
  });
  const series = {
    startHereVideoId: 'bbbbbbbbbbb',
    startHereOrder: 1,
    episodes: [
      {id:'aaaaaaaaaaa',order:0},
      {id:'bbbbbbbbbbb',order:1},
      {id:'ccccccccccc',order:2}
    ]
  };
  assert.equal(chooseContinue(series).id, 'bbbbbbbbbbb');
});


test('episode controls preserve playlist occurrence identity for duplicate videos', () => {
  assert.match(source, /data-start-here="[^"]*" data-sid="[^"]*" data-order="[^"]*"/);
  assert.match(source, /data-through="[^"]*" data-sid="[^"]*" data-order="[^"]*"/);
  assert.match(source, /item\.id === through\.dataset\.through && item\.order === Number\(through\.dataset\.order\)/);
  assert.match(source, /item\.id === start\.dataset\.startHere && item\.order === Number\(start\.dataset\.order\)/);
});


test('Morphe-style resume planner handles start-here, next, caught-up, and empty states', () => {
  const orderedEpisodes = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const planner = vm.runInNewContext('(' + extractSimpleFunction(source, 'resumePlan') + ')', {
    orderedEpisodes,
    isWatched: id => id === 'aaaaaaaaaaa',
    stateFor: id => ({watched:id === 'aaaaaaaaaaa',position:id === 'bbbbbbbbbbb' ? 37 : 0,updatedAt:10}),
    saveDB: () => {}
  });
  const episodes = [{id:'aaaaaaaaaaa',order:0},{id:'bbbbbbbbbbb',order:1},{id:'ccccccccccc',order:2}];
  const start = planner({episodes,startHereVideoId:'aaaaaaaaaaa',startHereOrder:0});
  assert.equal(start.kind,'RESUME');
  assert.equal(start.episode.id,'aaaaaaaaaaa');
  assert.equal(start.position,0);
  const next = planner({episodes,cursorVideoId:'aaaaaaaaaaa',cursorOrder:0,cursorRevision:2,catalogRevision:2});
  assert.equal(next.kind,'NEXT');
  assert.equal(next.episode.id,'bbbbbbbbbbb');
  assert.equal(next.position,37);
  const caught = planner({episodes:episodes.slice(0,1),cursorVideoId:'aaaaaaaaaaa',cursorOrder:0,cursorRevision:2,catalogRevision:2});
  assert.equal(caught.kind,'CAUGHT_UP');
  assert.equal(planner({episodes:[]}).kind,'NO_PLAYABLE');
});

test('Morphe-style resume planner requests recovery when the saved cursor is removed', () => {
  const orderedEpisodes = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const planner = vm.runInNewContext('(' + extractSimpleFunction(source, 'resumePlan') + ')', {
    orderedEpisodes,isWatched:()=>false,stateFor:()=>({watched:false,position:0}),saveDB:()=>{}
  });
  const series={episodes:[{id:'bbbbbbbbbbb',order:0}],cursorVideoId:'aaaaaaaaaaa',cursorOrder:0,cursorRevision:1,catalogRevision:2};
  const result=planner(series);
  assert.equal(result.kind,'CHOOSE');
  assert.equal(series.recoveryRequired,true);
  assert.equal(series.recoveryVideoId,'aaaaaaaaaaa');
});

test('catalog refresh policy respects six-hour age and retry backoff', () => {
  const due=vm.runInNewContext('(' + extractSimpleFunction(source,'catalogRefreshDue') + ')');
  const now=10_000_000;
  assert.equal(due({playlistId:'PLabcdefghijk',lastSyncedAt:now-7*60*60*1000,lastRefreshAttemptAt:now-7*60*60*1000},now),true);
  assert.equal(due({playlistId:'PLabcdefghijk',lastSyncedAt:now-60*60*1000,lastRefreshAttemptAt:now-60*60*1000},now),false);
  assert.equal(due({playlistId:'PLabcdefghijk',lastSyncedAt:now-7*60*60*1000,lastRefreshAttemptAt:now-60*60*1000,refreshRetryAt:now+1000},now),false);
  assert.equal(due({manual:true},now),false);
});

test('visible History percentages can complete without inventing a resume position', () => {
  const complete=vm.runInNewContext('(' + extractSimpleFunction(source,'shouldAutoCompletePercentage') + ')');
  assert.equal(complete(92,1000,0.92),true);
  assert.equal(complete(90,1000,0.92),false);
  assert.equal(complete(99,1000,1),false);
  assert.equal(complete(100,1000,1),true);
  assert.equal(complete(92,0,0.92),false);
});

test('backup validation accepts legacy and versioned files and rejects duplicate occurrences', () => {
  const empty=()=>({version:2,settings:{watchedThreshold:0.92,watchedRemainingSeconds:30,autoNext:false},series:[],episodes:{},history:{},lastSync:0});
  const validate=vm.runInNewContext('(' + extractSimpleFunction(source,'validateBackupDocument') + ')',{
    emptyDB:empty,MAX_BACKUP_SERIES:500,MAX_BACKUP_EPISODES:50000,VERSION:2
  });
  const data={
    series:[{id:'PLabcdefghijk',title:'Test series',playlistId:'PLabcdefghijk',episodes:[{id:'aaaaaaaaaaa',title:'Episode 1',order:0,duration:600}]}],
    episodes:{aaaaaaaaaaa:{watched:false,position:30,duration:600,completionOverride:'AUTO'}},
    history:{},settings:{autoNext:true}
  };
  const legacy=validate(data);
  assert.equal(legacy.series.length,1);
  assert.equal(legacy.episodes.aaaaaaaaaaa.position,30);
  assert.equal(legacy.settings.autoNext,true);
  const envelope=validate({format:'youtube-series-tracker',formatVersion:1,data});
  assert.equal(envelope.series[0].episodes[0].url,'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.throws(()=>validate({...data,series:[{...data.series[0],episodes:[{id:'aaaaaaaaaaa',order:0},{id:'aaaaaaaaaaa',order:0}]}]}),/Duplicate episode occurrence/);
  assert.throws(()=>validate({...data,series:[{id:'?',title:'bad',episodes:[]}]}),/Invalid or duplicate series identity/);
});

test('player follow flow exposes start-order and previous-episode options', () => {
  assert.match(source,/function showFollowSetupDialog\(candidate, videoId\)/);
  assert.match(source,/id="yst2-follow-order"/);
  assert.match(source,/id="yst2-follow-watch-previous"/);
  assert.match(source,/options\.watchPrevious && startIndex>0/);
  assert.match(source,/showFollowSetupDialog\(matches\[0\], capturedVideo\)/);
});

test('playlist and player navigation controls have independent actions', () => {
  assert.match(source,/function addPlaylistFollowButton\(\)/);
  assert.match(source,/id=PLAYLIST_BTN/);
  assert.match(source,/function navigateSeries\(direction, nativeOwned = false\)/);
  assert.match(source,/addNav\(PLAYER_PREV_BTN,/);
  assert.match(source,/addNav\(PLAYER_NEXT_BTN,/);
  assert.match(source,/id="yst2-player-visible"/);
});

test('local progress and History import are independently configurable', () => {
  assert.match(source,/id="yst2-record-progress"/);
  assert.match(source,/id="yst2-import-history"/);
  assert.match(source,/function recordingAllowed\(\)/);
  assert.match(source,/accountConsentAllows\(db\.settings\.recordPlaybackProgress === true, activeAccountDigest, privacy\.consentAccount\)/);
  assert.match(source,/db\.settings\.importHistoryProgress && percent !== null/);
  assert.match(source,/state\.completionOverride !== 'UNWATCHED'/);
});

test('backup preview and local data cleanup have separate controls', () => {
  assert.match(source,/function validateBackupDocument\(document\)/);
  assert.match(source,/Backup preview/);
  assert.match(source,/id="yst2-clear-progress"/);
  assert.match(source,/id="yst2-clear-history"/);
  assert.match(source,/formatVersion: 1/);
});


test('resume planner follows playback order when a series is reversed', () => {
  const orderedEpisodes = vm.runInNewContext('(' + extractSimpleFunction(source, 'orderedEpisodes') + ')');
  const planner = vm.runInNewContext('(' + extractSimpleFunction(source, 'resumePlan') + ')', {
    orderedEpisodes,
    isWatched: id => id === 'ccccccccccc',
    stateFor: id => ({watched:id === 'ccccccccccc',position:0}),
    saveDB: () => {}
  });
  const series = {
    playbackReverse: true,
    episodes: [
      {id:'aaaaaaaaaaa',order:0},
      {id:'bbbbbbbbbbb',order:1},
      {id:'ccccccccccc',order:2}
    ],
    cursorVideoId:'ccccccccccc',
    cursorOrder:2,
    cursorRevision:1,
    catalogRevision:1
  };
  const result = planner(series);
  assert.equal(result.kind,'NEXT');
  assert.equal(result.episode.id,'bbbbbbbbbbb');
});


test('playlist URL parser accepts playlist IDs and URLs but excludes special mixes', () => {
  const suggestible = vm.runInNewContext('(' + extractSimpleFunction(source, 'isSuggestiblePlaylistId') + ')');
  const parse = vm.runInNewContext('(' + extractSimpleFunction(source, 'parsePlaylistInput') + ')', {
    URL,
    isSuggestiblePlaylistId: suggestible
  });
  assert.equal(parse('PLabcdefghijk'), 'PLabcdefghijk');
  assert.equal(parse('https://www.youtube.com/playlist?list=PLabcdefghijk'), 'PLabcdefghijk');
  assert.equal(parse('https://youtube.com/watch?v=aaaaaaaaaaa&list=PLabcdefghijk'), 'PLabcdefghijk');
  assert.equal(parse('https://www.youtube.com/watch?v=aaaaaaaaaaa'), '');
  assert.equal(parse('RDMMabcdefghijk'), '');
  assert.equal(parse(''), '');
});

test('Morphe native backup adapter converts milliseconds, ordinals, overrides and bookmarks', () => {
  const adapt = vm.runInNewContext('(' + extractSimpleFunction(source, 'adaptMorpheBackup') + ')', {
    MAX_BACKUP_SERIES: 500,
    MAX_BACKUP_EPISODES: 50000
  });
  const native = {
    format: 'series-tracker',
    version: 1,
    series: [{
      id: 'PLabcdefghijk',
      name: 'Morphe series',
      complete: true,
      reverse: true,
      hideWatched: true,
      cursor: 'bbbbbbbbbbb',
      ordinal: 2,
      cursorValid: true,
      bookmark: 'ddddddddddd',
      startHere: true,
      fetchedAt: 200,
      activity: 300,
      recovery: '',
      episodes: [
        { ordinal: 1, id: 'aaaaaaaaaaa', title: 'Episode one', info: '1M views', duration: 60000, available: true },
        { ordinal: 2, id: 'bbbbbbbbbbb', title: 'Episode two', info: '2M views', duration: 90000, available: true },
        { ordinal: 3, id: '', title: 'Deleted episode', info: '', duration: 0, available: false }
      ]
    }],
    progress: {
      aaaaaaaaaaa: { position: 25000, duration: 60000, completed: false, override: 'AUTO', playedAt: 100 },
      bbbbbbbbbbb: { position: 90000, duration: 90000, completed: false, override: 'UNWATCHED', playedAt: 200 },
      ddddddddddd: { position: 12000, duration: 40000, completed: false, override: 'AUTO', playedAt: 250 }
    }
  };
  const result = adapt(native);
  const series = result.series[0];
  assert.equal(series.title, 'Morphe series');
  assert.equal(series.playlistId, 'PLabcdefghijk');
  assert.equal(series.playbackReverse, true);
  assert.equal(series.hideWatched, true);
  assert.equal(series.cursorOrder, 1);
  assert.equal(series.startHereOrder, 1);
  assert.equal(series.bookmarkVideoId, 'ddddddddddd');
  assert.equal(series.episodes[0].order, 0);
  assert.equal(series.episodes[0].duration, 60);
  assert.equal(series.episodes[2].unavailable, true);
  assert.equal(result.episodes.aaaaaaaaaaa.position, 25);
  assert.equal(result.episodes.bbbbbbbbbbb.completionOverride, 'UNWATCHED');
  assert.equal(result.episodes.ddddddddddd.position, 12);
});

test('native Morphe export is exposed and uses milliseconds with one-based ordinals', () => {
  assert.match(source, /function exportMorpheBackup\(\)/);
  assert.match(source, /format:'series-tracker',version:1/);
  assert.match(source, /Math\.round\(\(Number\(ep\.duration\)\|\|0\)\*1000\)/);
  assert.match(source, /ordinal:\(Number\.isInteger\(ep\.order\).*\)\+1/);
  assert.match(source, /id="yst2-export-morphe"/);
});

test('backup import merges missing series and does not replace current database state', () => {
  const importer = source.slice(source.indexOf('function importBackup()'), source.indexOf('function historyProgressPercent'));
  assert.match(importer, /const missingSeries=restored\.series\.filter\(series=>!existingIds\.has\(series\.id\)\)/);
  assert.match(importer, /db\.series\.push\(\.\.\.missingSeries\)/);
  assert.match(importer, /!Object\.prototype\.hasOwnProperty\.call\(db\.episodes,id\)/);
  assert.match(importer, /Existing series and progress were preserved/);
  assert.doesNotMatch(importer, /db\s*=\s*restored/);
});

test('Morphe-style episode menu supports restart, resume, Start here, override reset, and mark-through', () => {
  assert.match(source, /function showEpisodeMenu\(series, episode\)/);
  assert.match(source, /Restart from 0:00/);
  assert.match(source, /Resume at /);
  assert.match(source, /Use automatic watched status/);
  assert.match(source, /markEpisode\(episode\.id, 'AUTO'\)/);
  assert.match(source, /Mark watched through this episode/);
  assert.match(source, /data-episode-menu=/);
});

test('master enable switch and Follow-by-link workflow are wired', () => {
  assert.match(source, /id="yst2-enabled"/);
  assert.match(source, /id="yst2-follow-playlist"/);
  assert.match(source, /function showFollowPlaylistDialog\(\)/);
  assert.match(source, /function showPlaylistFollowWizard\(candidate\)/);
  assert.match(source, /Mark earlier episodes watched/);
  assert.match(source, /Enable Series Tracker/);
});

test('History page gets a non-destructive Series entry point', () => {
  assert.match(source, /function addHistorySwitcher\(\)/);
  assert.match(source, /yst2-history-switcher/);
  assert.match(source, /activeTab='library'; openPanel\(\)/);
});







test('Series episode launch always passes an explicit zero or resume timestamp', () => {
  assert.match(source, /const startAt=resume&&!startsHere&&!isWatched\(e\.id\)\?Math\.max\(0,Number\(st\.position\)\|\|0\):0/);
  assert.match(source, /destination\.searchParams\.set\('t',Math\.floor\(startAt\)\+'s'\)/);
});


test('native YouTube player navigation follows an explicitly started Series session', () => {
  assert.match(source, /const SERIES_SESSION_KEY = 'yst2-series-playback-session'/);
  assert.match(source, /function readSeriesPlaybackSession\(\)/);
  assert.match(source, /function writeSeriesPlaybackSession\(value\)/);
  assert.match(source, /function clearSeriesPlaybackSession\(\)/);
  assert.match(source, /function installNativeSeriesNavigation\(\)/);
  assert.match(source, /#movie_player \.ytp-next-button, #movie_player \.ytp-prev-button/);
  assert.match(source, /function handleOwnedSeriesRouteChange\(nextVideoId\)/);
  assert.match(source, /if \(nextVideoId === expected\.id\)/);
  assert.match(source, /writeSeriesPlaybackSession\(activePlaybackSession\)/);
  assert.match(source, /navigateSeries\(direction, true\)/);
  assert.match(source, /clearSeriesPlaybackSession\(\);routeChanged\(\)/);
});


test('playback checkpoints wait for advancing stable media and flush on pause or page hide', () => {
  assert.match(source, /let candidateAt=performance\.now\(\)/);
  assert.match(source, /now-candidateAt<500/);
  assert.match(source, /now-stableDurationAt<3000/);
  assert.match(source, /growingDuration/);
  assert.match(source, /video\.addEventListener\('playing',onPlaying\)/);
  assert.match(source, /video\.addEventListener\('pause',onPause\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange',onVisibility\)/);
  assert.match(source, /window\.addEventListener\('pagehide',onPageHide\)/);
  assert.match(source, /expectedGeneration!==privacyGeneration\|\|!recordingAllowed\(\)/);
});


test('recording consent is bound to a known active YouTube account', () => {
  const allows = vm.runInNewContext('(' + extractSimpleFunction(source, 'accountConsentAllows') + ')');
  assert.equal(allows(true, '', ''), false);
  assert.equal(allows(true, 'account-a', ''), false);
  assert.equal(allows(true, 'account-a', 'account-b'), false);
  assert.equal(allows(false, 'account-a', 'account-a'), false);
  assert.equal(allows(true, 'account-a', 'account-a'), true);
  assert.match(source, /function accountIdentitySource\(\)/);
  assert.match(source, /DATASYNC_ID/);
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(source, /accountConsentAllows\(db\.settings\.recordPlaybackProgress === true, activeAccountDigest, privacy\.consentAccount\)/);
});

test('YouTube History sync is separate opt-in and account-scoped', () => {
  assert.match(source, /id="yst2-sync-youtube"/);
  assert.match(source, /function syncYouTubeHistory\(force = false\)/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /browseId: 'FEhistory'/);
  assert.match(source, /privacy\.syncAccount === activeAccountDigest/);
  assert.match(source, /YouTube account changed; History sync was stopped/);
  assert.match(source, /clearedProgressAt/);
  assert.match(source, /function historyAccountState\(\)/);
});


test('account History sync runs on library open and periodically while the library remains open', () => {
  assert.match(source, /function openPanel\(\)[^\n]*refreshAccountContext\(\)\.then\(\(\)=>\{if\(syncAllowed\(\)\)syncYouTubeHistory\(false\);\}/);
  assert.match(source, /historySyncLastAt && Date\.now\(\) - historySyncLastAt < 30 \* 1000/);
  assert.match(source, /syncAllowed\(\)&&document\.getElementById\(PANEL\)\?\.classList\.contains\('open'\)/);
});


test('History API parser reads only video renderers and does not invent resume positions', () => {
  const walk = (value, fn) => {
    if (!value || typeof value !== 'object') return;
    fn(value);
    if (Array.isArray(value)) { for (const item of value) walk(item, fn); return; }
    for (const key of Object.keys(value)) walk(value[key], fn);
  };
  const rendererText = value => value?.simpleText || '';
  const parseDuration = value => {
    const parts = String(value || '').split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  const parse = vm.runInNewContext('(' + extractSimpleFunction(source, 'historyApiRows') + ')', {
    walk, rendererText, parseDuration, Map, String, Number
  });
  const result = parse({
    contents: [{ videoRenderer: {
      videoId: 'aaaaaaaaaaa',
      title: {simpleText:'Episode 1'},
      lengthText: {simpleText:'10:00'},
      thumbnailOverlays: [{thumbnailOverlayProgressBarRenderer:{percentDurationWatched:92}}]
    }}],
    continuationContents: {continuations:[{nextContinuationData:{continuation:'next-page'}}]}
  });
  assert.equal(result.rows.get('aaaaaaaaaaa').percent, 92);
  assert.equal(result.rows.get('aaaaaaaaaaa').duration, 600);
  assert.equal(result.rows.get('aaaaaaaaaaa').title, 'Episode 1');
  assert.equal(Object.hasOwn(result.rows.get('aaaaaaaaaaa'), 'position'), false);
  assert.equal(result.continuation, 'next-page');
});


test('History scanning automatically picks up newly loaded rows while scrolling', () => {
  assert.match(source, /function observeHistoryPage\(\)/);
  assert.match(source, /historyObserver\.observe\(root,\{childList:true,subtree:true\}\)/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /scanHistoryPage\(true\)/);
  assert.match(source, /if \(changed\) saveDB\(\)/);
  assert.match(source, /Newly loaded History entries are scanned automatically as you scroll/);
});

test('automatic playback recording is explicitly opt-in by default', () => {
  assert.match(source, /recordPlaybackProgress: false/);
  assert.match(source, /id="yst2-record-progress" \$\{recordingAllowed\(\)\?'checked':''\}/);
});

test('validated native Morphe backups retain bookmark video references', () => {
  const validator = source.slice(source.indexOf('function validateBackupDocument(document)'), source.indexOf('function exportBackup()'));
  assert.ok(validator.includes("const bookmarkVideoId = /^[A-Za-z0-9_-]{11}$/.test"));
  assert.match(validator, /bookmarkVideoId,/);
  assert.match(source, /if \(db\.settings\.enabled === false \|\| !onHistory\)/);
});
