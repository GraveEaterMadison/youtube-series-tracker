# Contributing

Thanks for helping maintain YouTube Series Tracker.

## Before opening an issue

- Check existing issues for duplicates.
- Include Firefox and userscript-manager versions.
- Give a minimal reproduction and distinguish expected from actual behavior.
- Redact account identifiers, cookies, tokens, and private history data.

## Pull requests

1. Keep changes focused and explain user-visible effects.
2. Run `npm run check` and `npm test`.
3. Manually test changes that touch YouTube DOM parsing, playback progress, navigation, or storage.
4. Document storage migrations, permissions, and privacy implications.
5. Do not add analytics, remote scripts, or new network calls without explicit discussion and documentation.

## Compatibility

YouTube page internals are not a stable public API. Prefer resilient DOM/page-data parsing and defensive fallbacks. Avoid logging personal viewing data.
