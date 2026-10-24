const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'youtube-series-tracker.user.js'), 'utf8');

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
  assert.match(source, /^\/\/ @version\s+2\.2\.1$/m);
  assert.match(source, /id="yst2-add-current"/);
  assert.match(source, /function showAddVideoDialog\(\)/);
  assert.match(source, /function saveVideoToSeries\(series, meta\)/);
  assert.match(source, /function createManualSeries\(title, meta\)/);
  assert.match(source, /manuallyAdded: true/);
  assert.match(source, /unavailable: ep\.manuallyAdded \? false : true/);
});

test('blank series names receive a unique default name', () => {
  assert.match(source, /function defaultManualSeriesName\\(\\)/);
  assert.match(source, /String\\(title \\|\\| ''\\)\\.trim\\(\\) \\|\\| defaultManualSeriesName\\(\\)/);
  assert.match(source, /placeholder="Optional — defaults to New Series"/);
  assert.doesNotMatch(source, /Enter a name for the new series/);
  assert.ok(source.includes("while (names.has(('New Series ' + suffix).toLocaleLowerCase())) suffix++;"));
});

test('player button prioritizes adding the current video and keeps a playlist-sync option', () => {
  const fromPlayer = source.slice(source.indexOf('function openFromPlayer()'), source.indexOf('function ensureUI()'));
  assert.ok(fromPlayer.indexOf('if (videoId)') < fromPlayer.indexOf('if (listId)'));
  assert.match(source, /id="yst2-dialog-sync-playlist"/);
  assert.match(source, /Sync the entire current playlist instead/);
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
