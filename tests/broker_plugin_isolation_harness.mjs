// Headless harness for Broker's shared plugin host runtime skeleton.
//
// Loads the real Broker runtime artifact + Apps glue from dist/index.html and
// verifies: visible Apps entry points, shared _host-runtime invariants, bundled
// pack integrity/fail-closed behavior, and no Broker token/domain data crossing
// into the sandboxed plugin frame.
//
//   node tests/broker_plugin_isolation_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TextEncoder } from 'node:util';
import { runIsolationContract } from '../../skipi-plugins/_host-runtime/harness/isolation-contract.mjs';
import { installFakeDom } from '../../skipi-plugins/_host-runtime/harness/fake-dom.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8');
const RUST_SOURCE = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const RUNTIME_SOURCE = fs.readFileSync(path.join(ROOT, 'dist', 'plugin-host-bridge.js'), 'utf8');
const SHARED_RUNTIME_SOURCE = fs.readFileSync('/home/linux/Developer/skipi-plugins/_host-runtime/dist/plugin-host-bridge.js', 'utf8');
const RUNTIME_VERSION = fs.readFileSync('/home/linux/Developer/skipi-plugins/_host-runtime/dist/RUNTIME_VERSION', 'utf8').trim();
const EXPECTED_RUNTIME_VERSION = '1.0.1';
const EXPECTED_RUNTIME_SHA = 'edd0ba5f8b21f05fcf55485b13b1dafc963173b2d2aa79e261611297283c307a';

try { if (!globalThis.crypto) globalThis.crypto = webcrypto; } catch (_) {}
try { if (!globalThis.TextEncoder) globalThis.TextEncoder = TextEncoder; } catch (_) {}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const section = (t) => console.log('\n# ' + t);
const tick = () => new Promise((r) => setTimeout(r, 0));

function extractAppsBlock() {
  const start = HTML.indexOf('// ===================== Apps / Plugin host');
  const end = HTML.indexOf('// ---------- Identity badge ----------', start);
  if (start < 0 || end < 0) throw new Error('Broker Apps/plugin block not found');
  return HTML.slice(start, end);
}

function extractCounterpartiesBlock() {
  const start = HTML.indexOf('// ---------- View 🤝 Контрагенты');
  const end = HTML.indexOf('function renderSignalsBrowse', start);
  if (start < 0 || end < 0) throw new Error('Broker Counterparties block not found');
  return HTML.slice(start, end);
}

function extractPartnersOpenBlock() {
  const start = HTML.indexOf("if(name === 'partners')");
  const end = HTML.indexOf('// 📧 Почта', start);
  if (start < 0 || end < 0) throw new Error('Broker partners-open block not found');
  return HTML.slice(start, end);
}

function extractThemeBlock() {
  const start = HTML.indexOf('// ---------- Theme ----------');
  const end = HTML.indexOf('// ===================== Apps / Plugin host', start);
  if (start < 0 || end < 0) throw new Error('Broker theme block not found');
  return HTML.slice(start, end);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
}

function makeSharedLoader(slug, permissions) {
  const js = "/* SKIPI_FIXTURE_PLUGIN BROKER */ window.SkipiPlugins=window.SkipiPlugins||{};"
    + "window.SkipiPlugins['" + slug + "']={manifest:{id:'" + slug + "'},mount:function(){},unmount:function(){}};";
  return {
    async install() {
      return {
        ok: true,
        source: 'broker-shared-contract-fixture',
        pack: {
          id: slug,
          name: 'Broker Fixture',
          version: '0.0.0',
          supported_hosts: ['broker'],
          entrypoints: { ui: 'index.js', style: 'index.css' },
          files: { 'index.js': js, 'index.css': '/* broker fixture */' },
          permissions: permissions.slice(),
          distribution: { mode: 'bundled_first_party', remote_code: false },
          network: 'none',
          data_access: 'none',
        },
      };
    },
  };
}

function makeSharedHost() {
  const key = (slug, k) => 'skipi_plugin_' + slug + '_' + k;
  return {
    id: 'broker',
    storage: {
      get: (slug, k) => globalThis.localStorage.getItem(key(slug, k)),
      set: (slug, k, v) => globalThis.localStorage.setItem(key(slug, k), String(v)),
      remove: (slug, k) => globalThis.localStorage.removeItem(key(slug, k)),
    },
    theme: { get: () => 'light', subscribe: () => () => {} },
    navigation: { setTitle: () => {}, closePlugin: () => {} },
  };
}

