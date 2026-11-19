# StreamGuard compatibility audit

> **Experimental privacy software: do not rely on it to keep private information out of a stream or screenshot.** The project author reports that StreamGuard works on both Equicord and Vencord. The build and mock-test results documented here did not independently test a live Discord client and do not prove every selector, blur surface, context menu, stream detection, or stop action. Notifications are **not suppressed** in either repository, despite the setting; disable/mute Discord, desktop/system, other-application, and other-plugin notifications and sounds manually.

## Scope and source layout

| Checkout | Commit inspected | Package manager declared |
| --- | --- | --- |
| Equicord | `d7da0517c84637fa7bb8acb4e2e0f2ebf9069d2f` | `pnpm@12.18.0` |
| Vencord | `e75ac9ace41f6212cfaa2d5f3670830be392da4e` | `pnpm@12.15.0` |

The extracted `streamguard-plugin-main` folder is moved directly into each checkout's `src/userplugins/` directory; the optional helper script replaces the target folder, so back up local edits before using it. No Equicord-only plugin is imported, and there are no Discord webpack code patches in StreamGuard. The code uses platform-provided DOM and JavaScript globals in addition to the imports listed below.

**Validation status:** baseline and final plugin `npx tsc --noEmit`, `pnpm build`, and `pnpm lint` passed in both pinned checkouts; a separate explicit lint of all six plugin/test source files also passed with no warnings or errors. In each checkout the pure logic suite passed **25/25** and the mock Chromium suite passed **9/9**. `StreamGuard` appears in each built renderer bundle. See [TEST_RESULTS.md](TEST_RESULTS.md) for commands, scope, and full test output. The available pnpm was `11.25.0`, which reports a mismatch with the version declared in each repository. Simulated reload and mocked DOM tests are not live Discord tests; the plugin itself starts a fresh state on reload.

## Direct external imports: names, functions, and differences

This table covers **every external module path actually imported by `index.tsx` and `compat.ts`**. The paths below are the source resolutions in these pinned checkouts. Identical declared APIs and successful typechecking are not runtime verification of Discord's lazy-loaded modules.

