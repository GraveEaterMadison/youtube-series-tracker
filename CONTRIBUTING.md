# Contributing

Thanks for helping maintain YouTube Series Tracker.

## Before opening an issue

- Check existing issues for duplicates.
- Include Firefox and userscript-manager versions.
- Give a minimal reproduction and distinguish expected from actual behavior.
- Redact account identifiers, cookies, tokens, and private history data.

## Pull requests

1. Keep changes focused and explain user-visible effects.
2. Run npm run check and npm test.
3. Manually test changes that touch YouTube DOM parsing, playback progress, navigation, or storage.
4. Document storage migrations, permissions, and privacy implications.
5. Do not add analytics, remote scripts, or new network calls without explicit discussion and documentation.
6. Update the changelog when behavior or user-facing documentation changes.

## Release workflow

- Verify both CI checks pass on the intended commit.
- Manually test the candidate in Firefox with Violentmonkey on playlist, watch, and history pages.
- Update the userscript version in its metadata and the package/changelog as appropriate.
- Push a version tag such as v0.2.0. The Release workflow creates a GitHub release and attaches youtube-series-tracker.user.js.
- Never describe static checks as end-to-end browser testing.

## Compatibility

YouTube page internals are not a stable public API. Prefer resilient DOM/page-data parsing and defensive fallbacks. Avoid logging personal viewing data.
