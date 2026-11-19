/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * StreamGuard's pure, JSON-serializable state machine.
 *
 * All times are caller-supplied Unix milliseconds; never use a timer or the
 * system clock here. Callers must provide an authoritative snapshot of OWN
 * active stream IDs on startup/reload, and deliver start/stop events even when
 * automatic protection is disabled. Run `tick` at expiry or recompute a
 * channel decision before displaying content. Never render based on stale
 * decisions. Saving the allowlist/config/state is the host's responsibility.
 *
 * Protection is active when manually enabled, panic/fail-safe is latched, or
 * automatic detection is enabled and at least one own stream is active.
 * Normally all channels are concealed except the allowlist and live reveals.
 * Panic and fail-safe override BOTH exceptions. Panic clears temporary reveals
 * and requires explicit `clear-panic`; it also enables manual protection.
 * Fail-safe requires explicit `recover` with a fresh authoritative stream
 * snapshot. Recovery leaves manual protection on.
 *
 * `decideChannel` is the rendering/navigation gate. `conceal` must be honored
 * before content is rendered. `blocked` means navigation/reveal must not be
 * allowed yet. For `warn`, ask for affirmative confirmation and immediately
 * re-evaluate with the returned approvalToken for that ONE navigation only;
 * discard the token afterwards and on any state/context change. For `stop`,
 * stop all returned stream IDs, obtain a fresh authoritative snapshot, dispatch
 * `reconcile`, then re-evaluate; a failed/uncertain stop must dispatch
 * `fail-safe`. This code never stops streams itself. IDs in a decision are a
 * snapshot, not a guarantee that no new stream has started meanwhile.
 *
 * All temporary reveals expire at the end of the final stream, or when a
 * reconciled snapshot has no overlap with previously active streams. Timed
 * reveals may expire earlier at their deadline. `until-streams-stop` requires
 * a currently active stream. Panic, fail-safe and account changes also reset.
 * Allowlist entries persist until explicitly removed/replaced; the host must
 * persist them separately and load the correct account's entries.
 */

export type SafetyMode = "nothing" | "warn" | "stop";
export type RevealDuration = "5m" | "15m" | "1h" | "until-streams-stop";
export type ChannelId = string;
export type StreamId = string;

export interface Settings {
  readonly automatic: boolean;
  readonly safetyMode: SafetyMode;
}

export type Reveal =
  | { readonly channelId: ChannelId; readonly kind: "timed"; readonly expiresAt: number }
  | { readonly channelId: ChannelId; readonly kind: "until-streams-stop" };

export interface StreamGuardState {
  readonly version: 1;
  readonly accountId: string;
  readonly settings: Settings;
  readonly manualEnabled: boolean;
  readonly panic: boolean;
  readonly failSafe: boolean;
  readonly activeStreamIds: readonly StreamId[];
  readonly allowlist: readonly ChannelId[];
  readonly reveals: readonly Reveal[];
  readonly lastNow: number;
}

export interface InitialOptions {
  readonly accountId: string;
  /** Authoritative current IDs; use an empty array only if known to be empty. */
  readonly activeStreamIds: readonly StreamId[];
  readonly now: number;
  readonly allowlist?: readonly ChannelId[];
  readonly settings?: Partial<Settings>;
}

export type Action =
  | { readonly type: "tick" }
  | { readonly type: "toggle-manual" }
  | { readonly type: "set-manual"; readonly enabled: boolean }
  | { readonly type: "set-automatic"; readonly enabled: boolean }
  | { readonly type: "set-safety-mode"; readonly mode: SafetyMode }
  | { readonly type: "stream-start"; readonly streamId: StreamId }
  | { readonly type: "stream-stop"; readonly streamId: StreamId }
  | { readonly type: "reconcile"; readonly activeStreamIds: readonly StreamId[] }
  | { readonly type: "reveal"; readonly channelId: ChannelId; readonly duration: RevealDuration }
  | { readonly type: "remove-reveal"; readonly channelId: ChannelId }
  | { readonly type: "add-allowlist"; readonly channelId: ChannelId }
  | { readonly type: "remove-allowlist"; readonly channelId: ChannelId }
  | { readonly type: "set-allowlist"; readonly channelIds: readonly ChannelId[] }
  | { readonly type: "panic" }
  | { readonly type: "clear-panic" }
  | { readonly type: "fail-safe" }
  | { readonly type: "recover"; readonly activeStreamIds: readonly StreamId[] }
  | { readonly type: "switch-account"; readonly accountId: string; readonly activeStreamIds: readonly StreamId[]; readonly allowlist?: readonly ChannelId[] };