| Import path and actual names used | Resolution and comparison | Use / caveat |
| --- | --- | --- |
| `@api/Commands`: `ApplicationCommandInputType` | `src/api/Commands/index.ts` re-exports `./types.ts`; the latter re-exports from `@vencord/discord-types/enums`. `index.ts` differs only by Vencord/Equicord bot-message branding and whitespace; `types.ts` and `enums/commands.ts` are identical. | `BUILT_IN = 0` is declared in both. Plugin command objects use `name`, `description`, `inputType`, and `execute`; `Command.execute(args, ctx)` accepts a `Promisable<void \| CommandReturnValue>`. StreamGuard ignores the arguments. Live slash-command registration was not tested. |
| `@api/ContextMenu`: `NavContextMenuPatchCallback` | `src/api/ContextMenu.ts` is byte-identical. | Type is `(children: Array<ReactElement<any> \| null>, ...args: Array<any>) => void`. StreamGuard adds `Menu.MenuItem` to `user-context`, `gdm-context`, and `channel-context` when props identify a private channel. Those keys appear in built-in plugins in both trees; actual runtime props and menu availability remain untested. |
| `@api/Settings`: `definePluginSettings` | `src/api/Settings.ts` differs, but both declare `definePluginSettings<Def extends SettingsDefinition, Checks extends SettingsChecks<Def>, PrivateSettings extends object = {}>(def: Def, checks?: Checks)` and expose the `.store` used here. | Defines the nine settings. Equicord adds settings/theme fields and migration helpers. Notably, the unused `migratePluginSetting` parameter order differs: Equicord `(pluginName, newSetting, oldSetting)` versus Vencord `(pluginName, oldSetting, newSetting)`; StreamGuard does not call it. |
| `@components/Button`: `Button` | `src/components/Button.tsx` is byte-identical. | Shared mod component, not an assertion that it is Discord's own `Button`. Supports the `onClick`, default primary, `size="small"`, and `variant="secondary"` usages here. |
| `@utils/types`: default `definePlugin`, named `OptionType` | `src/utils/types.ts` differs; both expose the same used `definePlugin<P extends PluginDef>(p: P & Record<PropertyKey, any>)` and `OptionType.BOOLEAN`, `SELECT`, `SLIDER`. | Defines the plugin and setting types. Both declare all fields actually used: `name`, `description`, `authors`, `settings`, `contextMenus`, `commands`, `flux`, `start()` and `stop()`. Both also declare optional `dependencies`, but StreamGuard does **not** set it. Differences in other definition fields are detailed below. |
| `@vencord/discord-types`: `Channel` | `packages/discord-types/src/index.d.ts` and its channel declaration. The root declaration is identical; `common/Channel.d.ts` differs by an unused Equicord-only `isObfuscated()` method. | `Channel` is used as a TypeScript type; the code uses `id`, `type`, `parent_id`, `recipients`, `isDM()` and `isGroupDM()` and falls back to channel types 1/3 if the methods throw. These used declarations exist in both. Equicord's linked package is internally named `@equicord/discord-types`, while the root dependency is linked under `@vencord/discord-types`; Vencord uses the workspace package of that name. Both pinned installs resolve the import. |
| `@webpack/common`: `ApplicationStreamingStore`, `ChannelStore`, `SelectedChannelStore`, `UserStore` | Shared `src/webpack/common/index.ts` re-exports `stores.ts`. The barrel is identical; Equicord's store file has additional exports, but the four used names exist in both. Relevant type declarations are compared below. | Tracks selected/private channels, current account and stream snapshots, and subscribes to change listeners. Types describe expected objects, not guaranteed live Discord data or store hydration. |
| `@webpack/common`: `closeModal`, `openModal`, `Modal` | Same barrel; `src/webpack/common/modals.ts` and the relevant `Modal.d.ts` are identical. | `openModal(renderModal, options?, contextKey?) => string`; `closeModal(modalKey, contextKey?) => void`; `Modal` accepts a title and actions with `text`, `variant`, `onClick`. Used for the warning; a failure to open it is caught and the code attempts to keep the chat hidden. Live modal appearance and behavior are untested. |
| `@webpack/common`: `Menu` | Same barrel, identical `src/webpack/common/menu.ts`. | `Menu.MenuItem` is used for reveal/hide menu items; it is populated from Discord at runtime. Identical wrapper code is not proof the runtime component exists or props match. |
| `@webpack/common`: `createRoot` | Same barrel, identical `src/webpack/common/react.ts`. | The shared export is typed as `typeof import("react-dom/client").createRoot` and lazily found in Discord. It mounts the overlay and indicator. |
| `@webpack/common`: `showToast` | Same barrel, `src/webpack/common/utils.ts` differs in other utilities, while the `showToast` declaration and finder used here match. Toast type is `(data: ToastData) => void` in both; the plugin uses `text` and `success` / `critical` variants. | Toast display is attempted and exceptions are logged; a warning can still be missed or unavailable. |
| `@webpack`: `findByCode` | `tsconfig.json` maps `@webpack` directly to `src/webpack/webpack.ts` in both. Those files differ in other filtering/reporter machinery, but both declare `findByCode(...code: CodeFilter)` and use the same finder for this operation. | `compat.ts` checks the result of `findByCode('type:"STREAM_STOP"')` at runtime. The action itself is a Discord runtime detail, **not** an exported, typed stop API in either repo. Equicord's separate `instantScreenshare` uses a similar lazy lookup; StreamGuard neither imports nor depends on it, and no equivalent lookup was found in Vencord's source. |
| `react-dom/client`: `Root` | Type-only import. Both installed `@types/react-dom` copies are `19.2.3`; `client.d.ts` is identical. | Types the roots used with shared `createRoot`, `render`, and `unmount`; it is not a direct runtime React DOM import by this plugin. Runtime `createRoot` is the `@webpack/common` export above. |

