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
  assert.match(source, /^\/\/ @license\s+MIT$/m);
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
  assert.match(source, /^\/\/ @version\s+2\.4\.0$/m);
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
  const watched = new Set(['current', 'later-watched', 'last-watched']);
  const chooseNext = vm.runInNewContext(`(${extractSimpleFunction(source, 'chooseNext')})`, {
    stateFor: id => ({ watched: watched.has(id) }),
    chooseContinue: () => ({ id: 'continue-fallback' })
  });
  const series = { episodes: [
    { id: 'current', order: 0 },
    { id: 'later-watched', order: 1 },
    { id: 'last-watched', order: 2 }
  ] };
  assert.equal(chooseNext(series, 'current'), null);
});

test('auto-next selects the next unwatched episode in playlist order', () => {
  const watched = new Set(['current', 'watched-middle']);
  const chooseNext = vm.runInNewContext(`(${extractSimpleFunction(source, 'chooseNext')})`, {
    stateFor: id => ({ watched: watched.has(id) }),
    chooseContinue: () => null
  });
  const series = { episodes: [
    { id: 'current', order: 0 },
    { id: 'watched-middle', order: 1 },
    { id: 'next-unwatched', order: 2 }
  ] };
  assert.equal(chooseNext(series, 'current').id, 'next-unwatched');
});

test('playlist refresh and history scan can batch state changes into one write', () => {
  const setState = extractSimpleFunction(source, 'setState');
  const mergeSeries = extractSimpleFunction(source, 'mergeSeries');
  const historyScan = extractSimpleFunction(source, 'scanHistoryPage');
  assert.match(setState, /persist = true/);
  assert.match(mergeSeries, /setState\(ep\.id,\s*\{[^}]+\},\s*false\)/);
  assert.match(historyScan, /setState\(id,\s*\{watched:true\},\s*false\)/);
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

test('library UI includes search, progress overview, artwork, accessible tabs, and responsive polish', () => {
  assert.match(source, /id="yst2-search"/);
  assert.match(source, /id="yst2-dashboard"/);
  assert.match(source, /class="yst2-series-art"/);
  assert.match(source, /aria-selected=/);
  assert.ok(source.includes('data-sync="${esc(s.id)}"'));
  assert.match(source, /const applySearch = \(\)/);
  assert.match(source, /prefers-reduced-motion:reduce/);
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
  assert.match(track, /const inListedSeries=Boolean\(listSeries && listSeries\.episodes\.some/);
  assert.doesNotMatch(track, /s\.episodes\.push\(\{id:meta\.id/);
});
