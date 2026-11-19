/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * StreamGuard compatibility helpers for Equicord and Vencord.
 *
 * Both projects declare ApplicationStreamingStore.getStreamingState() and
 * getState() with activeStreams: [string, Stream][] and Stream.ownerId.
 * This representation and the Discord stop action are runtime-dependent;
 * neither has been verified against a running Discord client here.
 */

import { findByCode } from "@webpack";
import { ApplicationStreamingStore, showToast, UserStore } from "@webpack/common";

function warnUser(message: string): void {
    console.warn(`[StreamGuard] ${message}`);
    try {
        showToast({ text: message, variant: "critical" });
    } catch {
        // The toast module may also be unavailable during startup or shutdown.
        console.warn("[StreamGuard] Could not display the warning toast.");
    }
}

function currentUserId(): string | null {
    try {
        const id = UserStore?.getCurrentUser?.()?.id;
        return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Parse only actual store entries; never synthesize a stream key from metadata. */
function keysFromState(state: unknown, userId: string): string[] | null {
    if (!isRecord(state) || !Array.isArray(state.activeStreams)) return null;

    const entries: unknown[] = state.activeStreams;
    const keys = new Set<string>();
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const key: unknown = entry[0];
        const stream: unknown = entry[1];
        if (typeof key !== "string" || !key || !isRecord(stream) || typeof stream.ownerId !== "string") return null;
        if (stream.ownerId === userId) {
            if (!key.endsWith(`:${userId}`)) return null;
            keys.add(key);
        }
    }
    return [...keys];
}

/**
 * Read and validate one snapshot atomically. `available: false` must never be
 * interpreted as an authoritative empty list. Even an available-looking
 * store may not yet be hydrated; that cannot be established from this API.
 */
export function getOwnStreamSnapshot(): { available: boolean; keys: string[]; } {
    const userId = currentUserId();
    if (!userId) {
        warnUser("StreamGuard cannot identify the current account or its streams. Check your sharing controls manually.");
        return { available: false, keys: [] };
    }

    // A Discord update can remove either method or change its return shape.
    // Try both documented store accessors without trusting unvalidated data.
    try {
        if (typeof ApplicationStreamingStore?.getStreamingState === "function") {
            try {
                const keys = keysFromState(ApplicationStreamingStore.getStreamingState(), userId);
                if (keys !== null) return { available: true, keys };
            } catch {
                // Try the other documented accessor below.
            }
        }
        if (typeof ApplicationStreamingStore?.getState === "function") {
            try {
                const keys = keysFromState(ApplicationStreamingStore.getState(), userId);
                if (keys !== null) return { available: true, keys };
            } catch {
                // Report an unavailable store below.
            }
        }
    } catch {
        // Store access itself may fail if Discord has not initialized it.
    }

    warnUser("StreamGuard cannot determine your active streams. Check your sharing controls manually.");
    return { available: false, keys: [] };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (isRecord(value) || typeof value === "function") && "then" in value && typeof value.then === "function";
}

/**
 * Requests stops for the supplied own keys. True means synchronous action calls
 * returned without an immediate error, not that Discord confirmed the streams
 * ended. False means a stop was unavailable, rejected, or cannot be confirmed;
 * in that case the user is instructed to stop sharing manually.
 *
 * Discord's shared StreamerModeOnStream plugin checks the user ID at the end
 * of event keys. Require a colon boundary as well to avoid suffix collisions.
 * Where possible, additionally reject any store record owned by another user.
 */
export function stopOwnStreams(keys: string[]): boolean {
    const userId = currentUserId();
    if (!userId || !Array.isArray(keys) || keys.length === 0) {
        warnUser("StreamGuard could not stop sharing automatically. Stop sharing manually in Discord.");
        return false;
    }

    let stopAction: unknown;
    try {
        // Unlike the lazy proxy, a runtime find can be checked for absence.
        // In development builds findByCode may throw when no module matches.
        stopAction = findByCode('type:"STREAM_STOP"');
    } catch {
        stopAction = null;
    }
    if (typeof stopAction !== "function") {
        warnUser("StreamGuard's stop-sharing action is unavailable. Stop sharing manually in Discord.");
        return false;
    }

    let allRequested = true;
    const uniqueKeys = new Set<unknown>(keys);
    for (const key of uniqueKeys) {
        if (typeof key !== "string" || !key.endsWith(`:${userId}`)) {
            allRequested = false;
            continue;
        }

        try {
            // The event may arrive before the store updates. A missing record is
            // not proof of non-ownership, but a conflicting record is a hard stop.
            const stream = ApplicationStreamingStore?.getActiveStreamForStreamKey?.(key);
            if (stream && stream.ownerId !== userId) {
                allRequested = false;
                continue;
            }
        } catch {
            // The event key's account boundary remains the fallback check.
        }

        try {
            const result: unknown = stopAction(key);
            if (result === false) allRequested = false;
            if (isPromiseLike(result)) {
                // This synchronous interface cannot certify asynchronous success.
                allRequested = false;
                void Promise.resolve(result).catch(() => {
                    warnUser("StreamGuard's stop request failed. Stop sharing manually in Discord.");
                });
            }
        } catch {
            allRequested = false;
        }
    }

    if (!allRequested) {
        warnUser("StreamGuard could not confirm every stop request. Stop sharing manually in Discord and verify it has ended.");
    }
    return allRequested;
}

/**
 * Unsupported intentionally: neither shared API exposes a verified reversible,
 * DM-only control for both in-app popups and sounds. Streamer mode and the
 * notification store expose broader settings, and changing them cannot ensure
 * exact crash/reload and account-safe restoration or suppress other plugins.
 * Therefore no settings or DataStore entries are changed by this fallback.
 */
export function beginNotificationSuppression(): Promise<boolean> {
    warnUser("StreamGuard cannot suppress DM notifications automatically. Mute notification popups and sounds manually, including desktop notifications and other plugins.");
    return Promise.resolve(false);
}

/** No state was changed, so there is nothing to restore. */
export function endNotificationSuppression(): Promise<void> {
    return Promise.resolve();
}