const appsBlock = extractAppsBlock();
const counterpartiesBlock = extractCounterpartiesBlock();
const partnersOpenBlock = extractPartnersOpenBlock();

section('shared _host-runtime isolation contract');
const shared = await runIsolationContract({
  runtimeSource: RUNTIME_SOURCE,
  slug: 'broker-host-demo',
  secretKey: 'skipi_broker_bearer_token',
  secretVal: 'SECRET-BROKER-BEARER-TOKEN-DO-NOT-LEAK',
  makeLoader: (perms) => makeSharedLoader('broker-host-demo', perms),
  makeHost: makeSharedHost,
});
pass += shared.pass;
fail += shared.fail;

section('static Broker host glue');
ok(HTML.includes('<script src="plugin-host-bridge.js"></script>'), 'Broker loads shared runtime as a file artifact');
ok(RUNTIME_SOURCE === SHARED_RUNTIME_SOURCE, 'Broker runtime file is byte-identical to shared _host-runtime artifact');
ok(RUNTIME_VERSION === EXPECTED_RUNTIME_VERSION + '\nsha256:' + EXPECTED_RUNTIME_SHA, 'shared RUNTIME_VERSION is the expected 1.0.1 artifact');
ok(HTML.includes('id="nav-apps"') && /showView\('apps'\)/.test(HTML), 'desktop Apps tab remains reachable');
ok(HTML.includes('id="mrail-apps"') && /mobileSwitchView\('apps'\)/.test(HTML), 'mobile bottom Apps rail item remains reachable');
ok(HTML.includes('id="nav-dedup"') && /id="nav-dedup"[^>]*showView\('dedup'\)/.test(HTML), 'desktop Deduplicator tab remains reachable');
ok(HTML.includes('id="nav-partners"') && /id="nav-partners"[^>]*showView\('partners'\)/.test(HTML), 'desktop Counterparties tab remains reachable');
ok(!/id="nav-dedup"[^>]*(?:display\s*:\s*none|internal-tool)/.test(HTML), 'desktop Deduplicator tab is not hidden as an internal-only tool');
ok(!/id="nav-partners"[^>]*(?:display\s*:\s*none|internal-tool)/.test(HTML), 'desktop Counterparties tab is not hidden as an internal-only tool');
ok(HTML.includes('id="mrail-dedup"') && /mobileSwitchView\('dedup'\)/.test(HTML), 'mobile bottom Deduplicator rail item remains reachable');
ok(HTML.includes('id="mrail-partners"') && /mobileSwitchView\('partners'\)/.test(HTML), 'mobile bottom Counterparties rail item remains reachable');
ok(/dedup:\s*\{\s*pane:'view-dedup',\s*btn:'mrail-dedup'\s*\}/.test(HTML), 'mobile router maps Deduplicator to its view pane');
ok(/partners:\s*\{\s*pane:'view-partners',\s*btn:'mrail-partners'\s*\}/.test(HTML), 'mobile router maps Counterparties to its view pane');
ok(/id="view-apps"/.test(HTML), 'Apps view pane exists');
ok(/fn sanitize_public_signals/.test(RUST_SOURCE) && /PRIVATE_SIGNAL_KEYS/.test(RUST_SOURCE), 'normal Broker signal sanitizer remains in place');
ok(!/id="signals-cargo-counterpart"/.test(HTML) && !/id="signals-tonnage-counterpart"/.test(HTML), 'normal Signals view still has no counterpart filter dropdowns');
ok(/fetch_counterparts/.test(counterpartiesBlock) || /counterpartsCRM/.test(counterpartiesBlock), 'Counterparties uses the dedicated counterparts profile model');
ok(!/posted_by_email|posted_by_name/.test(counterpartiesBlock), 'Counterparties no longer derives rows from stripped source fields');
ok(!/partnersOpenSignalsFor|_populateCounterpartDropdowns|signals-.*-counterpart/.test(counterpartiesBlock), 'Counterparties has no dead jump to removed Signals counterpart filters');
ok(/refreshCounterpartsCRM/.test(partnersOpenBlock) && !/refreshSignalsBrowse/.test(partnersOpenBlock), 'opening Counterparties refreshes CRM profiles, not normal Signals');
ok(/BROKER_PLUGIN_HOST_RUNTIME_VERSION\s*=\s*'1\.0\.1'/.test(appsBlock), 'Broker records shared runtime version');
ok(/BROKER_PLUGIN_HOST_RUNTIME_SHA256\s*=\s*'edd0ba5f8b21f05fcf55485b13b1dafc963173b2d2aa79e261611297283c307a'/.test(appsBlock), 'Broker records shared runtime sha256');
ok(/SkipiPluginRuntime\.create/.test(appsBlock) && /rt\.open\(id, c\)/.test(appsBlock), 'Broker mount path uses shared runtime open()');
ok(!/function brokerHostApi/.test(appsBlock) && !/reg\.mount\(c/.test(appsBlock), 'no old inline host API or direct reg.mount path');
ok(!/function\s+renderAppsView\(\)\s*\{\s*brokerAppsState\s*=/.test(appsBlock), 'renderAppsView preserves Apps detail/host substate');
ok(/state\.view === 'apps' && name !== 'apps'\) brokerAppsResetToList\(\)/.test(HTML), 'leaving Apps explicitly unmounts and resets the plugin host');
ok(/enabled:true/.test(appsBlock.replace(/\s/g, '')), 'bundled runtime is enabled for the local Apps path');
ok(!/noCsp\s*:/.test(appsBlock), 'production runtime config does not enable noCsp');
ok(!/permissions\s*:\s*\[[^\]]*(broker|bazaar|match|signal|case|mail|team|contact|counterparty|token|device|pairing|chat)/i.test(appsBlock), 'demo plugin grants no Broker domain/token permissions');
ok(/connect-src 'none'/.test(RUNTIME_SOURCE), "runtime frame CSP forbids direct network with connect-src 'none'");
ok(/setAttribute\('sandbox', 'allow-scripts'\)/.test(RUNTIME_SOURCE) && !/allow-scripts allow-same-origin/.test(RUNTIME_SOURCE), 'runtime sandbox is allow-scripts only');

section('real Broker bundled loader fail-closed behavior');
const ctx = installFakeDom();
new Function(RUNTIME_SOURCE)();
const M = new Function('showToast', 'esc',
  appsBlock + '\nreturn {'
  + 'BROKER_PLUGIN_HOST_RUNTIME_VERSION, BROKER_PLUGIN_HOST_RUNTIME_SHA256, BROKER_PLUGIN_BUNDLES,'
  + 'brokerBundledLoader, brokerClonePack, brokerInstallBundledPack, brokerPluginRuntime'
  + '};')(() => {}, esc);

ok(M.BROKER_PLUGIN_HOST_RUNTIME_VERSION === EXPECTED_RUNTIME_VERSION, 'Broker records shared runtime version ' + EXPECTED_RUNTIME_VERSION);
ok(M.BROKER_PLUGIN_HOST_RUNTIME_SHA256 === EXPECTED_RUNTIME_SHA, 'Broker records shared runtime sha256');

const installed = await M.brokerBundledLoader.install('broker-host-demo');
ok(installed && installed.ok && installed.pack.files['index.js'].includes('BROKER_HOST_DEMO_PLUGIN'), 'known demo plugin installs from verified bundled bytes');
ok(installed && installed.pack.permissions.join(',') === 'local_storage,theme', 'demo grants only local_storage and theme');

const unknown = await M.brokerBundledLoader.install('missing-plugin');
ok(unknown && unknown.ok === false && unknown.stage === 'install', 'unknown plugin is fail-closed at install');

const missingManifest = await M.brokerInstallBundledPack('broker-host-demo', { id: 'broker-host-demo' }, 'test:bad-manifest');
ok(missingManifest && missingManifest.ok === false && missingManifest.stage === 'manifest', 'missing manifest/entrypoints fail closed');

const badGrant = M.brokerClonePack(M.BROKER_PLUGIN_BUNDLES['broker-host-demo']);
badGrant.permissions = ['broker.token.read'];
const grantDenied = await M.brokerInstallBundledPack('broker-host-demo', badGrant, 'test:bad-grant');
ok(grantDenied && grantDenied.ok === false && grantDenied.stage === 'policy', 'broker/token-style grants are denied');

const tampered = M.brokerClonePack(M.BROKER_PLUGIN_BUNDLES['broker-host-demo']);
tampered.files['index.js'] += '\n// tamper';
const badIntegrity = await M.brokerInstallBundledPack('broker-host-demo', tampered, 'test:tampered');
ok(badIntegrity && badIntegrity.ok === false && badIntegrity.stage === 'integrity', 'tampered plugin byte fails integrity before mount');

section('demo plugin mounts only through the sandbox runtime');
const TOKEN = 'SECRET-BROKER-TEAM-TOKEN-DO-NOT-LEAK';
ctx.store.set('skipi-broker-token', TOKEN);
ctx.store.set('skipi_broker_bearer_token', TOKEN);
const rt = M.brokerPluginRuntime();
const mountEl = ctx.makeMountEl();
const opened = rt.open('broker-host-demo', mountEl);
const ifr = mountEl._child;
ok(ifr && ifr._tag === 'iframe', 'runtime created an iframe for the demo plugin');
ok(ifr.attrs.sandbox === 'allow-scripts', 'demo iframe sandbox="allow-scripts"');
ok(!/allow-same-origin/.test(ifr.attrs.sandbox || ''), 'demo iframe has no allow-same-origin');
ok(/default-src 'none'/.test(ifr.srcdoc) && /connect-src 'none'/.test(ifr.srcdoc), 'demo iframe srcdoc has strict CSP and no direct network');
ok(!ifr.srcdoc.includes(TOKEN), 'Broker bearer/team token is not present in demo iframe srcdoc');
const token = JSON.parse(ifr.srcdoc.match(/__SKIPI_TOKEN__=("[0-9a-f]+")/)[1]);

ctx.framePosts.length = 0;
for (let i = 0; i < 8; i++) await tick();
ctx.emit({ ch: 'skipi-plugin', v: 1, token, type: 'ready' });
let init = null;
for (let i = 0; i < 8; i++) {
  await tick();
  init = ctx.framePosts.find((m) => m.type === 'init');
  if (init) break;
}
ok(!!init, 'host sends init to the sandbox frame after integrity verification');
ok(init && init.hostId === 'broker', 'init exposes only non-secret host id');
ok(init && init.js.includes('BROKER_HOST_DEMO_PLUGIN'), 'init carries demo plugin JS to the frame, not the host document');
ok(init && !JSON.stringify(init).includes(TOKEN), 'init message contains no Broker bearer/team token');

ctx.framePosts.length = 0;
ctx.emit({ ch: 'skipi-plugin', v: 1, token, type: 'storage.set', key: 'opens', value: '7' });
ctx.emit({ ch: 'skipi-plugin', v: 1, token, type: 'storage.get', id: 77, key: 'opens' });
await tick();
const got = ctx.framePosts.find((m) => m.type === 'storage.result' && m.id === 77);
ok(got && got.value === '7', 'demo storage round-trips through the bridge');
ok(ctx.store.get('skipi_broker_plugin_broker-host-demo_opens') === '7', 'demo storage is host-side and plugin-scoped');
ok(ctx.store.get('skipi-broker-token') === TOKEN && ctx.store.get('skipi_broker_bearer_token') === TOKEN, 'demo storage did not touch Broker bearer/team token');

ctx.emit({ ch: 'skipi-plugin', v: 1, token, type: 'mounted', height: 240, selfcheck: { parentDomAccess: false, storageBlocked: true, fetchBlocked: true } });
const mounted = await opened;
ok(mounted && mounted.ok && mounted.selfcheck.fetchBlocked === true, 'demo open resolves after frame self-check reports network blocked');

let navCloseError = null;
try { ctx.emit({ ch: 'skipi-plugin', v: 1, token, type: 'nav.close' }); } catch (e) { navCloseError = e; }
await tick();
ok(!navCloseError, 'plugin nav.close does not throw after host-side close/unmount');
ok(rt._active() === null, 'plugin nav.close tears down the active frame');

section('fresh-install light theme defaults');

const themeBlock = extractThemeBlock();

function makeThemeEnv(saved, osPrefersLight) {
  const store = new Map();
  if (saved != null) store.set('skipi-broker-theme', saved);
  const mediaQueries = [];
  const docEl = {
    attrs: new Map([['data-theme', 'light']]),
    style: { setProperty() {} },
    setAttribute(k, v) { this.attrs.set(k, v); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
  };
  return {
    store, mediaQueries, docEl,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    window: {
      matchMedia(q) {
        mediaQueries.push(q);
        const wantsLight = q.indexOf('light') !== -1;
        return { matches: wantsLight ? !!osPrefersLight : !osPrefersLight };
      },
    },
    document: { documentElement: docEl },
  };
}

function loadThemeApi(env) {
  return new Function('window', 'document', 'localStorage', 'renderSettingsBody',
    themeBlock + '\nreturn { applyTheme: applyTheme, setTheme: setTheme };')(
    env.window, env.document, env.localStorage, function () {});
}

ok(HTML.includes('<html lang="ru" data-theme="light">'), 'static markup boots with data-theme="light" before any JS runs');
ok(HTML.indexOf('[data-theme="light"] {') > HTML.indexOf(':root, [data-theme="dark"] {'), 'light token block overrides the shared :root/dark token block for the static light attribute');
ok(/async function boot\(\)\{\s*applyTheme\(\);/.test(HTML), 'boot() applies the theme first, before settings/backend calls');

const freshDarkOs = makeThemeEnv(null, false);
loadThemeApi(freshDarkOs).applyTheme();
ok(freshDarkOs.docEl.getAttribute('data-theme') === 'light', 'fresh empty localStorage resolves to light');
ok(freshDarkOs.mediaQueries.length === 0, 'fresh install never consults prefers-color-scheme (OS dark cannot flip the default)');
ok(!freshDarkOs.store.has('skipi-broker-theme'), 'applyTheme does not silently persist a theme value on fresh install');

const savedDark = makeThemeEnv('dark', true);
loadThemeApi(savedDark).applyTheme();
ok(savedDark.docEl.getAttribute('data-theme') === 'dark', 'explicitly saved dark preference still starts dark');
const savedLight = makeThemeEnv('light', false);
loadThemeApi(savedLight).applyTheme();
ok(savedLight.docEl.getAttribute('data-theme') === 'light', 'explicitly saved light preference starts light');
const sysDark = makeThemeEnv('system', false);
loadThemeApi(sysDark).applyTheme();
ok(sysDark.docEl.getAttribute('data-theme') === 'dark' && sysDark.mediaQueries.length === 1, 'system is honored only as an explicit saved user choice (OS dark -> dark)');
const sysLight = makeThemeEnv('system', true);
loadThemeApi(sysLight).applyTheme();
ok(sysLight.docEl.getAttribute('data-theme') === 'light', 'explicit system choice with OS light resolves light');

const switchEnv = makeThemeEnv(null, true);
const switchApi = loadThemeApi(switchEnv);
switchApi.setTheme('dark');
ok(switchEnv.store.get('skipi-broker-theme') === 'dark' && switchEnv.docEl.getAttribute('data-theme') === 'dark', 'setTheme persists dark and applies it (dark stays available as a user choice)');
switchApi.setTheme('light');
ok(switchEnv.store.get('skipi-broker-theme') === 'light' && switchEnv.docEl.getAttribute('data-theme') === 'light', 'setTheme switches back to light');

ok(HTML.includes("var cur = localStorage.getItem('skipi-broker-theme') || 'light';"), 'settings theme picker resolves fresh install to light');
ok(HTML.includes("['dark','light','system'].map") && HTML.includes("(cur===x?'checked':'')"), 'picker keeps dark/light/system options and checks the resolved value (light on fresh)');
ok(!/'skipi-broker-theme'\)\s*\|\|\s*'(?:dark|system)'/.test(HTML), 'no code path falls back to dark or system for the theme key');
ok((HTML.match(/setItem\('skipi-broker-theme'/g) || []).length === 1, 'only the explicit setTheme user action writes the theme key (nothing seeds dark/system)');
ok((HTML.match(/prefers-color-scheme/g) || []).length === 1 && /t==='system'/.test(themeBlock), 'prefers-color-scheme is consulted only inside the explicit system branch');

const curThemeSrc = (HTML.match(/function brokerCurrentTheme\(\)\{[^\n]*\}/) || [''])[0];
ok(!!curThemeSrc, 'brokerCurrentTheme (plugin host theme source) is present');
const curTheme = (attr) => new Function('document', curThemeSrc + '\nreturn brokerCurrentTheme();')({ documentElement: { getAttribute: () => attr } });
ok(curTheme('light') === 'light', 'plugin host theme bridge reports light on fresh launch');
ok(curTheme(null) === 'light', 'plugin host theme source fails open to light, never dark, if the attribute is missing');
ok(curTheme('dark') === 'dark', 'plugin host theme bridge still reports an explicit dark preference');
ok(/theme:\{\s*get: brokerCurrentTheme,/.test(HTML), 'host glue always supplies theme.get (shared runtime dark fallback is unreachable in Broker)');
ok(RUNTIME_SOURCE.includes('theme: themeApi.get()'), 'runtime init message always carries the host-resolved theme to the plugin frame');
ok(themeBlock.includes('brokerPluginNotifyTheme'), 'applyTheme pushes every resolved theme change to plugin subscribers');

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