export interface ChannelDecision {
  readonly outcome: SafetyMode | "fail-safe";
  /** Conceal message content now, including while a warning or stop is pending. */
  readonly conceal: boolean;
  /** Do not complete the requested open/reveal while true. */
  readonly blocked: boolean;
  readonly protectionActive: boolean;
  readonly exception: "none" | "temporary" | "allowlist";
  readonly streamIds: readonly StreamId[];
  /** Present only for a warning needing confirmation. Opaque, context-bound. */
  readonly approvalToken?: string;
}

const DEFAULT_SETTINGS: Settings = { automatic: true, safetyMode: "warn" };
const DURATIONS: Record<Exclude<RevealDuration, "until-streams-stop">, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isMode(value: unknown): value is SafetyMode {
  return value === "nothing" || value === "warn" || value === "stop";
}
function isIdList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isId);
}
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validState(value: unknown): value is StreamGuardState {
  if (!object(value) || value.version !== 1 || !isId(value.accountId) ||
      !object(value.settings) || typeof value.settings.automatic !== "boolean" ||
      !isMode(value.settings.safetyMode) || typeof value.manualEnabled !== "boolean" ||
      typeof value.panic !== "boolean" || typeof value.failSafe !== "boolean" ||
      !isIdList(value.activeStreamIds) || !isIdList(value.allowlist) ||
      !isTime(value.lastNow) || !Array.isArray(value.reveals)) return false;
  if (new Set(value.activeStreamIds).size !== value.activeStreamIds.length ||
      new Set(value.allowlist).size !== value.allowlist.length) return false;
  if ((value.panic || value.failSafe) && value.reveals.length !== 0) return false;
  const channels = new Set<string>();
  for (const entry of value.reveals) {
    if (!object(entry) || !isId(entry.channelId) || channels.has(entry.channelId)) return false;
    if (entry.kind !== "until-streams-stop" &&
        !(entry.kind === "timed" && isTime(entry.expiresAt))) return false;
    if (entry.kind === "until-streams-stop" && value.activeStreamIds.length === 0) return false;
    channels.add(entry.channelId);
  }
  return true;
}

/** Construct a safe latch even if caller-provided state or input is corrupt. */
function closed(previous: unknown, now: unknown, accountId?: unknown): StreamGuardState {
  if (validState(previous)) {
    return {
      ...previous,
      manualEnabled: true,
      failSafe: true,
      reveals: [],
      lastNow: isTime(now) && now >= previous.lastNow ? now : previous.lastNow,
    };
  }
  return {
    version: 1,
    accountId: isId(accountId) ? accountId : "unknown-account",
    settings: DEFAULT_SETTINGS,
    manualEnabled: true,
    panic: false,
    failSafe: true,
    activeStreamIds: [],
    allowlist: [],
    reveals: [],
    lastNow: isTime(now) ? now : 0,
  };
}

/** Create initial state from the current account and an authoritative snapshot. */
export function createState(options: InitialOptions): StreamGuardState {
  if (!object(options) || !isId(options.accountId) || !isIdList(options.activeStreamIds) ||
      !isTime(options.now) || (options.allowlist !== undefined && !isIdList(options.allowlist)) ||
      (options.settings !== undefined && !object(options.settings))) {
    return closed(null, object(options) ? options.now : undefined, object(options) ? options.accountId : undefined);
  }
  const automatic = options.settings?.automatic ?? DEFAULT_SETTINGS.automatic;
  const safetyMode = options.settings?.safetyMode ?? DEFAULT_SETTINGS.safetyMode;
  if (typeof automatic !== "boolean" || !isMode(safetyMode)) return closed(null, options.now, options.accountId);
  return {
    version: 1,
    accountId: options.accountId,
    settings: { automatic, safetyMode },
    manualEnabled: false,
    panic: false,
    failSafe: false,
    activeStreamIds: unique(options.activeStreamIds),
    allowlist: unique(options.allowlist ?? []),
    reveals: [],
    lastNow: options.now,
  };
}

