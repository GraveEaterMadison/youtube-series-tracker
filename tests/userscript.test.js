const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'youtube-series-tracker.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

test('userscript metadata targets YouTube and requests no privileged grants', () => {
  assert.match(source, /^\/\/ ==UserScript==/);
  assert.match(source, /^\/\/ @name\s+.+$/m);
  assert.match(source, /^\/\/ @match\s+https:\/\/www\.youtube\.com\/\*$/m);
  assert.match(source, /^\/\/ @grant\s+none$/m);
  assert.match(source, /^\/\/ ==\/UserScript==/m);
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
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /beta/i);
  assert.match(readme, /localStorage/i);
  assert.match(readme, /end-to-end tests/i);
});
