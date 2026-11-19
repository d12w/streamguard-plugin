/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ApplicationStreamingStore, ChannelStore, closeModal, createRoot, Menu, Modal, openModal, SelectedChannelStore, showToast, UserStore } from "@webpack/common";
import type { Root } from "react-dom/client";

import { beginNotificationSuppression, endNotificationSuppression, getOwnStreamSnapshot, stopOwnStreams } from "./compat";
import { Action, createState, decideChannel, isProtectionActive, RevealDuration, SafetyMode, StreamGuardState, transition } from "./logic";

const settings = definePluginSettings({
    autoEnable: {
        type: OptionType.BOOLEAN,
        description: "Automatically protect private chats while you share your screen.",
        default: true,
        onChange: settingsChanged
    },
    blurStrength: {
        type: OptionType.SLIDER,
        description: "Strength of the privacy blur, in pixels. Stronger blur hides text more thoroughly.",
        markers: [14, 18, 22, 26, 30],
        default: 18,
        stickToMarkers: true,
        onChange: settingsChanged
    },
    blurServers: {
        type: OptionType.BOOLEAN,
        description: "Also blur the server list while protection is active.",
        default: false,
        onChange: settingsChanged
    },
    revealDuration: {
        type: OptionType.SELECT,
        description: "How long a temporary chat reveal lasts.",
        options: [
            { label: "Until the stream ends", value: "until-streams-stop", default: true },
            { label: "5 minutes", value: "5m" },
            { label: "15 minutes", value: "15m" },
            { label: "1 hour", value: "1h" }
        ]
    },
    allowTyping: {
        type: OptionType.BOOLEAN,
        description: "Allow typing in a hidden chat. The chat remains blurred.",
        default: false,
        onChange: settingsChanged
    },
    safetyMode: {
        type: OptionType.SELECT,
        description: "When opening a revealed chat during a share.",
        options: [
            { label: "Do nothing", value: "nothing" },
            { label: "Warn me", value: "warn", default: true },
            { label: "Stop sharing automatically", value: "stop" }
        ],
        onChange: settingsChanged
    },
    failSafe: {
        type: OptionType.BOOLEAN,
        description: "Stop sharing if the privacy stylesheet or selected chat cannot be protected.",
        default: true,
        onChange: settingsChanged
    },
    suppressNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show a reminder to mute notifications manually; StreamGuard cannot suppress them automatically.",
        default: true,
        onChange: settingsChanged
    },
    showIndicator: {
        type: OptionType.BOOLEAN,
        description: "Show a small floating protection indicator with a hide-all button.",
        default: true,
        onChange: settingsChanged
    }
});

let state: StreamGuardState | undefined;
let running = false;
let observer: MutationObserver | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let overlayHost: HTMLElement | undefined;
let overlayRoot: Root | undefined;
let pillHost: HTMLElement | undefined;
let pillRoot: Root | undefined;
let strengthStyle: HTMLStyleElement | undefined;
let selectedId: string | undefined;
let approvedToken: string | undefined;
let warnedToken: string | undefined;
let warningModal: string | undefined;
let stopRequested = "";
let stopConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
let notificationQueue: Promise<void> = Promise.resolve();
let notificationsWanted: boolean | undefined;
let notificationWarningShown = false;
let scanQueued = false;
let failSafePending = false;
const touched = new Set<HTMLElement>();
const typingOverrides = new Map<HTMLElement, { value: string; priority: string; }>();
const revealedRecipients = new Map<string, string>();
const clockWallStart = Date.now();
const clockMonotonicStart = performance.now();

function now() {
    return Math.max(Date.now(), Math.floor(clockWallStart + performance.now() - clockMonotonicStart), state?.lastNow ?? 0);
}

function toast(text: string, critical = false) {
    try {
        showToast({ text, variant: critical ? "critical" : "success" });
    } catch (error) {
        console.warn("[StreamGuard]", text, error);
    }
}

function mode(): SafetyMode {
    const value = settings.store.safetyMode;
    return value === "nothing" || value === "stop" ? value : "warn";
}

function duration(): RevealDuration {
    const value = settings.store.revealDuration;
    if (value === "5m" || value === "15m" || value === "1h") return value;
    // An open-ended reveal needs a stream to end. Manual-only mode uses one hour.
    return state?.activeStreamIds.length ? "until-streams-stop" : "1h";
}

