// Execute the shipped Demo capability and its actual early-script/boot callers.
// No real browser profile, API, IPC, or credentials are used by this harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const demoPath = path.join(root, 'dist/broker-demo.js');
assert.ok(fs.existsSync(demoPath), 'shared synthetic Demo capability exists');
const source = fs.readFileSync(demoPath, 'utf8');
const firstInline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
assert.ok(html.indexOf('<script src="broker-demo.js"></script>') < html.indexOf('<script>'), 'capability loads before the first inline script');
// The old credential is compared in memory only. Never print it, including in
// an assertion's actual/expected values or a failure diff.
const oldHtml = execFileSync('git', ['show', '0b06d0a0fcd06c9c6ac7b07bcaf5c70f09c62027:dist/index.html'], { cwd: root, encoding: 'utf8' });
const oldCredential = oldHtml.match(/var DEMO_BROKER_ID = '([^']+)'/)[1];
assert.ok(![html, source].some(s => s.includes(oldCredential)), 'legacy server Demo credential removed from shipped source');
assert.match(firstInline, /const localStorage\s*=/, 'page-wide host storage binding is immutable');
assert.equal((html.match(/window\.localStorage\b/g) || []).length, 1, 'the real storage getter has a single guarded acquisition site');

function fixture({ url = 'https://broker.skipi.app/app/broker/desktop/demo/', demo = true, module = true, inline = firstInline, storageDenied = false } = {}) {
  const counts = { native: 0, storage: 0, network: 0, auth: 0, boot: 0, navigations: [], requests: [] };
  const stored = new Map([['private-profile', 'PRIVATE-PROFILE-CANARY'], ['skipi-broker-cases-v1', 'PRIVATE-CASE-CANARY']]);
  const before = JSON.stringify([...stored]);
  const listeners = [];
  const location = new URL(url);
  location.assign = value => counts.navigations.push(String(value));
  const document = {
    baseURI: url, title: '', documentElement: { lang: '', getAttribute() { return 'light'; }, setAttribute() {} },
    body: { classList: { toggle() {}, add() {} }, appendChild() {} },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    querySelectorAll() { return []; }, getElementById() { return null; },
  };
  const ctx = {
    console, URL, Date, Promise, Object, JSON, Error, Set, Map, document, location,
    __SKIPI_BROKER_DEMO__: demo,
    navigator: { userAgent: 'Desktop fixture', clipboard: { writeText() { counts.native++; } }, sendBeacon() { counts.network++; return true; } },
    localStorage: { getItem(k) { counts.storage++; return stored.get(k) || null; }, setItem(k, v) { counts.storage++; stored.set(k, v); }, removeItem(k) { counts.storage++; stored.delete(k); } },
    fetch: async (u, o) => { counts.network++; counts.requests.push([String(u), o]); return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }; },
    __TAURI__: { core: { invoke: async () => { counts.native++; return { broker_id: 'PRIVATE-PROFILE-CANARY' }; } } },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    addEventListener() {}, matchMedia() { return { matches: false }; },
  };
  ctx.window = ctx;
  if (storageDenied) {
    // Model Window separately: Node's contextified-global accessor handling
    // differs from browser Window when a getter throws during lexical binding.
    ctx.window = { ...ctx };
    Object.defineProperty(ctx.window, 'localStorage', { configurable: true, get() { counts.storage++; throw new Error('SecurityError: storage unavailable'); } });
  }
  vm.createContext(ctx);
  if (module) vm.runInContext(source, ctx);
  vm.runInContext(inline, ctx);
  return { ctx, counts, listeners, before, after: () => JSON.stringify([...stored]) };
}