/** Restore saved state only after reconciling with this account's live snapshot. */
export function restoreState(saved: unknown, options: Omit<InitialOptions, "settings">): StreamGuardState {
  if (!object(options) || !isId(options.accountId) || !isIdList(options.activeStreamIds) ||
      !isTime(options.now) || (options.allowlist !== undefined && !isIdList(options.allowlist))) {
    return closed(null, object(options) ? options.now : undefined, object(options) ? options.accountId : undefined);
  }
  if (!validState(saved)) return closed(null, options.now, options.accountId);
  if (saved.accountId !== options.accountId) {
    return createState({ ...options, allowlist: options.allowlist ?? [], settings: saved.settings });
  }
  const base = options.allowlist === undefined ? saved : { ...saved, allowlist: unique(options.allowlist) };
  return transition(base, { type: "reconcile", activeStreamIds: options.activeStreamIds }, options.now);
}

/** Whether protection is active, without evaluating a channel exception. */
export function isProtectionActive(state: StreamGuardState): boolean {
  if (!validState(state)) return true;
  return state.failSafe || state.panic || state.manualEnabled ||
    (state.settings.automatic && state.activeStreamIds.length > 0);
}

function withSnapshot(state: StreamGuardState, ids: readonly string[]): StreamGuardState {
  const activeStreamIds = unique(ids);
  const oldIds = new Set(state.activeStreamIds);
  const continuous = state.activeStreamIds.length > 0 && activeStreamIds.some(id => oldIds.has(id));
  return {
    ...state,
    activeStreamIds,
    reveals: state.activeStreamIds.length > 0 && !continuous ? [] : state.reveals,
  };
}

/** Pure transition: invalid input, invalid state, or a backwards clock fails closed. */
export function transition(state: StreamGuardState, action: Action, now: number): StreamGuardState {
  if (!validState(state) || !isTime(now) || now < state.lastNow || !object(action)) return closed(state, now);
  const next: StreamGuardState = {
    ...state,
    lastNow: now,
    reveals: state.reveals.filter(r => r.kind !== "timed" || now < r.expiresAt),
  };
  switch (action.type) {
    case "tick": return next;
    case "toggle-manual": return { ...next, manualEnabled: !next.manualEnabled };
    case "set-manual":
      return typeof action.enabled === "boolean" ? { ...next, manualEnabled: action.enabled } : closed(next, now);
    case "set-automatic":
      return typeof action.enabled === "boolean" ? { ...next, settings: { ...next.settings, automatic: action.enabled } } : closed(next, now);
    case "set-safety-mode":
      return isMode(action.mode) ? { ...next, settings: { ...next.settings, safetyMode: action.mode } } : closed(next, now);
    case "stream-start":
      return isId(action.streamId) ? { ...next, activeStreamIds: unique([...next.activeStreamIds, action.streamId]) } : closed(next, now);
    case "stream-stop": {
      if (!isId(action.streamId)) return closed(next, now);
      const ids = next.activeStreamIds.filter(id => id !== action.streamId);
      const endedLast = next.activeStreamIds.includes(action.streamId) && ids.length === 0;
      return { ...next, activeStreamIds: ids, reveals: endedLast ? [] : next.reveals };
    }
    case "reconcile":
      return isIdList(action.activeStreamIds) ? withSnapshot(next, action.activeStreamIds) : closed(next, now);
    case "reveal": {
      if (!isId(action.channelId) || (action.duration !== "until-streams-stop" &&
          !Object.prototype.hasOwnProperty.call(DURATIONS, action.duration))) return closed(next, now);
      if (next.panic || next.failSafe || !isProtectionActive(next) ||
          (action.duration === "until-streams-stop" && next.activeStreamIds.length === 0)) return next;
      const reveal: Reveal = action.duration === "until-streams-stop"
        ? { channelId: action.channelId, kind: "until-streams-stop" }
        : { channelId: action.channelId, kind: "timed", expiresAt: now + DURATIONS[action.duration] };
      if (reveal.kind === "timed" && !isTime(reveal.expiresAt)) return closed(next, now);
      return { ...next, reveals: [...next.reveals.filter(r => r.channelId !== action.channelId), reveal] };
    }
    case "remove-reveal":
      return isId(action.channelId) ? { ...next, reveals: next.reveals.filter(r => r.channelId !== action.channelId) } : closed(next, now);
    case "add-allowlist":
      return isId(action.channelId) ? { ...next, allowlist: unique([...next.allowlist, action.channelId]) } : closed(next, now);
    case "remove-allowlist":
      return isId(action.channelId) ? { ...next, allowlist: next.allowlist.filter(id => id !== action.channelId) } : closed(next, now);
    case "set-allowlist":
      return isIdList(action.channelIds) ? { ...next, allowlist: unique(action.channelIds) } : closed(next, now);
    case "panic": return { ...next, manualEnabled: true, panic: true, reveals: [] };
    case "clear-panic": return { ...next, panic: false };
    case "fail-safe": return closed(next, now);
    case "recover":
      return isIdList(action.activeStreamIds) ? { ...withSnapshot(next, action.activeStreamIds), manualEnabled: true, failSafe: false, reveals: [] } : closed(next, now);
    case "switch-account":
      if (!isId(action.accountId) || !isIdList(action.activeStreamIds) ||
          (action.allowlist !== undefined && !isIdList(action.allowlist))) return closed(next, now);
      return createState({ accountId: action.accountId, activeStreamIds: action.activeStreamIds,
        allowlist: action.allowlist ?? [], settings: next.settings, now });
    default: return closed(next, now);
  }
}