function currentUserId(): string {
    try {
        return UserStore.getCurrentUser()?.id || "unknown-account";
    } catch {
        return "unknown-account";
    }
}

function isPrivate(channel: Channel | undefined): boolean {
    if (!channel) return false;
    try {
        return channel.isDM() || channel.isGroupDM();
    } catch {
        return channel.type === 1 || channel.type === 3;
    }
}

function privateChannelId(id: string | undefined): string | undefined {
    if (!id) return undefined;
    try {
        const channel = ChannelStore?.getChannel(id);
        if (isPrivate(channel)) return id;
        if (channel?.parent_id && isPrivate(ChannelStore.getChannel(channel.parent_id))) return channel.parent_id;
    } catch (error) {
        console.warn("[StreamGuard] Could not identify a private channel.", error);
    }
    return undefined;
}

function recipientsFor(id: string): string | undefined {
    try {
        const channel = ChannelStore?.getChannel(id);
        if (!isPrivate(channel) || !Array.isArray(channel.recipients)) return undefined;
        return [...channel.recipients].sort().join(":");
    } catch {
        return undefined;
    }
}

function getSelectedPrivateId(): string | undefined {
    // The URL prevents a stale selected channel from revealing another route.
    const path = location.pathname.match(/^\/channels\/@me\/(\d+)/);
    if (path) return privateChannelId(path[1]) ?? path[1];
    if (location.pathname.startsWith("/channels/@me")) return undefined;
    try {
        return privateChannelId(SelectedChannelStore.getChannelId());
    } catch {
        return undefined;
    }
}

function update(action: Action) {
    if (!running || !state) return;
    const wasActive = isProtectionActive(state);
    state = transition(state, action, now());
    if (wasActive && !isProtectionActive(state)) {
        for (const reveal of state.reveals) state = transition(state, { type: "remove-reveal", channelId: reveal.channelId }, now());
    }
    refresh();
}

function settingsChanged() {
    // Settings callbacks can run before the underlying setting is committed.
    queueMicrotask(() => {
        if (!running || !state) return;
        const wasActive = isProtectionActive(state);
        state = transition(state, { type: "set-automatic", enabled: settings.store.autoEnable }, now());
        state = transition(state, { type: "set-safety-mode", mode: mode() }, now());
        if (wasActive && !isProtectionActive(state)) {
            for (const reveal of state.reveals) state = transition(state, { type: "remove-reveal", channelId: reveal.channelId }, now());
        }
        refresh();
    });
}

function syncNotifications(wanted: boolean) {
    if (notificationsWanted === wanted) return;
    notificationsWanted = wanted;
    notificationQueue = notificationQueue.then(async () => {
        if (wanted) {
            const ok = await beginNotificationSuppression();
            if (!ok && !notificationWarningShown) {
                notificationWarningShown = true;
                toast("StreamGuard could not suppress notifications. Disable them manually before sharing.", true);
            }
        } else {
            await endNotificationSuppression();
        }
    }).catch(error => {
        console.warn("[StreamGuard] Notification suppression or restoration failed.", error);
        toast("StreamGuard could not change notifications. Check your notification settings manually.", true);
    });
}

function mark(element: HTMLElement, name: string, value: string) {
    const attribute = `data-vc-streamguard-${name}`;
    if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    touched.add(element);
}

function restoreTyping() {
    for (const [element, old] of typingOverrides) {
        if (old.value) element.style.setProperty("pointer-events", old.value, old.priority);
        else element.style.removeProperty("pointer-events");
    }
    typingOverrides.clear();
}

// Discord's hashed class names can change. Keep all heuristic selectors here;
// these are not a verified or complete list of Discord client surfaces.
const SELECTORS = {
    dmList: '[class^="privateChannels_"], [class*=" privateChannels_"]',
    chat: '[class^="chat_"], [class*=" chat_"]',
    composer: '[class^="channelTextArea_"], [class*=" channelTextArea_"]',
    friends: '[class^="peopleColumn_"], [class*=" peopleColumn_"]',
    activeNow: '[class^="nowPlayingColumn_"], [class*=" nowPlayingColumn_"]',
    members: '[class^="membersWrap_"], [class*=" membersWrap_"]',
    servers: '[class^="guilds_"], [class*=" guilds_"]'
} as const;

function findSection(selector: string): HTMLElement | undefined {
    return document.querySelector<HTMLElement>(selector) ?? undefined;
}

