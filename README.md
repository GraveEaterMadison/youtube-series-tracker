# YouTube Series Tracker

[![CI](https://github.com/GraveEaterMadison/youtube-series-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/GraveEaterMadison/youtube-series-tracker/actions/workflows/ci.yml)

**Install:** [YouTube Series Tracker on Greasy Fork](https://greasyfork.org/en/scripts/601970-youtube-series-tracker) · [Raw userscript source](https://raw.githubusercontent.com/GraveEaterMadison/youtube-series-tracker/main/youtube-series-tracker.user.js)

A local-first Firefox userscript for tracking YouTube playlists as series: episode progress, a series library, continue-watching, history matching, and backup/restore.

> **Project status: beta.** Static checks and automated tests do not replace live testing in Firefox. YouTube's internal page structures can change without notice.

## Features

- Open the tracker from a player-top button or the YouTube sidebar/floating entry point.
- Create a local series library from YouTube playlists.
- Track playback positions and watched episodes.
- Configure the auto-mark-watched threshold.
- Optional auto-next navigation.
- Refresh playlists and manually toggle watched status.
- View continue-watching and matching entries from YouTube history.
- Export and import a backup of tracker data.
- Store tracker data locally, without a project backend or telemetry.

## Install in Firefox

1. Install [Violentmonkey](https://violentmonkey.github.io/) or another compatible userscript manager.
2. Open the [userscript source](https://raw.githubusercontent.com/GraveEaterMadison/youtube-series-tracker/main/youtube-series-tracker.user.js).
3. Create a new userscript in your manager, paste the source, and save it. If your manager offers to install the raw script directly, review the permissions and confirm.
4. Reload YouTube. Open a playlist or video and look for the **Series** button/panel.

The script currently declares only @grant none and matches https://www.youtube.com/*. Review the source before installing any userscript.

## How it stores data

Tracker data is stored in the browser's localStorage for YouTube. It is not synced to the Morphe Android app or Google's watch history. Clearing YouTube site data, using a separate browser profile, or switching browsers may make the data unavailable. Export a backup before cleaning site data.

## Known limitations

- YouTube's page data and internal endpoints are not stable public APIs; playlist extraction can break after site updates.
- History matching depends on history entries currently rendered by YouTube. Scroll to load more entries and rescan if needed.
- Automatic next-episode behavior and playback progress need manual Firefox testing.
- Automated tests validate syntax, metadata, and basic source invariants; they are not browser end-to-end tests.
- No live Firefox/YouTube end-to-end test is claimed by this repository's CI.

## Development

Requires Node.js 20 or newer. There are no runtime npm dependencies.

    npm test
    npm run check

GitHub Actions runs these commands on pushes and pull requests. See CONTRIBUTING.md before proposing changes, and SECURITY.md for privacy/security reporting.

## Roadmap

- Add more meaningful unit tests around playlist parsing and progress calculations.
- Test the current YouTube UI in Firefox + Violentmonkey across playlist, watch, and history pages.
- Improve compatibility handling when YouTube changes its page internals.

## Relationship to other projects

This is an independent, unofficial project inspired by the general idea of series tracking. It is not affiliated with Morphe, YouTube, Google, or Violentmonkey and does not include Morphe source code.

## License

MIT. See LICENSE.

