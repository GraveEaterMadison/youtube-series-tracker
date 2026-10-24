# Changelog

## 2.2.0

- Add the current YouTube video to an existing series with an explicit selector.
- Create a new manual series from the current video, then add other videos one at a time.
- Preserve manually-added episodes across playlist refreshes and distinguish manual series from playlist-synced series.
- Add regression checks for the one-by-one series workflow.

## 2.1.0

- Add a Series Tracker button to the YouTube desktop player's top controls as well as the existing sidebar/floating entry.
- Retry player-button insertion as YouTube replaces player controls during single-page navigation.
- Correct the injected player-button CSS and add regression checks.
- Ensure the sidebar button relocates into YouTube navigation if that UI loads after the userscript.
- Add Greasy Fork metadata and publish/update documentation.

## 2.0.1

- Prepare the userscript metadata for Greasy Fork publication.
- Add MIT license, homepage, support URL, and Firefox compatibility metadata.
- Align package and userscript versions.

## 2.0.0

- Playlist-based series library with playlist synchronization, episode progress, history matching, continue watching, and optional auto-next.
- Local browser storage with backup/restore tools.
- Add syntax checks, metadata/privacy smoke tests, and GitHub Actions workflows.
