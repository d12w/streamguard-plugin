# StreamGuard verification results

Recorded 2026-11-19 in a Linux sandbox using Node `v22.23.4` and pnpm `11.25.0`. Both repositories emitted pnpm version-mismatch warnings: the tested Equicord commit declares `12.18.0` and the tested Vencord commit declares `12.15.0`. These were package-manager warnings, not plugin lint findings.

| Check | Equicord `d7da0517c84637fa7bb8acb4e2e0f2ebf9069d2f` | Vencord `e75ac9ace41f6212cfaa2d5f3670830be392da4e` |
| --- | --- | --- |
| Unmodified baseline `pnpm install --frozen-lockfile` | Pass | Pass |
| Unmodified baseline `npx tsc --noEmit`, `pnpm build`, `pnpm lint` | Pass | Pass |
| Final source `npx tsc --noEmit` | Pass | Pass |
| Final source `pnpm build` | Pass | Pass |
| Final source `pnpm lint` | Pass, 0 warnings/errors | Pass, 0 warnings/errors |
| Explicit plugin and test-source lint with `--no-ignore --deny-warnings` | Pass, 0 warnings/errors on 6 files | Pass, 0 warnings/errors on 6 files |
| `node --test .../logic.test.cjs` | 25 passed, 0 failed | 25 passed, 0 failed |
| Chromium tests using mocked Discord APIs and DOM | 9 passed, 0 failed | 9 passed, 0 failed |
| Renderer bundle contains `StreamGuard` | `dist/desktop/renderer.js`, `dist/equibop/renderer.js` | `dist/renderer.js` |

The repo-wide lint commands ignore `src/userplugins`, so they do not alone verify the plugin. The additional explicit file lint above used each project's own oxlint configuration and included the test helper files. There are no Discord webpack patches in this plugin, so `lint:patches` was not required by the request.

## Test output

The exact TAP output is available for [Equicord's logic tests](tests/results/equicord-logic.tap.txt), [Vencord's logic tests](tests/results/vencord-logic.tap.txt), [Equicord's mocked browser tests](tests/results/equicord-mock-browser.tap.txt), and [Vencord's mocked browser tests](tests/results/vencord-mock-browser.tap.txt). Summary output from each checkout:

```text
Pure logic:
# tests 25
# pass 25
# fail 0
# skipped 0

Mocked browser:
# tests 9
# pass 9
# fail 0
# skipped 0
```

The pure tests exercise stream transitions, timed expiry, multiple streams, account changes, simulated reload, fail-safe and the three decisions. The browser tests run the actual plugin against synthetic HTML and mocked stores, Flux, modal, menu, rendering and stop actions. They do not use Discord, real React reconciliation, a stream or screen capture. The static preview was rendered in Chromium and checked at multiple viewport sizes without console/page errors or external requests; it is explicitly an approximation. Separately, the project author reports that StreamGuard works in both Equicord and Vencord; that report is not a result of the sandbox test runs above.

The same source was copied into both checkouts with a copy script, without editing its code. The plugin source does not import any Equicord-only plugin. Project builds and tests do **not** prove privacy, actual runtime compatibility, notification suppression, stream termination or that sensitive surfaces are hidden in a live client. Read the warnings in [README.md](README.md) before any use.