/**
 * Decide whether content can be rendered/opened. For an approved warning pass
 * the exact token from the immediately preceding warning as `approvalToken`.
 * Tokens are context fingerprints, not cryptographic authorization; keep them
 * only in trusted adapter code. Invalid/stale tokens never grant access.
 */
export function decideChannel(
  state: StreamGuardState,
  channelId: ChannelId,
  now: number,
  approvalToken?: string,
): ChannelDecision {
  if (!validState(state) || !isId(channelId) || !isTime(now) || now < state.lastNow || state.failSafe) {
    return { outcome: "fail-safe", conceal: true, blocked: true, protectionActive: true,
      exception: "none", streamIds: validState(state) ? [...state.activeStreamIds] : [] };
  }
  const protectionActive = isProtectionActive(state);
  const streamIds = [...state.activeStreamIds];
  if (!protectionActive) return { outcome: "nothing", conceal: false, blocked: false, protectionActive, exception: "none", streamIds };
  if (state.panic) return { outcome: "nothing", conceal: true, blocked: false, protectionActive, exception: "none", streamIds };
  const reveal = state.reveals.find(r => r.channelId === channelId && (r.kind !== "timed" || now < r.expiresAt));
  const exception = state.allowlist.includes(channelId) ? "allowlist" : reveal ? "temporary" : "none";
  if (exception === "none") return { outcome: "nothing", conceal: true, blocked: false, protectionActive, exception, streamIds };
  if (streamIds.length === 0 || state.settings.safetyMode === "nothing") {
    return { outcome: "nothing", conceal: false, blocked: false, protectionActive, exception, streamIds };
  }
  if (state.settings.safetyMode === "stop") {
    return { outcome: "stop", conceal: true, blocked: true, protectionActive, exception, streamIds };
  }
  // Include exception identity and deadline; changing any of them invalidates approval.
  const fingerprint = JSON.stringify([state.accountId, channelId, [...streamIds].sort(), exception,
    exception === "temporary" ? reveal : null, state.settings.automatic, state.manualEnabled]);
  if (approvalToken === fingerprint) return { outcome: "warn", conceal: false, blocked: false, protectionActive, exception, streamIds };
  return { outcome: "warn", conceal: true, blocked: true, protectionActive, exception, streamIds, approvalToken: fingerprint };
}
