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