The relative imports `./styles.css`, `./compat`, and `./logic` are StreamGuard's own files, not differences between repositories. `styles.css` supplies body/data-attribute-based styles; `index.tsx` injects a per-setting blur rule. `compat.ts` exports `getOwnStreamSnapshot`, `stopOwnStreams`, `beginNotificationSuppression`, and `endNotificationSuppression`. `logic.ts` supplies the imported `Action`, `RevealDuration`, `SafetyMode`, `StreamGuardState`, `createState`, `decideChannel`, `isProtectionActive`, and `transition`. The pure module also has allowlist/restore actions, but the plugin does not offer an allowlist UI or persist that state.

### Source file checksums

SHA-256 prefixes below identify the inspected files; `same` means the full hashes matched. These are source comparisons, not live-client verification. Paths are relative to each checkout.

| File | Equicord | Vencord |
| --- | --- | --- |
| `src/api/Commands/index.ts` | `c2ef48fe0182` | `8b11a63c7e14` |
| `src/api/Commands/types.ts` | `dedb7f003aaf` | same |
| `src/api/ContextMenu.ts` | `070ae7e0ebd5` | same |
| `src/api/Settings.ts` | `41514235d959` | `b440ae162831` |
| `src/components/Button.tsx` | `a71ccbb7f6a8` | same |
| `src/utils/types.ts` | `d711022caec3` | `0911f792e23f` |
| `src/webpack/webpack.ts` | `3d52f0cccf1b` | `e4176cd94777` |
| `src/webpack/index.ts` (barrel, not the `@webpack` alias target) | `af3d2be412f9` | same |
| `src/webpack/common/index.ts` | `360d38414a60` | same |
| `src/webpack/common/stores.ts` | `c95a85482482` | `9ce4bb14b0b7` |
| `src/webpack/common/menu.ts` | `779df56abaa7` | same |
| `src/webpack/common/modals.ts` | `25e8cc06867e` | same |
| `src/webpack/common/react.ts` | `2e2d69077375` | same |
| `src/webpack/common/utils.ts` | `4e296cebb315` | `06fd6486a461` |
| `packages/discord-types/src/index.d.ts` | `a08520aa3478` | same |
| `packages/discord-types/src/common/Channel.d.ts` | `5b84d2e792be` | `9a036619a55b` |
| `packages/discord-types/src/stores/ApplicationStreamingStore.d.ts` | `44b1bb6088f8` | same |
| `packages/discord-types/src/stores/ChannelRTCStore.d.ts` | `30dac3fd872d` | `8afe7a4327b1` |
| `packages/discord-types/src/stores/ChannelStore.d.ts` | `fc0a51ac0b7b` | same |
| `packages/discord-types/src/stores/SelectedChannelStore.d.ts` | `e93cb34139b9` | same |
| `packages/discord-types/src/stores/UserStore.d.ts` | `fddba13005db` | same |
| `packages/discord-types/src/stores/FluxStore.d.ts` | `40f6e7d6784d` | same |
| `packages/discord-types/src/components/Modal.d.ts` | `d42432c58ade` | same |
| `packages/discord-types/src/toasts.d.ts` | `efecab68bcb9` | same |
| `packages/discord-types/enums/commands.ts` | `429d89fe3cd5` | same |
| `node_modules/@types/react-dom/client.d.ts` | `bc03c3c352f6` | same |

## Type and behavioral differences

