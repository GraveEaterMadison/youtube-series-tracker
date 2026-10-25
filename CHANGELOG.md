# Changelog

## 2.4.0

- Make the player button automatically follow the current playlist and name the series from YouTube playlist metadata.
- If the watch URL has no usable playlist ID, discover candidate playlists from the video's description, the video's own channel Playlists tab, and YouTube search; verify each candidate contains the current video and show a chooser when results are ambiguous.
- Replace page-wide renderer scanning with requested-playlist parsing and bounded, all-or-nothing continuation fetching. Existing saved episodes remain intact if YouTube returns incomplete or unsupported data.
- Infer likely episode order from numbered titles or relative upload-age metadata, preserve original playlist indexes, and display unavailable rows without allowing them to be played or marked watched.
- Store a resume cursor so following a series from a mid-season episode opens at that selected episode; keep cursor and auto-next aligned with YouTube's playlist index.
- Prevent playback from silently adding unrelated videos to a followed playlist and add regression coverage for automatic following and catalog safety.

## 2.3.0

- Refresh the tracker panel with a compact overview dashboard, clearer primary actions, searchable series/episode/history lists, series cover art, progress indicators, and updated empty states.
- Improve small-screen layouts, tab semantics, keyboard focus visibility, reduced-motion support, and accessible button labels.
- Fix the playlist refresh button's series ID interpolation so it targets the selected series.
- Add regression coverage for the refreshed UI and search controls.

## 2.2.2

- Fix auto-next so it stops instead of repeating a watched episode when no unwatched episode remains later in the series.
- Batch playback, playlist-refresh, history-scan, and mark-all updates to reduce repeated synchronous localStorage serialization.
- Add executable regression tests for auto-next ordering, batched writes, and video-listener cleanup.
- Detach the previous episode's playback handlers when YouTube reuses its video element during SPA navigation.

## 2.2.1

- Use a unique default name when a new manual series is created with a blank name, starting with “New Series”.
- Explain in the dialog that the series name is optional.
- Add regression coverage for the default-name behavior.

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
