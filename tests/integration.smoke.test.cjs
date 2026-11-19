'use strict';

// Focused MOCK integration test; does not connect to Discord or use React.
// Run from the plugin folder with STREAMGUARD_DEPS_ROOT set to a checkout.
// The tests use a real browser, but mocked Discord APIs, stores, and rendering.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const dependencyRoots = [process.env.STREAMGUARD_DEPS_ROOT, path.resolve(__dirname, '../../../..'), process.cwd()].filter(Boolean);
const esbuild = require(require.resolve('esbuild', { paths: dependencyRoots }));
const puppeteer = require(require.resolve('puppeteer-core', { paths: dependencyRoots }));

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
const key = 'call:100:me';
const snapshot = (...keys) => ({ activeStreams: keys.map(k => [k, { ownerId: k.split(':').at(-1) }]) });
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <aside id="servers" class="guilds_test">Server</aside>
  <nav id="dm-list" class="privateChannels_test">
    <div id="dm-row" data-list-item-id="privateChannels___100"><a href="/channels/@me/100">Alice</a></div>
    <div id="unmapped-row">Private unclassified row</div>
  </nav>
  <main id="chat" class="chat_test">
    <header id="chat-header">Private title</header><div id="messages">Private messages</div>
    <div id="composer" class="channelTextArea_test"><input id="input" value="private draft"></div>
    <aside id="members" class="membersWrap_test">Private members</aside>
  </main>
  <section id="friends" class="peopleColumn_test">Friends</section>
  <section id="active-now" class="nowPlayingColumn_test">Active now</section>