- **Stream compatibility fields:** `ApplicationStreamingStore.d.ts` is identical. Both define `getStreamingState()` and `getState()` with `activeStreams: [string, Stream][]`, `getActiveStreamForStreamKey(streamKey: string): Stream | null`, and `Stream.ownerId: string`. `getOwnStreamSnapshot()` validates the tuple shape, ownership and key suffix, tries the two accessors, and returns an explicit unavailable status with a warning if the account/store/shape is unavailable. This is an assumption about Discord's runtime, not a verified event/key contract.
- The `Stream` type comes from `ChannelRTCStore.d.ts`, which is **not** byte-identical: Vencord declares `getGuildRingingUsers(channelId): Set<string>`, while Equicord instead adds `getStageAudienceSidebarOpen(channelId): boolean` and `getStageSpeakerParticipants(channelId): Participant[]`. The `Stream.ownerId` field used by this adapter is the same; none of those differing methods is used. Equicord's `Channel` adds `isObfuscated()`; the channel fields/methods StreamGuard uses are shared.
- Both `ChannelStore` declarations have `getChannel(channelId: string): Channel` and `getDMFromUserId(userId: string): string | undefined`; both `SelectedChannelStore` declarations have `getChannelId(guildId?: string | null): string`, both `UserStore` declarations have `getCurrentUser(): User`, and all extend a `FluxStore` declaring `addChangeListener` / `removeChangeListener`. The runtime may still be unavailable or inconsistent.
- **Plugin definition:** Equicord adds `userProfileBadges`, `renderNicknameIcon`, `headerBarButton`, `audioProcessor`, `userAreaButton`, `renderProfileCollection`, `chatBarButtonWrapper`, `renderProfileSection`, and `isModified` fields; StreamGuard uses none. Equicord's `PluginSettingCustomDef` extends `PluginSettingDefCommon`, while Vencord's does not; StreamGuard uses boolean, select, and slider definitions, not custom settings. The names and types of all fields used by this plugin are common to both.
- **Built-in streamer-mode plugin name:** `src/plugins/streamerModeOnStream/index.ts` exists in both, but its `name` is `StreamerModeOn` in Equicord and `StreamerModeOnStream` in Vencord. It toggles Discord streamer mode on own-stream events. StreamGuard is separate and does not depend on either name or plugin.
- **Notifications:** both expose `NotificationSettingsStore` and `StreamerModeStore` declarations with broader settings/getters; neither provides a verified reversible DM-only popup-and-sound control meeting this plugin's requirements. The compatibility layer deliberately makes `beginNotificationSuppression()` warn and return `false`, changes no Discord or DataStore settings, and makes `endNotificationSuppression()` a no-op. This behavior is the same in both, including across a reload; there is no restoration of notification settings because none were changed. The default-on setting is therefore **unavailable**, not working suppression.
- **Stop requests:** the adapter checks a found action is callable, restricts keys to the current-account suffix, rejects conflicting known owners, catches synchronous failures, and treats promise-like returns as unconfirmed. It warns the user to stop manually when it cannot confirm calls. A synchronous successful return is only a request; the controller waits for disappearance of the tracked stream and warns after five seconds if it is still present. No stop action or stream end was tested in live Discord, and it can fail to stop a share.
- **Fail-safe and hydration:** on an animation frame the controller checks the active body marker, a CSS probe's blur/user-select, and presence of recognized chat/list containers where relevant. Failure latches concealment and requests stops only for known streams. It does not check every actual sensitive element or capture output. A valid-looking empty but not-yet-hydrated store may still be mistaken for no stream. An unreadable snapshot latches fail-safe and warns, but no code can guarantee against a race between stream startup and attaching blur. Runtime checks are targeted fallbacks, not a blanket guarantee that any missing API cannot break startup.
- **Sidebar and other surfaces:** the code intentionally never sets the DM list's ready attribute, so the whole sidebar remains blurred even when a chat is revealed; the requested visible sidebar entry for revealed chats is not met. Search/jump results, popouts, pinned messages, threads, calls, notifications/system toasts, screenshots, and streams may expose content. The author's report that it works on both clients does not guarantee complete coverage, blur legibility, or capture privacy. The preview is an idealized mockup and is not exact product behavior.

See [README.md](README.md) for all settings, commands, reset rules, and the manual-only one-hour reveal fallback.
