'use strict';

// Node 22.18+ supports directly importing the erasable TypeScript in logic.ts.
// Run: node --test tests/logic.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, transition, restoreState, decideChannel, isProtectionActive } = require('../logic.ts');

const T = 1_700_000_000_000;
const minute = 60_000;
const init = (extra = {}) => createState({ accountId: 'alice', activeStreamIds: [], now: T, ...extra });
const go = (state, action, now = T) => transition(state, action, now);
const view = (state, channel = 'private', now = T, token) => decideChannel(state, channel, now, token);
const start = (state, id = 'stream-1', now = T) => go(state, { type: 'stream-start', streamId: id }, now);
const reveal = (state, duration = '5m', channelId = 'private', now = T) =>
  go(state, { type: 'reveal', channelId, duration }, now);

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test('stream start activates automatic protection and conceals ordinary channels', () => {
  const initial = init();
  assert.equal(isProtectionActive(initial), false);
  assert.equal(view(initial).conceal, false);
  const active = start(initial);
  assert.equal(isProtectionActive(active), true);
  assert.deepEqual(active.activeStreamIds, ['stream-1']);
  assert.deepEqual(view(active), {
    outcome: 'nothing', conceal: true, blocked: false, protectionActive: true,
    exception: 'none', streamIds: ['stream-1'],
  });
  assert.deepEqual(initial.activeStreamIds, []);
});

test('automatic detection can be disabled without losing stream tracking', () => {
  let s = init({ settings: { automatic: false } });
  s = start(s);
  assert.equal(isProtectionActive(s), false);
  assert.equal(view(s).conceal, false);
  assert.deepEqual(s.activeStreamIds, ['stream-1']);
  s = go(s, { type: 'set-automatic', enabled: true });
  assert.equal(view(s).conceal, true);
});

test('manual toggle works without streams, even with automatic detection disabled', () => {
  let s = init({ settings: { automatic: false } });
  s = go(s, { type: 'toggle-manual' });
  assert.equal(s.manualEnabled, true);
  assert.equal(view(s).conceal, true);
  s = go(s, { type: 'toggle-manual' });
  assert.equal(s.manualEnabled, false);
  assert.equal(view(s).conceal, false);
  s = go(s, { type: 'set-manual', enabled: true });
  assert.equal(view(s).conceal, true);
});

for (const [duration, milliseconds] of [['5m', 5 * minute], ['15m', 15 * minute], ['1h', 60 * minute]]) {
  test(`${duration} reveal expires exactly at its deadline`, () => {
    const s = reveal(start(init({ settings: { safetyMode: 'nothing' } })), duration);
    assert.equal(view(s, 'private', T + milliseconds - 1).conceal, false);
    assert.equal(view(s, 'private', T + milliseconds).conceal, true);
    // Reading is pure; tick actually prunes serialized state.
    assert.equal(s.reveals.length, 1);
    assert.equal(go(s, { type: 'tick' }, T + milliseconds).reveals.length, 0);
  });
}

test('a new reveal replaces the old deadline for that channel', () => {
  let s = reveal(start(init({ settings: { safetyMode: 'nothing' } })), '5m');
  s = reveal(s, '15m', 'private', T + minute);
  assert.equal(s.reveals.length, 1);
  assert.equal(view(s, 'private', T + 5 * minute).conceal, false);
  assert.equal(view(s, 'private', T + 16 * minute).conceal, true);
});

test('until-streams-stop reveal requires a stream and survives partial stops', () => {
  let s = go(init(), { type: 'set-manual', enabled: true });
  s = reveal(s, 'until-streams-stop');
  assert.equal(s.reveals.length, 0);
  s = start(start(s, 'A'), 'B');
  s = reveal(s, 'until-streams-stop');
  s = go(s, { type: 'stream-stop', streamId: 'A' });
  assert.deepEqual(s.activeStreamIds, ['B']);
  assert.equal(s.reveals.length, 1);
  s = go(s, { type: 'stream-stop', streamId: 'B' });
  assert.deepEqual(s.activeStreamIds, []);
  assert.equal(s.reveals.length, 0);
  assert.equal(view(s).conceal, true); // Manual protection remains on.
});

test('stream IDs are deduplicated; stopping one of multiple streams keeps protection on', () => {
  let s = start(start(start(init(), 'A'), 'A'), 'B');
  assert.deepEqual(s.activeStreamIds, ['A', 'B']);
  s = go(s, { type: 'stream-stop', streamId: 'A' });
  assert.equal(isProtectionActive(s), true);
  s = go(s, { type: 'stream-stop', streamId: 'B' });
  assert.equal(isProtectionActive(s), false);
});

test('timed reveal resets at the last stream stop, even before its deadline', () => {
  let s = start(init({ settings: { safetyMode: 'nothing' } }));
  s = reveal(s, '15m');
  s = go(s, { type: 'stream-stop', streamId: 'stream-1' }, T + minute);
  s = start(s, 'stream-2', T + 2 * minute);
  assert.equal(view(s, 'private', T + 2 * minute).conceal, true);
  assert.equal(view(s, 'private', T + 15 * minute).conceal, true);
});