function clearMarks() {
    for (const element of touched) {
        element.removeAttribute("data-vc-streamguard-scope");
        element.removeAttribute("data-vc-streamguard-chat");
        element.removeAttribute("data-vc-streamguard-ready");
    }
    touched.clear();
}

function isRevealed(id: string): boolean {
    if (!state || state.panic || state.failSafe) return false;
    return state.allowlist.includes(id) || state.reveals.some(reveal => reveal.channelId === id && (reveal.kind !== "timed" || now() < reveal.expiresAt));
}

function markSections(active: boolean, hidden: boolean): HTMLElement | undefined {
    restoreTyping();
    clearMarks();
    if (!active) return undefined;
    const dmList = findSection(SELECTORS.dmList);
    if (dmList) {
        mark(dmList, "scope", "dm-list");
        const candidates = dmList.querySelectorAll<HTMLElement>('[data-list-item-id^="privateChannels___"], a[href^="/channels/@me/"]');
        for (const candidate of candidates) {
            const listId = candidate.getAttribute("data-list-item-id")?.match(/^privateChannels___(\d+)$/)?.[1];
            const hrefId = candidate.getAttribute("href")?.match(/^\/channels\/@me\/(\d+)/)?.[1];
            const id = listId ?? hrefId;
            if (!id || !privateChannelId(id)) continue;
            const row = candidate.closest<HTMLElement>('[data-list-item-id^="privateChannels___"]') ?? candidate;
            mark(row, "chat", isRevealed(id) ? "revealed" : "hidden");
        }
        // Some matching rows do not prove all virtualized rows are classified.
        // Leave ready unset so the entire private sidebar stays blurred.
    }
    for (const [key, scope] of [["friends", "friends"], ["activeNow", "active-now"], ["servers", "servers"]] as const) {
        const section = findSection(SELECTORS[key]);
        if (section) mark(section, "scope", scope);
    }
    if (!selectedId) return undefined;
    const chat = findSection(SELECTORS.chat);
    if (!chat) return undefined;
    mark(chat, "scope", "chat");
    const members = chat.querySelector<HTMLElement>(SELECTORS.members);
    if (members) mark(members, "scope", "dm-members");
    const composer = chat.querySelector<HTMLElement>(SELECTORS.composer);
    if (composer) {
        if (!settings.store.allowTyping) mark(composer, "scope", "composer");
        else if (hidden) {
            // Override inherited pointer suppression only on the composer itself.
            typingOverrides.set(composer, { value: composer.style.getPropertyValue("pointer-events"), priority: composer.style.getPropertyPriority("pointer-events") });
            composer.style.setProperty("pointer-events", "auto", "important");
        }
    }
    return chat;
}

function applyStrength() {
    if (!strengthStyle) return;
    const value = Number(settings.store.blurStrength);
    const px = Number.isFinite(value) ? Math.max(14, Math.min(30, value)) : 18;
    strengthStyle.textContent = `
body[data-vc-streamguard-active="true"] [data-vc-streamguard-scope="dm-list"]:not([data-vc-streamguard-ready="true"]),
body[data-vc-streamguard-active="true"] [data-vc-streamguard-scope="dm-list"] [data-vc-streamguard-chat]:not([data-vc-streamguard-chat="revealed"]),
body[data-vc-streamguard-active="true"] [data-vc-streamguard-scope="friends"],
body[data-vc-streamguard-active="true"] [data-vc-streamguard-scope="active-now"],
body[data-vc-streamguard-active="true"][data-vc-streamguard-servers="true"] [data-vc-streamguard-scope="servers"],
body[data-vc-streamguard-active="true"][data-vc-streamguard-hidden="true"] [data-vc-streamguard-scope="dm-members"],
body[data-vc-streamguard-active="true"][data-vc-streamguard-hidden="true"] [data-vc-streamguard-scope="chat"] > :not(.vc-streamguard-overlay):not(.vc-streamguard-pill) { filter: blur(${px}px) !important; }`;
}

function removeOverlay() {
    overlayRoot?.unmount();
    overlayRoot = undefined;
    overlayHost?.remove();
    overlayHost = undefined;
}