</body></html>`;

let browser, js, css;
before(async () => {
    const build = await esbuild.build({
        entryPoints: [path.join(root, 'index.tsx')], bundle: true, write: false,
        outdir: path.join(__dirname, '.esbuild-memory-only'), format: 'iife',
        globalName: '__StreamGuardBundle', platform: 'browser', target: 'chrome120',
        jsxFactory: 'VencordCreateElement', jsxFragment: 'VencordFragment',
        logLevel: 'silent',
        plugins: [{ name: 'vencord-mocks', setup(build) {
            build.onResolve({ filter: /^@/ }, () => ({ path: path.join(__dirname, 'smoke-mocks.js') }));
        } }]
    });
    js = build.outputFiles.find(f => f.path.endsWith('.js'))?.text;
    css = build.outputFiles.find(f => f.path.endsWith('.css'))?.text;
    assert.ok(js && css, 'esbuild must emit JS and the real imported CSS');
    fs.mkdirSync(profile, { recursive: true });
    browser = await puppeteer.launch({
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: profile,
        env: { ...process.env, HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile, TMPDIR: profile },
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--disable-crash-reporter']
    });
});
after(async () => {
    if (browser) await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
});

async function pageFor(t, config = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.stack || error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });
    t.after(async () => {
        try { await page.evaluate(() => globalThis.__sg?.plugin?.stop()); }
        finally { await page.close(); }
        assert.deepEqual(errors, [], 'unexpected browser page errors / console.error');
    });
    await page.setRequestInterception(true);
    page.on('request', req => req.respond({ status: 200, contentType: 'text/html', body: fixture }));
    await page.goto('http://streamguard.test/channels/@me/100');
    await page.evaluate(config => {
        globalThis.__sgConfig = config;
        // Count pending observers/animation frames for bounded lifecycle checks.
        const NativeObserver = globalThis.MutationObserver;
        globalThis.__metrics = { activeObservers: 0, frames: 0 };
        globalThis.MutationObserver = class extends NativeObserver {
            observe(...args) { if (!this.__active) { this.__active = true; __metrics.activeObservers++; } return super.observe(...args); }
            disconnect() { if (this.__active) { this.__active = false; __metrics.activeObservers--; } return super.disconnect(); }
        };
        const raf = globalThis.requestAnimationFrame.bind(globalThis);
        globalThis.requestAnimationFrame = cb => { __metrics.frames++; return raf(cb); };
    }, { meId: 'me', snapshot: snapshot(), ...config });
    await page.addStyleTag({ content: css });
    await page.$eval('head style:last-child', el => el.setAttribute('data-test-real-css', ''));
    await page.addScriptTag({ content: js });
    return page;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 140));
async function start(page) { await page.evaluate(() => __sg.plugin.start()); await settle(); }
async function stream(page, type, streamKey = key) {
    await page.evaluate(({ type, streamKey }) => __sg.plugin.flux[type]({ streamKey }), { type, streamKey });
    await settle();
}
async function status(page) {
    return page.evaluate(() => {
        const style = id => {
            const s = getComputedStyle(document.getElementById(id));
            return { filter: s.filter, userSelect: s.userSelect, pointerEvents: s.pointerEvents };
        };
        return {
            active: document.body.getAttribute('data-vc-streamguard-active'),
            hidden: document.body.getAttribute('data-vc-streamguard-hidden'),
            ready: document.getElementById('dm-list').getAttribute('data-vc-streamguard-ready'),
            row: document.getElementById('dm-row').getAttribute('data-vc-streamguard-chat'),
            list: style('dm-list'), header: style('chat-header'), messages: style('messages'),
            composer: style('composer'), friends: style('friends'), activeNow: style('active-now'),
            members: style('members'), servers: style('servers'),
            overlay: !!document.querySelector('.vc-streamguard-overlay'),
            pill: !!document.querySelector('.vc-streamguard-pill'),
            modal: document.querySelector('[data-mock-modal]')?.innerText || null
        };
    });
}
function assertInactive(s) {
    assert.equal(s.active, 'false');
    assert.equal(s.hidden, 'false');
    for (const k of ['list', 'header', 'messages', 'friends', 'activeNow']) assert.equal(s[k].filter, 'none', `${k} should be restored`);
    assert.equal(s.overlay, false);
}
function assertHidden(s) {
    assert.equal(s.active, 'true');
    assert.equal(s.hidden, 'true');
    for (const k of ['list', 'header', 'messages', 'friends', 'activeNow', 'members']) {
        assert.match(s[k].filter, /blur\(18px\)/, `${k} must be blurred`);
    }
    assert.equal(s.ready, null, 'whole DM list stays blurred even with unclassified/virtualized rows');
    assert.equal(s.list.userSelect, 'none');
    assert.equal(s.header.pointerEvents, 'none');
    assert.equal(s.composer.pointerEvents, 'none');
    assert.equal(s.servers.filter, 'none', 'server rail is opt-in');
    assert.equal(s.overlay, true);
    assert.equal(s.pill, true);
}
async function clickText(page, selector, text) {
    const clicked = await page.evaluate(({ selector, text }) => {
        const button = [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === text);
        if (!button) return false;
        button.click(); return true;
    }, { selector, text });
    assert.ok(clicked, `missing ${selector} button: ${text}`);
    await settle();
}

// Includes stream filtering, actual CSS computed styles, warning gating, panic and end/restart.
test('own stream protects entire mock surfaces; warning, panic, end and restart', async t => {
    const page = await pageFor(t);
    await start(page);
    assertInactive(await status(page));
    await stream(page, 'STREAM_CREATE', 'call:100:someone-else');
    assertInactive(await status(page));
    await page.evaluate(k => { __sg.config.snapshot = { activeStreams: [[k, { ownerId: 'me' }]] }; }, key);
    await stream(page, 'STREAM_CREATE');
    let s = await status(page);
    assertHidden(s);
    assert.equal(s.row, 'hidden');
    assert.equal(await page.evaluate(() => document.getElementById('input').dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'x' }))), false);

    await clickText(page, '.vc-streamguard-overlay button', 'Reveal chat');
    s = await status(page);
    assertHidden(s);
    assert.match(s.modal, /Viewers will see this chat\./);
    assert.equal(s.row, 'revealed'); // but the entire unmapped list is still blurred
    await clickText(page, '[data-mock-modal] button', 'Continue');
    s = await status(page);
    assert.equal(s.hidden, 'false');
    assert.equal(s.header.filter, 'none');
    assert.equal(s.messages.filter, 'none');
    assert.match(s.list.filter, /blur\(18px\)/);
    assert.equal(s.overlay, false);
    assert.equal(s.modal, null);

    await page.evaluate(() => __sg.plugin.commands.find(c => c.name === 'streamguard-panic').execute());
    await settle();
    assertHidden(await status(page));
    await clickText(page, '.vc-streamguard-overlay button', 'Reveal chat');
    assertHidden(await status(page));
    await clickText(page, '[data-mock-modal] button', 'Continue');
    assert.equal((await status(page)).hidden, 'false');
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: [] }; });
    await stream(page, 'STREAM_DELETE');
    assertInactive(await status(page));
    await page.evaluate(k => { __sg.config.snapshot = { activeStreams: [[k, { ownerId: 'me' }]] }; }, key);
    await stream(page, 'STREAM_CREATE');
    s = await status(page);
    assertHidden(s);
    assert.equal(s.row, 'hidden', 'the end of the previous stream revoked the reveal');
    assert.equal(s.modal, null, 'a fresh stream must not auto-reveal or auto-approve');
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: [] }; });
    await stream(page, 'STREAM_DELETE');
    assertInactive(await status(page));
});

test('unknown account starts protected, then refreshes when the account becomes known', async t => {
    const page = await pageFor(t, { meId: null, snapshot: snapshot() });
    await start(page);
    assertHidden(await status(page));
    const toasts = await page.evaluate(() => __sg.toasts.map(t => t.text));
    assert.ok(toasts.some(text => text.includes('could not verify active streams')));
    await page.evaluate(() => { __sg.config.meId = 'me'; __sg.userStore.emit(); });
    await settle();
    assertInactive(await status(page));
});

test('bad snapshot starts protected and latches fail-safe despite a later empty snapshot', async t => {
    const page = await pageFor(t, { snapshot: { activeStreams: {} } });
    await start(page);
    assertHidden(await status(page));
    assert.ok((await page.evaluate(() => __sg.toasts.map(t => t.text))).some(text => text.includes('could not verify active streams')));
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: [] }; __sg.streamStore.emit(); });
    await settle();
    assertHidden(await status(page));
    await page.evaluate(() => __sg.plugin.commands.find(c => c.name === 'streamguard').execute());
    await settle();
    assertHidden(await status(page));
});

test('invalid stream snapshot cannot reconcile away a known active stream', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key) });
    await start(page);
    assertHidden(await status(page));
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: 'bad' }; __sg.streamStore.emit(); });
    await settle();
    assertHidden(await status(page));
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: [] }; __sg.streamStore.emit(); });
    await settle();
    assertHidden(await status(page));
});

test('missing stop action and notification suppression warn without exposing the mock chat', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key), stopUnavailable: true, settings: { safetyMode: 'stop' } });
    await start(page);
    await clickText(page, '.vc-streamguard-overlay button', 'Reveal chat');
    assertHidden(await status(page));
    const toasts = await page.evaluate(() => __sg.toasts.map(t => t.text));
    assert.ok(toasts.some(text => text.includes('cannot suppress DM notifications')));
    assert.ok(toasts.some(text => text.includes('stop-sharing action is unavailable')));
    assert.deepEqual(await page.evaluate(() => __sg.stopRequests), []);
});

test('missing stylesheet triggers fail-safe, stop request, and latched concealment', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key) });
    await start(page);
    assertHidden(await status(page));
    await page.evaluate(() => {
        document.querySelector('[data-test-real-css]').remove();
        // CSS in <head> is not observed; a Discord body mutation causes a new verification.
        document.body.appendChild(document.createElement('div'));
    });
    await settle();
    let s = await status(page);
    assert.equal(s.active, 'true');
    assert.equal(s.hidden, 'true');
    assert.match(s.header.filter, /blur\(18px\)/, 'generated strength style is still present');
    assert.equal(s.friends.userSelect, 'auto', 'stylesheet removal actually degraded protection');
    assert.deepEqual(await page.evaluate(() => __sg.stopRequests), [key]);
    assert.ok((await page.evaluate(() => __sg.toasts.map(t => t.text))).some(text => text.includes('could not verify the privacy layer')));
    await clickText(page, '.vc-streamguard-overlay button', 'Reveal chat');
    assert.equal((await status(page)).hidden, 'true');
    assert.ok((await page.evaluate(() => __sg.toasts.map(t => t.text))).some(text => text.includes('fail-safe mode')));
    await page.evaluate(() => { __sg.config.snapshot = { activeStreams: [] }; });
    await stream(page, 'STREAM_DELETE');
    s = await status(page);
    assert.equal(s.active, 'true', 'fail-safe remains latched after stream end');
    assert.equal(s.hidden, 'true');
});

test('repeated start/stop restores DOM, listeners, input, and leaves no observer/render loop', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key) });
    for (let cycle = 0; cycle < 3; cycle++) {
        await start(page);
        assertHidden(await status(page));
        let m = await page.evaluate(() => ({
            listeners: [__sg.userStore, __sg.channelStore, __sg.selectedStore, __sg.streamStore].map(s => s.listenerCount()),
            observers: __metrics.activeObservers, created: __sg.rootsCreated, unmounted: __sg.rootsUnmounted,
            frames: __metrics.frames
        }));
        assert.deepEqual(m.listeners, [1, 1, 1, 1]);
        assert.equal(m.observers, 1);
        assert.equal(m.created - m.unmounted, 2);
        await new Promise(resolve => setTimeout(resolve, 220));
        const laterFrames = await page.evaluate(() => __metrics.frames);
        assert.ok(laterFrames - m.frames <= 1, `unexpected continuing animation-frame verification loop: ${laterFrames - m.frames}`);
        await page.evaluate(() => __sg.plugin.stop());
        await settle();
        m = await page.evaluate(() => ({
            listeners: [__sg.userStore, __sg.channelStore, __sg.selectedStore, __sg.streamStore].map(s => s.listenerCount()),
            observers: __metrics.activeObservers, created: __sg.rootsCreated, unmounted: __sg.rootsUnmounted,
            hosts: document.querySelectorAll('.vc-streamguard-overlay, .vc-streamguard-pill').length,
            marks: document.querySelectorAll('[data-vc-streamguard-scope], [data-vc-streamguard-chat], [data-vc-streamguard-ready]').length,
            strengthStyles: document.querySelectorAll('[data-vc-streamguard-style]').length,
            bodyActive: document.body.hasAttribute('data-vc-streamguard-active'),
            acceptsInput: document.getElementById('input').dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true }))
        }));
        assert.deepEqual(m.listeners, [0, 0, 0, 0]);
        assert.equal(m.observers, 0);
        assert.equal(m.created, m.unmounted);
        assert.equal(m.hosts, 0);
        assert.equal(m.marks, 0);
        assert.equal(m.strengthStyles, 0);
        assert.equal(m.bodyActive, false);
        assert.equal(m.acceptsInput, true);
        assert.equal((await status(page)).header.filter, 'none');
    }
});

test('new mock chat content is protected and temporary typing override is restored', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key), settings: { allowTyping: true } });
    await page.evaluate(() => document.getElementById('composer').style.setProperty('pointer-events', 'none', 'important'));
    await start(page);
    assert.equal(await page.$eval('#composer', el => el.style.getPropertyValue('pointer-events')), 'auto');
    await page.evaluate(() => {
        const div = document.createElement('div'); div.id = 'late-sensitive'; div.textContent = 'new private content';
        document.getElementById('chat').appendChild(div);
    });
    await settle();
    assert.match(await page.$eval('#late-sensitive', el => getComputedStyle(el).filter), /blur\(18px\)/);
    await page.evaluate(() => __sg.plugin.stop());
    assert.equal(await page.$eval('#composer', el => el.style.getPropertyValue('pointer-events')), 'none');
    assert.equal(await page.$eval('#composer', el => el.style.getPropertyPriority('pointer-events')), 'important');
    assert.equal(await page.$eval('#late-sensitive', el => getComputedStyle(el).filter), 'none');
});

test('context-menu actions and changed blur settings operate through real plugin hooks', async t => {
    const page = await pageFor(t, { snapshot: snapshot(key), settings: { safetyMode: 'nothing' } });
    await start(page);
    let menu = await page.evaluate(() => {
        const items = [];
        __sg.plugin.contextMenus['channel-context'](items, { channel: __sg.channels['100'] });
        window.__menuItems = items;
        return items.map(item => ({ id: item.props.id, label: item.props.label }));
    });
    assert.deepEqual(menu, [{ id: 'vc-streamguard-toggle-chat', label: 'Reveal chat' }]);
    await page.evaluate(() => __menuItems[0].props.action());
    await settle();
    let s = await status(page);
    assert.equal(s.hidden, 'false');
    assert.equal(s.header.filter, 'none');
    assert.match(s.list.filter, /blur\(18px\)/);
    menu = await page.evaluate(() => {
        const items = [];
        __sg.plugin.contextMenus['channel-context'](items, { channel: __sg.channels['100'] });
        window.__menuItems = items;
        return items.map(item => item.props.label);
    });
    assert.deepEqual(menu, ['Hide chat']);
    await page.evaluate(() => __menuItems[0].props.action());
    await settle();
    assertHidden(await status(page));
    await page.evaluate(() => {
        __sg.settings.store.blurServers = true;
        __sg.settings.store.blurStrength = 99;
        __sg.settings.definitions.blurServers.onChange();
    });
    await settle();
    s = await status(page);
    assert.match(s.servers.filter, /blur\(30px\)/);
    assert.match(s.messages.filter, /blur\(30px\)/, 'blur strength is clamped');
});