let f = fixture();
assert.equal(f.ctx.tr('map.mode'), 'Mode', 'the English default includes the visible Map controls');
assert.equal(f.ctx.tr('rail.map'), 'Map');
assert.equal(f.ctx.tr('status.coverage'), 'Coverage');
const russian = fixture({ url: 'https://broker.skipi.app/app/broker/desktop/demo/?lang=ru' });
assert.equal(russian.ctx.tr('map.mode'), 'Режим', 'an explicit Russian choice is preserved without profile storage');
assert.equal(f.ctx.SkipiBrokerDemo.active, true);
assert.equal(Object.isFrozen(f.ctx.SkipiBrokerDemo), true);
assert.equal(Reflect.set(f.ctx.SkipiBrokerDemo, 'active', false), false, 'the selected mode cannot be rewritten');
f.ctx.__SKIPI_BROKER_DEMO__ = false;
assert.equal(f.ctx.SkipiBrokerDemo.active, true, 'mode captured before user/profile data and never re-read');
const demo = f.ctx.SkipiBrokerDemo;
const settings = await demo.invoke('get_settings');
assert.equal(settings.bearer_token, '', 'Demo has no bearer credential');
assert.match(settings.display_name, /Demo/);
assert.equal(f.counts.native, 0);
assert.equal(f.counts.storage, 0, 'early script does not read the existing browser profile');
for (const command of ['save_settings', 'send_mail', 'publish_cargo', 'register_broker', 'validate_broker_token', 'record_app_diagnostic', 'ping_team_presence', 'plugin:updater|check', 'open_external', 'unknown_future_command', 'toString']) {
  await assert.rejects(demo.invoke(command, { token: 'PRIVATE-CANARY' }), /Demo/);
}
const cargo = await demo.invoke('fetch_bazaar_signal_list', { kind: 'cargo' });
const tonnage = await demo.invoke('fetch_bazaar_signal_list', { kind: 'tonnage' });
const pairs = await demo.invoke('fetch_bazaar_pairs');
assert.ok(cargo.length >= 6 && tonnage.length >= 6 && pairs.length >= 6, 'synthetic geography is populated');
assert.ok(cargo.every(c => Date.now() - Date.parse(c.first_seen_at) < 6 * 3600000), 'fixture age remains within map filters at every launch');
cargo[0].title = 'MUTATED';
assert.notEqual((await demo.invoke('fetch_bazaar_signal_list', { kind: 'cargo' }))[0].title, 'MUTATED', 'read results are isolated copies');
demo.storage.setItem('private-profile', 'DEMO-ONLY');
assert.equal(demo.storage.getItem('private-profile'), 'DEMO-ONLY');
assert.equal(f.before, f.after());
assert.equal(f.counts.storage, 0);
assert.throws(() => vm.runInContext('localStorage = window.localStorage', f.ctx), /constant/i, 'host code cannot replace the selected storage');

for (const [url, options] of [
  ['/app/broker/desktop/api/signals', {}], ['https://api.skipi.app/api/signals', {}],
  ['leaflet/world.geojson', { method: 'POST' }], ['leaflet/world.geojson?private=1', {}],
  ['../leaflet/world.geojson', {}], ['https://other.invalid/world.geojson', {}],
]) await assert.rejects(f.ctx.fetch(url, options), /Demo/);
assert.equal(f.counts.network, 0);
await f.ctx.fetch('leaflet/world.geojson');
assert.equal(f.counts.network, 1, 'only the fixed bundled geography GET reaches fetch');
assert.equal(f.counts.requests[0][1].credentials, 'omit');
await f.ctx.fetch('msi/warnings.geojson');
assert.equal(f.counts.network, 1, 'MSI is synthetic, without a live request');

// Execute the actual early invoke setup: loadBuildInfo must not rebind to the
// native function even if Tauri is present or arrives after the Demo module.
const bridge = html.slice(html.indexOf('// ---------- Tauri bridge ----------'), html.indexOf('// ---------- Global state ----------'));
vm.runInContext(bridge, f.ctx);
await f.ctx.loadBuildInfo();
assert.equal(f.counts.native, 0, 'metadata rebind cannot escape Demo');
f.ctx.__TAURI__ = { core: { invoke: async () => { f.counts.native++; return {}; } } };
await f.ctx.loadBuildInfo();
assert.equal(f.counts.native, 0, 'a later injected native bridge cannot escape Demo');
for (const { type, fn } of f.listeners) if (type === 'DOMContentLoaded') fn();
assert.equal(f.counts.storage, 0, 'DOMContentLoaded cannot read/migrate real local data');
assert.equal(f.before, f.after());