function renderOverlay(chat: HTMLElement | undefined, hidden: boolean) {
    if (!chat || !hidden || !selectedId) {
        if (overlayHost) removeOverlay();
        return;
    }
    if (overlayHost?.parentElement !== chat) {
        if (overlayHost) removeOverlay();
        overlayHost = document.createElement("div");
        overlayHost.className = "vc-streamguard-overlay";
        chat.appendChild(overlayHost);
        overlayRoot = createRoot(overlayHost);
    }
    overlayHost!.style.pointerEvents = settings.store.allowTyping ? "none" : "auto";
    const id = selectedId;
    overlayRoot?.render(
        <div className="vc-streamguard-overlay-card" style={{ pointerEvents: "auto" }}>
            <span className="vc-streamguard-overlay-icon" aria-hidden="true">&#128274;</span>
            <p className="vc-streamguard-overlay-title">Hidden from viewers</p>
            {!settings.store.allowTyping && <p className="vc-streamguard-composer-hint">Typing is disabled while this chat is hidden.</p>}
            <div className="vc-streamguard-overlay-actions">
                <Button onClick={() => revealChat(id)}>Reveal chat</Button>
            </div>
        </div>
    );
}

function renderPill(active: boolean) {
    if (!active || !settings.store.showIndicator) {
        if (pillRoot) pillRoot.unmount();
        pillRoot = undefined;
        pillHost?.remove();
        pillHost = undefined;
        return;
    }
    if (!pillHost) {
        pillHost = document.createElement("div");
        pillHost.className = "vc-streamguard-pill";
        Object.assign(pillHost.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "10000" });
        document.body.appendChild(pillHost);
        pillRoot = createRoot(pillHost);
    }
    const count = state?.reveals.filter(reveal => isRevealed(reveal.channelId)).length ?? 0;
    pillRoot?.render(<><span>StreamGuard active, {count} revealed</span><Button size="small" variant="secondary" onClick={hideAll}>Hide all again</Button></>);
}

function closeWarning() {
    if (warningModal) {
        try { closeModal(warningModal); } catch (error) { console.warn("[StreamGuard] Could not close warning.", error); }
    }
    warningModal = undefined;
}

function showWarning(id: string, token: string) {
    if (warnedToken === token) return;
    warnedToken = token;
    closeWarning();
    try {
        warningModal = openModal(props => <Modal {...props} title="Viewers will see this chat." actions={[
            { text: "Continue", variant: "primary", onClick: () => {
                if (!state || selectedId !== id) return;
                const decision = decideChannel(state, id, now(), token);
                if (!decision.blocked && !decision.conceal) approvedToken = token;
                warningModal = undefined;
                props.onClose();
                refresh();
            } },
            { text: "Hide chat", variant: "secondary", onClick: () => {
                warningModal = undefined;
                props.onClose();
                hideChat(id);
            } },
            { text: "Stop sharing", variant: "critical-primary", onClick: () => {
                warningModal = undefined;
                props.onClose();
                stopSharing();
            } }
        ]} />);
    } catch (error) {
        console.warn("[StreamGuard] Could not open the warning; keeping chat hidden.", error);
        toast("StreamGuard could not show the warning. This chat remains hidden.", true);
    }
}

function stopSharing() {
    if (!state || state.activeStreamIds.length === 0) return;
    const keys = [...state.activeStreamIds];
    let stopped = false;
    try { stopped = stopOwnStreams(keys); } catch (error) { console.warn("[StreamGuard] Stop-sharing action failed.", error); }
    if (!stopped) {
        state = transition(state, { type: "fail-safe" }, now());
        toast("StreamGuard could not stop sharing. Stop sharing manually; chats remain hidden.", true);
        refresh();
    } else {
        // Do not unlock on a successful call; wait for the actual STREAM_DELETE.
        toast("StreamGuard requested that sharing stop. Confirm that it has ended in Discord.");
        if (stopConfirmationTimer) clearTimeout(stopConfirmationTimer);
        stopConfirmationTimer = setTimeout(() => {
            stopConfirmationTimer = undefined;
            if (!running || !state || !keys.some(key => state?.activeStreamIds.includes(key))) return;
            state = transition(state, { type: "fail-safe" }, now());
            toast("StreamGuard could not confirm that sharing ended. Stop sharing manually and check Discord.", true);
            refresh();
        }, 5000);
    }
}

