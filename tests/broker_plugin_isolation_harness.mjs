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
ok(/id="view-apps"/.test(HTML), 'Apps view pane exists');
ok(/BROKER_PLUGIN_HOST_RUNTIME_VERSION\s*=\s*'1\.0\.1'/.test(appsBlock), 'Broker records shared runtime version');
ok(/BROKER_PLUGIN_HOST_RUNTIME_SHA256\s*=\s*'edd0ba5f8b21f05fcf55485b13b1dafc963173b2d2aa79e261611297283c307a'/.test(appsBlock), 'Broker records shared runtime sha256');
ok(/SkipiPluginRuntime\.create/.test(appsBlock) && /rt\.open\(id, c\)/.test(appsBlock), 'Broker mount path uses shared runtime open()');
ok(!/function brokerHostApi/.test(appsBlock) && !/reg\.mount\(c/.test(appsBlock), 'no old inline host API or direct reg.mount path');
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

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
