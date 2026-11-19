# StreamGuard v0.1.0 — Experimental

StreamGuard is now publicly available for community testing.

## Supported source trees

- Vencord (source build)
- Equicord (source build)

## Included

- Automatic protection attempts when the current user's screen share is detected.
- Manual protection toggle and panic hide-all command.
- Temporary reveal controls for recognized private chats.
- Fail-safe warnings and stop-sharing requests where the runtime action is available.

## Important limitations

- This is experimental privacy software. It does not guarantee that private information will be hidden from streams, recordings, or screenshots.
- Notifications are not suppressed automatically. Mute or disable Discord, desktop/system, and other application/plugin notifications manually.
- Blur only affects recognized DOM regions. Discord updates, navigation timing, popouts, search results, overlays, other windows, and other surfaces may expose content.
- Stop-sharing calls are requests, not confirmation that the stream ended. Verify Discord's share controls yourself.
- Build, type, lint, and mock-browser tests are not live-client privacy verification.

Read the [README](README.md), [compatibility audit](COMPATIBILITY.md), and [verification results](TEST_RESULTS.md) before use.

## Feedback

Please report reproducible bugs with your client (Vencord or Equicord), client commit/version, steps to reproduce, and relevant logs. Do not include private messages, account identifiers, tokens, or other sensitive information.