function checkProtection() {
    if (!running || !state || state.failSafe || !isProtectionActive(state) || !settings.store.failSafe || failSafePending) return;
    failSafePending = true;
    requestAnimationFrame(() => {
        failSafePending = false;
        if (!running || !state || state.failSafe || !isProtectionActive(state) || !settings.store.failSafe) return;
        const probe = document.createElement("div");
        probe.setAttribute("data-vc-streamguard-probe", "true");
        probe.setAttribute("data-vc-streamguard-scope", "friends");
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const protectedByCss = document.body.getAttribute("data-vc-streamguard-active") === "true" && style.filter.includes("blur(") && style.userSelect === "none";
        probe.remove();
        const chatMissing = !!selectedId && !findSection(SELECTORS.chat);
        const privateListMissing = location.pathname.startsWith("/channels/@me") && !findSection(SELECTORS.dmList);
        if (!protectedByCss || chatMissing || privateListMissing) {
            state = transition(state, { type: "fail-safe" }, now());
            toast("StreamGuard could not verify the privacy layer. Stop sharing manually if necessary.", true);
            stopSharing();
            refresh();
        }
    });
}

function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!state) return;
    const times = state.reveals.flatMap(reveal => reveal.kind === "timed" ? [reveal.expiresAt] : []);
    if (!times.length) return;
    const wait = Math.max(0, Math.min(...times) - now());
    expiryTimer = setTimeout(() => update({ type: "tick" }), Math.min(wait, 2147483647));
}

function refresh() {
    if (!running || !state || !document.body) return;
    const accountId = currentUserId();
    if (accountId !== state.accountId) {
        approvedToken = undefined;
        warnedToken = undefined;
        revealedRecipients.clear();
        closeWarning();
        const snapshot = getOwnStreamSnapshot();
        state = transition(state, { type: "switch-account", accountId, activeStreamIds: snapshot.keys }, now());
        if (!snapshot.available) state = transition(state, { type: "fail-safe" }, now());
    }
    const active = isProtectionActive(state);
    const nextSelected = getSelectedPrivateId();
    if (selectedId !== nextSelected) {
        selectedId = nextSelected;
        approvedToken = undefined;
        warnedToken = undefined;
        stopRequested = "";
        closeWarning();
    }
    const decision = selectedId ? decideChannel(state, selectedId, now(), approvedToken) : undefined;
    const hidden = !!selectedId && active && (decision?.conceal ?? true);
    // Set the privacy gates before processing or mounting any UI.
    document.body.setAttribute("data-vc-streamguard-active", String(active));
    document.body.setAttribute("data-vc-streamguard-hidden", String(hidden));
    document.body.setAttribute("data-vc-streamguard-servers", String(settings.store.blurServers));
    applyStrength();
    const chat = markSections(active, hidden);
    try {
        renderOverlay(chat, hidden);
        renderPill(active);
    } catch (error) {
        console.warn("[StreamGuard] Privacy controls could not be rendered; blur remains in place.", error);
        toast("StreamGuard could not display its controls. Verify privacy before sharing.", true);
    }
    syncNotifications(active && settings.store.suppressNotifications);
    scheduleExpiry();
    if (active) checkProtection();
    if (decision?.outcome === "warn" && decision.blocked && decision.approvalToken && selectedId) {
        showWarning(selectedId, decision.approvalToken);
    } else if (decision?.outcome === "stop" && decision.blocked) {
        const signature = decision.streamIds.slice().sort().join("|");
        if (signature !== stopRequested) {
            stopRequested = signature;
            // Avoid dispatching a stream-stop action inside another Flux dispatch.
            queueMicrotask(() => { if (running) stopSharing(); });
        }
    }
}

function revealChat(id: string) {
    if (!state || !isProtectionActive(state) || !privateChannelId(id)) return;
    if (state.failSafe) {
        toast("StreamGuard is in fail-safe mode. Stop sharing and restart the plugin before revealing.", true);
        return;
    }
    if (state.panic) state = transition(state, { type: "clear-panic" }, now());
    approvedToken = undefined;
    warnedToken = undefined;
    update({ type: "reveal", channelId: id, duration: duration() });
    const recipients = recipientsFor(id);
    if (recipients !== undefined) revealedRecipients.set(id, recipients);
}

function hideChat(id: string) {
    if (!state) return;
    approvedToken = undefined;
    warnedToken = undefined;
    revealedRecipients.delete(id);
    // A hidden chat must not remain exposed through an allowlist exception.
    state = transition(state, { type: "remove-allowlist", channelId: id }, now());
    update({ type: "remove-reveal", channelId: id });
}