test('nothing mode displays a revealed chat without warning while streaming', () => {
  const s = reveal(start(init({ settings: { safetyMode: 'nothing' } })));
  const d = view(s);
  assert.equal(d.outcome, 'nothing');
  assert.equal(d.exception, 'temporary');
  assert.equal(d.conceal, false);
  assert.equal(d.blocked, false);
});

test('warn mode conceals pending confirmation and binds approval to the context', () => {
  let s = reveal(start(init({ settings: { safetyMode: 'warn' } })));
  const d = view(s);
  assert.equal(d.outcome, 'warn');
  assert.equal(d.conceal, true);
  assert.equal(d.blocked, true);
  assert.ok(d.approvalToken);
  const approved = view(s, 'private', T, d.approvalToken);
  assert.equal(approved.conceal, false);
  assert.equal(approved.blocked, false);
  s = start(s, 'additional-stream');
  assert.equal(view(s, 'private', T, d.approvalToken).blocked, true);
  assert.equal(view(s, 'other', T, d.approvalToken).conceal, true);
});

test('stop mode blocks and conceals until an authoritative snapshot confirms streams stopped', () => {
  let s = reveal(start(start(init({ settings: { safetyMode: 'stop' } }), 'A'), 'B'));
  let d = view(s);
  assert.equal(d.outcome, 'stop');
  assert.equal(d.conceal, true);
  assert.equal(d.blocked, true);
  assert.deepEqual(d.streamIds, ['A', 'B']);
  s = go(s, { type: 'reconcile', activeStreamIds: ['B'] });
  assert.equal(view(s).outcome, 'stop');
  s = go(s, { type: 'reconcile', activeStreamIds: [] });
  d = view(s);
  assert.equal(d.outcome, 'nothing');
  assert.equal(d.blocked, false);
});

test('warning or stop is unnecessary without an active stream, even with manual protection', () => {
  for (const mode of ['warn', 'stop']) {
    let s = go(init({ settings: { safetyMode: mode } }), { type: 'set-manual', enabled: true });
    s = reveal(s);
    const d = view(s);
    assert.equal(d.outcome, 'nothing');
    assert.equal(d.conceal, false);
    assert.equal(d.blocked, false);
  }
});

test('removing a temporary reveal does not remove a persistent allowlist entry', () => {
  let s = start(init({ allowlist: ['private'], settings: { safetyMode: 'nothing' } }));
  s = reveal(s);
  s = go(s, { type: 'remove-reveal', channelId: 'private' });
  assert.equal(s.reveals.length, 0);
  assert.deepEqual(s.allowlist, ['private']);
  assert.equal(view(s).exception, 'allowlist');
  assert.equal(view(s).conceal, false);
  s = go(s, { type: 'remove-allowlist', channelId: 'private' });
  assert.equal(view(s).conceal, true);
});

test('removing allowlist does not remove a temporary reveal; allowlisted opens use safety mode', () => {
  let s = start(init({ settings: { safetyMode: 'warn' } }));
  s = reveal(s);
  s = go(s, { type: 'add-allowlist', channelId: 'private' });
  assert.equal(view(s).exception, 'allowlist');
  assert.equal(view(s).outcome, 'warn');
  s = go(s, { type: 'remove-allowlist', channelId: 'private' });
  assert.equal(view(s).exception, 'temporary');
  s = go(s, { type: 'remove-reveal', channelId: 'private' });
  assert.equal(view(s).conceal, true);
});

test('panic hides ALL channels, overrides the allowlist, clears reveals, and is latched', () => {
  let s = start(init({ allowlist: ['safe'], settings: { safetyMode: 'nothing' } }));
  s = reveal(s);
  s = go(s, { type: 'panic' });
  assert.equal(s.manualEnabled, true);
  assert.equal(s.panic, true);
  assert.equal(s.reveals.length, 0);
  assert.deepEqual(s.allowlist, ['safe']);
  assert.equal(view(s, 'safe').conceal, true);
  assert.equal(view(s, 'private').conceal, true);
  s = reveal(s);
  assert.equal(s.reveals.length, 0);
  s = go(s, { type: 'set-manual', enabled: false });
  assert.equal(view(s, 'safe').conceal, true);
  s = go(s, { type: 'clear-panic' });
  assert.equal(view(s, 'safe').conceal, false);
});

test('panic while not streaming still protects; clearing panic leaves manual on', () => {
  let s = go(init({ allowlist: ['safe'] }), { type: 'panic' });
  assert.equal(view(s, 'safe').conceal, true);
  s = go(s, { type: 'clear-panic' });
  assert.equal(s.manualEnabled, true);
  assert.equal(view(s, 'unlisted').conceal, true);
  assert.equal(view(s, 'safe').conceal, false);
});