const boot = html.slice(html.indexOf('async function boot(){'), html.indexOf('async function refreshAll(){'));
Object.assign(f.ctx, {
  state: { settings: {} }, applyTheme() {}, startAppDiagnostics() {}, showToast() {},
  _authGateHide() {}, _authGateShow() {}, refreshIdentityBadge() {},
  _authGateValidate: async () => { f.counts.auth++; return true; },
  _bootContinue: async () => { f.counts.boot++; },
});
vm.runInContext(boot, f.ctx);
await f.ctx.boot();
assert.equal(f.counts.auth, 0, 'Demo boot does not validate a real identity');
assert.equal(f.counts.native, 0);
assert.equal(f.counts.boot, 1);
const entry = html.slice(html.indexOf('async function _authEnterDemo(){'), html.indexOf('async function _authGateSubmit(){'));
vm.runInContext(entry, f.ctx);
await f.ctx._exitDemo();
assert.equal(f.counts.navigations.at(-1), '/app/broker/desktop/');
assert.equal(f.before, f.after(), 'Demo exit preserves real profile bytes');
assert.equal(f.counts.native, 0, 'exit never clears/saves native settings');

f = fixture({ url: 'https://broker.skipi.app/app/broker/desktop/?demo=1', demo: false });
assert.equal(f.ctx.SkipiBrokerDemo.active, false, 'web query parameter does not select Demo');
f = fixture({ url: 'https://tauri.localhost/index.html?demo=1', demo: false });
assert.equal(f.ctx.SkipiBrokerDemo.active, true, 'native reload enters the same isolated capability');
f.ctx.SkipiBrokerDemo.exit();
assert.equal(f.counts.navigations.at(-1), 'https://tauri.localhost/index.html');
assert.equal(f.before, f.after());

f = fixture({ module: false });
vm.runInContext(bridge, f.ctx);
Object.assign(f.ctx, { state: { settings: {} }, applyTheme() {}, showToast() {}, startAppDiagnostics() {}, _authGateValidate: async () => { f.counts.auth++; return true; }, _bootContinue: async () => { f.counts.boot++; } });
vm.runInContext(boot, f.ctx);
await f.ctx.boot();
assert.equal(f.counts.native, 0, 'missing Demo capability fails closed before native settings');
assert.equal(f.counts.auth, 0);
assert.equal(f.counts.boot, 0);
assert.equal(f.counts.storage, 0);

const missingMsi = fixture({ module: false });
vm.runInContext(bridge, missingMsi.ctx);
const msiProvider = html.slice(html.indexOf('function _msiLayerConfig(){'), html.indexOf('function vizToggleMsi(on){'));
vm.runInContext(msiProvider, missingMsi.ctx);
assert.equal((await missingMsi.ctx._msiLayerConfig().provider()).length, 0);
assert.equal(missingMsi.counts.network, 0, 'manual MSI provider cannot reach live data when Demo module is missing');

// A deliberate removal of the host binding must trip the same real-store
// canary oracle. This verifies the isolation test, not merely the fixture.
const unbound = fixture({ inline: firstInline.replace('const localStorage =', 'const unusedStorage =') });
unbound.ctx.getUiLang();
assert.throws(() => assert.equal(unbound.counts.storage, 0), /AssertionError/, 'negative control catches a real-profile storage read');

const deniedStorage = fixture({ demo: false, url: 'https://tauri.localhost/index.html', storageDenied: true });
assert.equal(deniedStorage.ctx.getUiLang(), 'ru', 'a denied live storage getter uses page memory without aborting boot');
deniedStorage.ctx.setUiLang('en');
assert.equal(deniedStorage.ctx.getUiLang(), 'en');
assert.equal(deniedStorage.counts.storage, 1, 'the denied live getter is acquired only once');
console.log('Broker Demo: actual early script, invoke rebind, boot, storage, commands, network and exit isolation PASS');