function hideAll() {
    if (!state) return;
    const wasManual = state.manualEnabled || !isProtectionActive(state);
    state = transition(state, { type: "panic" }, now());
    // No persistent allowlist UI is provided; drop any existing exceptions too.
    state = transition(state, { type: "set-allowlist", channelIds: [] }, now());
    state = transition(state, { type: "clear-panic" }, now());
    state = transition(state, { type: "set-manual", enabled: wasManual }, now());
    revealedRecipients.clear();
    approvedToken = undefined;
    warnedToken = undefined;
    closeWarning();
    refresh();
}

const patchPrivateMenu: NavContextMenuPatchCallback = (children, props: { channel?: Channel; user?: { id: string; }; }) => {
    if (!running || !state || !isProtectionActive(state)) return;
    if (props.channel && !isPrivate(props.channel)) return;
    let id = props.channel?.id;
    if (!isPrivate(props.channel) && props.user?.id) id = ChannelStore.getDMFromUserId(props.user.id);
    if (!id || !privateChannelId(id)) return;
    const channelId = id;
    children.push(<Menu.MenuItem id="vc-streamguard-toggle-chat" label={isRevealed(channelId) ? "Hide chat" : "Reveal chat"} action={() => {
        if (isRevealed(channelId)) hideChat(channelId);
        else revealChat(channelId);
    }} />);
};

function streamEvent(event: { streamKey?: unknown; }, create: boolean) {
    if (!running || typeof event.streamKey !== "string" || event.streamKey.split(":").at(-1) !== currentUserId()) return;
    approvedToken = undefined;
    warnedToken = undefined;
    stopRequested = "";
    if (!state) return;
    if (create) {
        state = transition(state, { type: "stream-start", streamId: event.streamKey }, now());
        refresh();
    } else {
        // Never unprotect on an event alone. Reconcile after Flux dispatch so
        // the store can confirm that no own stream remains.
        queueMicrotask(streamStoreChanged);
    }
}

function storeChanged() {
    if (!running || !state) return;
    // A removed DM or changed recipient list must not retain a reveal.
    for (const [id, recipients] of revealedRecipients) {
        if (recipientsFor(id) === recipients) continue;
        state = transition(state, { type: "remove-reveal", channelId: id }, now());
        revealedRecipients.delete(id);
        approvedToken = undefined;
    }
    refresh();
}

function streamStoreChanged() {
    if (!running || !state || currentUserId() !== state.accountId) return;
    const snapshot = getOwnStreamSnapshot();
    if (!snapshot.available) {
        state = transition(state, { type: "fail-safe" }, now());
        toast("StreamGuard lost stream-state access. Stop sharing manually and verify privacy.", true);
        queueMicrotask(() => { if (running) stopSharing(); });
        refresh();
        return;
    }
    const previous = state.activeStreamIds;
    const continuous = previous.some(key => snapshot.keys.includes(key));
    state = transition(state, { type: "reconcile", activeStreamIds: snapshot.keys }, now());
    if (previous.length > 0 && !continuous) {
        revealedRecipients.clear();
        approvedToken = undefined;
        warnedToken = undefined;
        closeWarning();
    }
    refresh();
}

function queueScan() {
    if (scanQueued || !running) return;
    scanQueued = true;
    queueMicrotask(() => {
        scanQueued = false;
        if (!running || !state) return;
        // DOM insertion is delivered before paint. Avoid rendering the roots in
        // response to their own updates, which would otherwise create a loop.
        const active = isProtectionActive(state);
        const id = getSelectedPrivateId();
        if (id !== selectedId) return refresh();
        const hidden = document.body.getAttribute("data-vc-streamguard-hidden") === "true";
        const previousChat = overlayHost?.parentElement;
        const chat = markSections(active, hidden);
        if (hidden && chat && previousChat !== chat) {
            try { renderOverlay(chat, true); } catch (error) { console.warn("[StreamGuard] Could not render the overlay.", error); }
        }
        if (active) checkProtection();
    });
}