test('account switch drops account-specific data and loads only new account snapshot/list', () => {
  let s = reveal(start(init({ allowlist: ['alice-safe'] })));
  s = go(s, { type: 'panic' });
  s = go(s, { type: 'fail-safe' });
  s = go(s, { type: 'switch-account', accountId: 'bob', activeStreamIds: ['B'], allowlist: ['bob-safe'] });
  assert.equal(s.accountId, 'bob');
  assert.equal(s.manualEnabled, false);
  assert.equal(s.panic, false);
  assert.equal(s.failSafe, false);
  assert.deepEqual(s.reveals, []);
  assert.deepEqual(s.allowlist, ['bob-safe']);
  assert.deepEqual(s.activeStreamIds, ['B']);
  assert.equal(view(s, 'alice-safe').conceal, true);
});

test('reload reconciles stream snapshots, expiration, and authoritative loaded allowlist', () => {
  let s = start(start(init({ allowlist: ['old'], settings: { safetyMode: 'nothing' } }), 'A'), 'B');
  s = reveal(s, 'until-streams-stop', 'until');
  s = reveal(s, '5m', 'timed');
  const saved = JSON.parse(JSON.stringify(s));
  const restored = restoreState(saved, { accountId: 'alice', activeStreamIds: ['B', 'C'], allowlist: ['new'], now: T + 5 * minute });
  assert.deepEqual(restored.activeStreamIds, ['B', 'C']);
  assert.deepEqual(restored.allowlist, ['new']);
  assert.deepEqual(restored.reveals.map(r => r.channelId), ['until']);
  assert.equal(view(restored, 'until', T + 5 * minute).conceal, false);
  assert.equal(view(restored, 'old', T + 5 * minute).conceal, true);
});

test('reload without overlapping stream ID revokes session reveals conservatively', () => {
  let s = start(init({ settings: { safetyMode: 'nothing' } }), 'A');
  s = reveal(s, 'until-streams-stop', 'until');
  s = reveal(s, '1h', 'timed');
  s = restoreState(JSON.parse(JSON.stringify(s)), { accountId: 'alice', activeStreamIds: ['new'], now: T + minute });
  assert.equal(view(s, 'until', T + minute).conceal, true);
  assert.equal(view(s, 'timed', T + minute).conceal, true);
});

test('reload with a different account does not inherit old account exceptions or panic', () => {
  let saved = start(init({ allowlist: ['alice-only'] }), 'A');
  saved = go(saved, { type: 'panic' });
  const s = restoreState(saved, { accountId: 'bob', activeStreamIds: ['B'], now: T });
  assert.equal(s.accountId, 'bob');
  assert.deepEqual(s.allowlist, []);
  assert.equal(s.panic, false);
  assert.equal(view(s, 'alice-only').conceal, true);
});

test('fail-safe hides and blocks even allowlisted channels until explicit recovery', () => {
  let s = reveal(start(init({ allowlist: ['safe'] })));
  s = go(s, { type: 'fail-safe' });
  assert.equal(s.reveals.length, 0);
  assert.equal(s.manualEnabled, true);
  const d = view(s, 'safe');
  assert.equal(d.outcome, 'fail-safe');
  assert.equal(d.conceal, true);
  assert.equal(d.blocked, true);
  s = reveal(s);
  assert.equal(s.reveals.length, 0);
  s = go(s, { type: 'reconcile', activeStreamIds: [] });
  assert.equal(view(s, 'safe').outcome, 'fail-safe');
  s = go(s, { type: 'recover', activeStreamIds: [] });
  assert.equal(s.failSafe, false);
  assert.equal(s.manualEnabled, true);
  assert.equal(view(s, 'ordinary').conceal, true);
  assert.equal(view(s, 'safe').conceal, false);
});

test('corrupt persisted state, bad runtime inputs, and backwards time fail closed', () => {
  const badRestore = restoreState({ nonsense: true }, { accountId: 'alice', activeStreamIds: [], now: T });
  assert.equal(view(badRestore).outcome, 'fail-safe');
  assert.equal(createState({ accountId: 'alice', activeStreamIds: null, now: T }).failSafe, true);
  let s = init();
  s = go(s, { type: 'set-safety-mode', mode: 'not-a-mode' });
  assert.equal(s.failSafe, true);
  assert.equal(view(init(), 'private', T - 1).outcome, 'fail-safe');
  assert.equal(go(init(), { type: 'tick' }, T - 1).failSafe, true);
  assert.equal(view(null).outcome, 'fail-safe');
  assert.equal(view(init(), '').outcome, 'fail-safe');
});

test('transitions, decisions and restoration do not mutate frozen inputs', () => {
  const s = freezeDeep(start(init(), 'A'));
  const action = freezeDeep({ type: 'reveal', channelId: 'x', duration: '5m' });
  const next = transition(s, action, T);
  assert.equal(s.reveals.length, 0);
  assert.equal(next.reveals.length, 1);
  freezeDeep(next);
  assert.equal(view(next, 'x').outcome, 'warn');
  assert.equal(restoreState(next, { accountId: 'alice', activeStreamIds: ['A'], now: T }).failSafe, false);
});
