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

function extractVesselsBlock() {
  const start = HTML.indexOf('// ===================== Vessels / Vessel Database Core v0');
  const end = HTML.indexOf('// ===================== end Vessels / Vessel Database Slice 1');
  if (start < 0 || end < 0) throw new Error('Broker Vessels (Vessel Database Slice 1) block not found');
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

// ===================== Vessel Database Slice 1 — read-only vessel lookup =====================
// Broker is the first consumer of the shared Vessel Database module
// (contract pin a5537e3). Slice 1 = read-only search/identity surface on
// synthetic fixture data. These checks prove: the surface exists on desktop
// and mobile, every contract QA hook renders, the adapter fails closed per
// the contract denial vocabulary, redaction never leaks licensed/forbidden
// fields, and NO attach/write path exists anywhere in the artifact.
section('Vessel Database Slice 1: static surface');
const vesselsBlock = extractVesselsBlock();
ok(/id="nav-vessels"[^>]*onclick="showView\('vessels'\)"/.test(HTML), 'desktop Vessels tab exists and routes to the vessels view');
ok(/id="mrail-vessels"[^>]*onclick="mobileSwitchView\('vessels'\)"/.test(HTML), 'mobile bottom Vessels rail item exists');
ok(/vessels:\s*\{\s*pane:'view-vessels',\s*btn:'mrail-vessels'\s*\}/.test(HTML), 'mobile router maps Vessels to its view pane');
ok(/id="view-vessels"/.test(HTML), 'Vessels view pane exists');
ok(HTML.includes('#view-vessels[data-mobile-active="1"]'), 'Vessels pane has a mobile display rule (unlike the known dedup/partners gap)');
ok(/name !== 'vessels'/.test(HTML), 'showView allowlist accepts the vessels view');
for (const hook of ['vessel-search-input', 'vessel-search-result', 'vessel-identity-card', 'vessel-provenance-chip',
                    'vessel-cache-state', 'vessel-conflict-state', 'vessel-readonly-state', 'vessel-field-locked',
                    'vessel-fail-closed']) {
  ok(HTML.includes('data-qa="' + hook + '"'), 'QA hook present: ' + hook);
}
ok(!HTML.includes('vessel-local-attach'), 'vessel-local-attach control is ABSENT everywhere (Slice 1 has no attach)');
ok(!/fetch\(|XMLHttpRequest|WebSocket|__TAURI__|invoke\(|localStorage|sessionStorage/.test(vesselsBlock), 'Vessels block makes no network/invoke/storage calls (fixture-only)');
ok(!/bazaar|counterpart|state\.team|state\.inbox|refreshMail|bearer|skipi-broker-token|case-seed|pairing/i.test(vesselsBlock), 'Vessels block has no coupling to other Broker domain modules');
ok(!/<button[^>]*(save|edit|attach)/i.test(vesselsBlock), 'Vessels UI has no save/edit/attach buttons');

section('Vessel Database Slice 1: adapter contract behavior');
const V = new Function('esc', vesselsBlock
  + '\nreturn { BROKER_VESSEL_SLICE1_GRANTS, VDB_REQUEST_CAPABILITIES, VDB_CACHE_SEMANTICS,'
  + ' VDB_SEARCH_RESULT_FIELDS, VDB_LICENSED_INTERNAL_KEYS, VDB_FORBIDDEN_CANONICAL_KEYS,'
  + ' VDB_FIXTURE_IDENTITIES, brokerVesselContext, vdbAuthorize, BrokerVesselAdapter };')(esc);

const ctx1 = V.brokerVesselContext();
const ctx2 = V.brokerVesselContext();
ok(ctx1.home === 'broker' && (ctx1.role === 'broker_user' || ctx1.role === 'broker_admin'), 'AdapterContextV0: home=broker with a broker role');
ok(ctx1.tenant_id === null && ctx1.fleet_id === null, 'AdapterContextV0: tenant_id/fleet_id are null for Broker');
ok(typeof ctx1.actor_ref === 'string' && !/@|victoria|tymur|sasha|andre/i.test(ctx1.actor_ref), 'actor_ref is opaque, not person-resolvable');
ok(ctx1.request_id && ctx2.request_id && ctx1.request_id !== ctx2.request_id, 'request_id is generated per call');
ok(JSON.stringify(ctx1.capability_grants.slice().sort()) === JSON.stringify(['vessel.cache.read', 'vessel.identity.read', 'vessel.provenance.read', 'vessel.search.read']), 'Slice 1 grants are exactly the four read capabilities');
ok(V.BROKER_VESSEL_SLICE1_GRANTS.indexOf('vessel.local_attach.write') < 0 && V.BROKER_VESSEL_SLICE1_GRANTS.indexOf('vessel.licensed.display.read') < 0, 'no write grant and no licensed-display grant in Slice 1');
ok(typeof V.BrokerVesselAdapter.attachLocalVesselRef === 'undefined' && typeof V.BrokerVesselAdapter.writeCanonicalVesselIdentity === 'undefined', 'adapter exposes no attach/write methods');

const sr = V.BrokerVesselAdapter.searchVessels('1234567');
ok(sr.ok && sr.results.length === 1 && sr.results[0].imo === '1234567', 'searchVessels finds the fixture bulk carrier by IMO');
const allowedKeys = new Set(V.VDB_SEARCH_RESULT_FIELDS);
const badKeys = Object.keys(sr.results[0]).filter((k) => !allowedKeys.has(k));
ok(badKeys.length === 0, 'search result is redacted to VesselSearchResultV0 fields only (extra: ' + badKeys.join(',') + ')');
ok(V.BrokerVesselAdapter.searchVessels('contract bulk').results.length === 1, 'searchVessels finds by name fragment');
ok(V.BrokerVesselAdapter.searchVessels('995123456').results.length === 1, 'searchVessels finds by MMSI');
ok(V.BrokerVesselAdapter.searchVessels('skp1').results.length === 1, 'searchVessels finds by call sign');
ok(V.BrokerVesselAdapter.searchVessels('').results.length === 0, 'empty query returns no rows');
ok(V.BrokerVesselAdapter.searchVessels('no-such-vessel-xyz').results.length === 0, 'no-hit query returns no rows');
ok(V.BrokerVesselAdapter.searchVessels('venus').results.length === 0, 'license-blocked record is NOT findable by hidden name (no search oracle)');
const blockedRow = V.BrokerVesselAdapter.searchVessels('9990001').results[0];
ok(blockedRow && blockedRow.record_id === 'imo:9990001' && blockedRow.name_current === null && blockedRow.type_display === null, 'license-blocked record found by identifier is an envelope row without public display fields');

const idOk = V.BrokerVesselAdapter.getVesselIdentity('imo:1234567');
ok(idOk.ok && idOk.fail_closed === false && idOk.identity.name_current === 'SKIPI CONTRACT BULK', 'getVesselIdentity returns the fixture identity');
const leakKeys = Object.keys(idOk.identity).filter((k) => V.VDB_LICENSED_INTERNAL_KEYS.includes(k) || V.VDB_FORBIDDEN_CANONICAL_KEYS.includes(k));
ok(leakKeys.length === 0, 'identity never contains licensed_internal or forbidden canonical fields (leak: ' + leakKeys.join(',') + ')');
ok(V.BrokerVesselAdapter.getVesselIdentity('imo:7654321').ui.must_show_staleness === true, 'stale record: cache semantics require a staleness indicator');
ok(V.BrokerVesselAdapter.getVesselIdentity('local:broker:alias-014').ui.must_show_staleness === true, 'offline-cached record: cache semantics require an offline/staleness indicator');
ok(V.BrokerVesselAdapter.getVesselIdentity('local:broker:alias-014').identity.identity_status === 'local_alias_only', 'non-IMO record stays local_alias_only, not canonical truth');

const conf = V.BrokerVesselAdapter.resolveConflictCandidates('imo:9111222');
ok(conf.ok && conf.candidates.length === 2, 'conflicted record resolves its conflict candidates');
ok(conf.candidates.every((c) => Object.keys(c).every((k) => allowedKeys.has(k))), 'conflict candidates are redacted search projections');

const blocked = V.BrokerVesselAdapter.getVesselIdentity('imo:9990001');
ok(blocked.ok && blocked.fail_closed === true && blocked.identity.name_current === undefined && blocked.identity.gross_tonnage === undefined, 'blocked_by_license identity fails closed to the envelope (no public fields)');
ok(V.BrokerVesselAdapter.getVesselIdentity('imo:8880001').fail_closed === true, 'error cache state fails closed');
const missing = V.BrokerVesselAdapter.getVesselIdentity('imo:0000000');
ok(missing.ok && missing.fail_closed === true && missing.identity.cache_state === 'missing', 'unknown record id fails closed as missing');

const prov = V.BrokerVesselAdapter.getVesselProvenance('imo:1234567');
ok(prov.ok && prov.chips.length === 1 && prov.chips[0].source_name === 'Skipi user-generated', 'provenance chips return display-safe source data');
ok(prov.chips.every((c) => Object.keys(c).every((k) => !V.VDB_LICENSED_INTERNAL_KEYS.includes(k))), 'provenance chips contain no licensed_internal fields');
const provBlocked = V.BrokerVesselAdapter.getVesselProvenance('imo:9990001');
ok(provBlocked.ok && provBlocked.fail_closed === true && provBlocked.chips.length === 0, 'provenance for a fail-closed record returns no chips');

section('Vessel Database Slice 1: fail-closed denials');
const noGrants = { ...V.brokerVesselContext(), capability_grants: [] };
ok(V.vdbAuthorize('searchVessels', noGrants) === 'missing_host_or_home_capability', 'missing grant denies with missing_host_or_home_capability');
const deniedSearch = V.BrokerVesselAdapter.searchVessels('1234567', noGrants);
ok(deniedSearch.ok === false && deniedSearch.denied === true && deniedSearch.reason === 'missing_host_or_home_capability', 'adapter surfaces the denial, not data');
ok(V.BrokerVesselAdapter.request('writeCanonicalVesselIdentity', {}).reason === 'canonical_write_denied_in_v0', 'canonical write is always denied in v0');
ok(V.BrokerVesselAdapter.request('attachLocalVesselRef', {}).denied === true, 'attachLocalVesselRef is denied in Slice 1 (write capability not granted)');
ok(V.BrokerVesselAdapter.request('unknownRequestType', {}).denied === true, 'unknown request types fail closed');
ok(V.vdbAuthorize('searchVessels', { ...V.brokerVesselContext(), home: 'onboard' }) === 'onboard_not_v0_consumer', 'onboard context is denied as not a v0 consumer');
ok(V.vdbAuthorize('searchVessels', { ...V.brokerVesselContext(), home: 'crewing' }) === 'unknown_home', 'non-broker home is denied by the Broker adapter');
ok(V.vdbAuthorize('searchVessels', { ...V.brokerVesselContext(), role: 'guest' }) === 'missing_or_wrong_role', 'unknown role is denied');
ok(V.vdbAuthorize('searchVessels', { ...V.brokerVesselContext(), platform: 'watch' }) === 'unsupported_platform', 'unsupported platform is denied');

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
