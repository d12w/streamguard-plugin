# StreamGuard

**Experimental privacy plugin for Vencord and Equicord.**

StreamGuard attempts to blur recognized private-chat areas while your own screen share is active, or when you enable protection manually. You can temporarily reveal supported chats when needed.

> **Important:** StreamGuard is not a privacy guarantee. Discord's interface can change, and content may appear before protection activates or in areas the plugin does not recognize. Never rely on it as your only protection when sharing private information.

> **Notifications are not muted.** The notification setting only reminds you to mute them yourself. Disable Discord popups and sounds, operating-system notifications, and notifications from other apps or plugins before sharing.

![StreamGuard interface mockup](docs/preview.png)

*The image is a static mockup, not a screenshot of the live plugin.*

## Install

StreamGuard requires a **Vencord or Equicord source build**.

### Already have a source build?

1. [Download the ZIP](https://github.com/d12w/streamguard-plugin/archive/refs/heads/main.zip) and extract it.
2. Move the entire `streamguard-plugin-main` folder into your client's `src/userplugins` directory. Do not copy the files individually.
3. From the Vencord or Equicord source folder, run:

   ```sh
   pnpm build
   ```

4. Fully restart Discord and enable StreamGuard in Plugins.

Run `pnpm inject` only if that source build has not been injected into Discord yet.

### Building from source for the first time

Install [Git](https://git-scm.com/), [Node.js LTS](https://nodejs.org/), and [pnpm](https://pnpm.io/installation).

Clone **one** client:

**Vencord**
```sh
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
```

**Equicord**
```sh
git clone https://github.com/Equicord/Equicord.git
cd Equicord
```

Move the extracted `streamguard-plugin-main` folder into `src/userplugins`, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

For a source-build walkthrough, see [this video](https://www.youtube.com/watch?v=XmVNRKrphlw). The Equicord commands above use the Equicord repository.

## Use

- `/streamguard` toggles manual protection. Automatic protection can activate when your own screen share is detected.
- Right-click a supported DM or group DM and choose **Reveal chat** or **Hide chat**.
- `/streamguard-panic` hides all revealed chats and ensures protection is active.
- The floating indicator shows the protection state and provides a **Hide all again** control.

Revealing a chat is temporary. **The entire DM sidebar remains blurred**, including the row for a revealed chat.

## Important limitations

- Blur affects only recognized parts of Discord's interface. Startup and navigation races can expose content before blur is applied.
- Search results, popouts, pinned messages, threads, notifications, overlays, other windows, and other apps may expose private content.
- The stop-sharing option can only request that Discord stop a stream; it cannot guarantee that the stream ended. Check Discord's share controls yourself.
- The **Suppress notifications while sharing** setting does not suppress notifications or sounds.
- Build and mock-browser tests do not verify privacy during a real Discord screen share.

StreamGuard makes no plugin network requests and sends no telemetry. For detailed compatibility notes and test scope, see [COMPATIBILITY.md](COMPATIBILITY.md) and [TEST_RESULTS.md](TEST_RESULTS.md).

## License

[GPL-3.0-or-later](LICENSE). StreamGuard is independent and is not affiliated with Discord, Vencord, or Equicord.