function blockHiddenComposer(event: Event) {
    if (!running || !state || settings.store.allowTyping || document.body.getAttribute("data-vc-streamguard-hidden") !== "true") return;
    const { target } = event;
    if (!(target instanceof Element) || !target.closest(SELECTORS.composer)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

export default definePlugin({
    name: "StreamGuard",
    description: "Automatically blurs your private chats (names, avatars, messages) while you screen share, and lets you reveal specific chats on demand with a right click.",
    authors: [{ name: "d12w", id: 0n }],
    settings,
    contextMenus: {
        "user-context": patchPrivateMenu,
        "gdm-context": patchPrivateMenu,
        "channel-context": patchPrivateMenu
    },
    commands: [
        {
            name: "streamguard",
            description: "Toggle manual StreamGuard protection.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                if (!state) return;
                update({ type: "toggle-manual" });
                toast(`StreamGuard manual protection ${state.manualEnabled ? "enabled" : "disabled"}. Active streams may still be protected.`);
            }
        },
        {
            name: "streamguard-panic",
            description: "Immediately hide all revealed private chats.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => { hideAll(); toast("StreamGuard hid all revealed chats."); }
        }
    ],
    flux: {
        STREAM_CREATE: (event: { streamKey?: unknown; }) => streamEvent(event, true),
        STREAM_DELETE: (event: { streamKey?: unknown; }) => streamEvent(event, false)
    },
    start() {
        running = true;
        notificationWarningShown = false;
        notificationsWanted = undefined;
        const snapshot = getOwnStreamSnapshot();
        state = createState({ accountId: currentUserId(), activeStreamIds: snapshot.keys, now: now(), settings: { automatic: settings.store.autoEnable, safetyMode: mode() } });
        if (!snapshot.available) {
            state = transition(state, { type: "fail-safe" }, now());
            toast("StreamGuard could not verify active streams. Stop sharing manually and check privacy.", true);
        }
        strengthStyle = document.createElement("style");
        strengthStyle.setAttribute("data-vc-streamguard-style", "true");
        document.head.appendChild(strengthStyle);
        SelectedChannelStore?.addChangeListener?.(storeChanged);
        ChannelStore?.addChangeListener?.(storeChanged);
        UserStore?.addChangeListener?.(storeChanged);
        ApplicationStreamingStore?.addChangeListener?.(streamStoreChanged);
        window.addEventListener("popstate", storeChanged);
        document.addEventListener("keydown", blockHiddenComposer, true);
        document.addEventListener("beforeinput", blockHiddenComposer, true);
        document.addEventListener("paste", blockHiddenComposer, true);
        document.addEventListener("drop", blockHiddenComposer, true);
        observer = new MutationObserver(records => {
            // Ignore our own probe and UI mutations so a verification frame
            // does not schedule another verification frame indefinitely.
            if (records.some(record => {
                if (record.target instanceof Element && record.target.closest(".vc-streamguard-overlay, .vc-streamguard-pill")) return false;
                const nodes = [...record.addedNodes, ...record.removedNodes];
                return nodes.some(node => !(node instanceof HTMLElement) ||
                    !node.matches('[data-vc-streamguard-probe="true"], .vc-streamguard-overlay, .vc-streamguard-pill'));
            })) queueScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        refresh();
    },
    stop() {
        running = false;
        observer?.disconnect();
        observer = undefined;
        SelectedChannelStore?.removeChangeListener?.(storeChanged);
        ChannelStore?.removeChangeListener?.(storeChanged);
        UserStore?.removeChangeListener?.(storeChanged);
        ApplicationStreamingStore?.removeChangeListener?.(streamStoreChanged);
        window.removeEventListener("popstate", storeChanged);
        document.removeEventListener("keydown", blockHiddenComposer, true);
        document.removeEventListener("beforeinput", blockHiddenComposer, true);
        document.removeEventListener("paste", blockHiddenComposer, true);
        document.removeEventListener("drop", blockHiddenComposer, true);
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = undefined;
        if (stopConfirmationTimer) clearTimeout(stopConfirmationTimer);
        stopConfirmationTimer = undefined;
        closeWarning();
        removeOverlay();
        if (pillRoot) pillRoot.unmount();
        pillRoot = undefined;
        pillHost?.remove();
        pillHost = undefined;
        restoreTyping();
        clearMarks();
        strengthStyle?.remove();
        strengthStyle = undefined;
        document.body.removeAttribute("data-vc-streamguard-active");
        document.body.removeAttribute("data-vc-streamguard-hidden");
        document.body.removeAttribute("data-vc-streamguard-servers");
        notificationsWanted = undefined;
        syncNotifications(false);
        selectedId = undefined;
        approvedToken = undefined;
        warnedToken = undefined;
        revealedRecipients.clear();
        state = undefined;
    }
});
