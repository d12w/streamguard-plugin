/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* Browser-only Vencord/Discord mock for integration.smoke.test.cjs.
 * These are test doubles, not a representation of actual Discord internals.
 */
const config = globalThis.__sgConfig || {};
const api = globalThis.__sg = {
    config,
    toasts: [],
    stopRequests: [],
    rootsCreated: 0,
    rootsUnmounted: 0,
    modals: new Map(),
    nextModal: 0
};

function makeStore(methods = {}) {
    const listeners = new Set();
    return {
        ...methods,
        addChangeListener(fn) { listeners.add(fn); },
        removeChangeListener(fn) { listeners.delete(fn); },
        emit() { for (const fn of [...listeners]) fn(); },
        listenerCount() { return listeners.size; }
    };
}

const channel = id => ({
    id, type: 1, recipients: ["user-2"],
    isDM: () => true,
    isGroupDM: () => false
});
api.channels = { "100": channel("100"), "200": channel("200") };
export const UserStore = api.userStore = makeStore({
    getCurrentUser: () => config.meId == null ? null : { id: config.meId }
});
export const ChannelStore = api.channelStore = makeStore({
    getChannel: id => api.channels[id],
    getDMFromUserId: () => "100"
});
export const SelectedChannelStore = api.selectedStore = makeStore({
    getChannelId: () => config.selectedId || "100"
});
export const ApplicationStreamingStore = api.streamStore = makeStore({
    getStreamingState: () => config.snapshot,
    getState: () => config.snapshot,
    getActiveStreamForStreamKey: key =>
        config.snapshot?.activeStreams?.find?.(entry => entry?.[0] === key)?.[1]
});
export function findByCode() {
    return config.stopUnavailable ? null : key => {
        api.stopRequests.push(key);
        return true;
    };
}
export function showToast(value) { api.toasts.push(value); }
export const ApplicationCommandInputType = { BUILT_IN: "built-in" };
export const OptionType = { BOOLEAN: "boolean", SLIDER: "slider", SELECT: "select" };
export function definePluginSettings(definitions) {
    const store = {};
    for (const [name, entry] of Object.entries(definitions)) {
        store[name] = entry.default !== undefined
            ? entry.default
            : entry.options?.find(option => option.default)?.value;
    }
    Object.assign(store, config.settings || {});
    api.settings = { store, definitions };
    return api.settings;
}
export default function definePlugin(plugin) { api.plugin = plugin; return plugin; }

// Tiny renderer: enough for the plugin's real JSX trees and button handlers.
// It intentionally is not React and does not test React reconciliation.
const Fragment = Symbol("Fragment");
globalThis.VencordFragment = Fragment;
globalThis.VencordCreateElement = (tag, props, ...children) => ({ tag, props: props || {}, children });
function add(parent, vnode) {
    if (vnode === false || vnode === true || vnode == null) return;
    if (Array.isArray(vnode)) { for (const child of vnode) add(parent, child); return; }
    if (typeof vnode === "string" || typeof vnode === "number") {
        parent.appendChild(document.createTextNode(String(vnode)));
        return;
    }
    if (vnode.tag === Fragment) { add(parent, vnode.children); return; }
    if (typeof vnode.tag === "function") {
        add(parent, vnode.tag({ ...vnode.props, children: vnode.children }));
        return;
    }
    const el = document.createElement(vnode.tag);
    for (const [key, value] of Object.entries(vnode.props)) {
        if (key === "className") el.className = value;
        else if (key === "style") Object.assign(el.style, value);
        else if (key.startsWith("on") && typeof value === "function")
            el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value != null && typeof value !== "function") el.setAttribute(key, String(value));
    }
    add(el, vnode.children);
    parent.appendChild(el);
}
export function createRoot(host) {
    api.rootsCreated++;
    let unmounted = false;
    return {
        render(vnode) { const frag = document.createDocumentFragment(); add(frag, vnode); host.replaceChildren(frag); },
        unmount() { if (!unmounted) { unmounted = true; api.rootsUnmounted++; host.replaceChildren(); } }
    };
}
export function Button(props) {
    return VencordCreateElement("button", { onClick: props.onClick, "data-mock-button": "true" }, ...(props.children || []));
}
export function Modal(props) {
    return VencordCreateElement("section", { "data-mock-modal": "true" },
        VencordCreateElement("h2", null, props.title),
        ...(props.actions || []).map(action => VencordCreateElement("button", { onClick: action.onClick }, action.text)));
}
export function openModal(render) {
    const id = "mock-modal-" + ++api.nextModal;
    const host = document.createElement("div");
    host.id = id;
    api.modals.set(id, host);
    const frag = document.createDocumentFragment();
    add(frag, render({ onClose: () => closeModal(id) }));
    host.appendChild(frag);
    document.body.appendChild(host);
    return id;
}
export function closeModal(id) {
    api.modals.get(id)?.remove();
    api.modals.delete(id);
}
export const Menu = { MenuItem: props => VencordCreateElement("button", { onClick: props.action }, props.label) };
