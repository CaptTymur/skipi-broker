// Broker MSI module-pin contract harness.
//
// The Maritime Safety (MSI) layer is delivered by the standalone module
// @skipi/map, pinned as vendored dist assets (handoff
// HANDOFF-2026-08-05-manager-map-msi-stack-delivery.md, Phase B):
//   dist/map-module/map.js + map.css     @skipi/map 0.2.3 @ 3c84aa65…
//   dist/map-module/VENDOR-PIN.json      pin stamp (version + source SHA)
//   dist/leaflet/world-land.geojson      offline land fill (module sibling)
//   dist/leaflet/world-coastline.geojson offline shore stroke (module sibling)
//   dist/msi/warnings.geojson            fixture MSI data (served relative)
// The adapter lives host-side in dist/index.html (vizToggleMsi + overlay);
// the module keeps its DI boundary: no state/invoke/apiFetch inside dist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const PIN_VERSION = '0.2.3';
const PIN_SHA = '3c84aa651606a69231d7c4859297d321b722ed4b';
const DISCLAIMER = 'Ситуационная осведомлённость. Не замена GMDSS (NAVTEX / SafetyNET / SafetyCast). Символика S-52-inspired, не certified ECDIS.';

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log('  ✓ ' + message);
  } else {
    fail += 1;
    console.error('  ✗ ' + message);
  }
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// --- pinned module files ---
const js = readOrNull(path.join(DIST, 'map-module', 'map.js'));
const css = readOrNull(path.join(DIST, 'map-module', 'map.css'));
ok(js !== null, 'dist/map-module/map.js is vendored');
ok(css !== null, 'dist/map-module/map.css is vendored');
ok(!!js && js.includes('@skipi/map'), 'map-module/map.js is the @skipi/map bundle');
ok(!!js && js.includes("VERSION = '" + PIN_VERSION + "'"), 'map-module/map.js carries version ' + PIN_VERSION);
ok(!!js && js.includes('SkipiMap'), 'map-module/map.js exposes SkipiMap');
ok(!!js && js.includes("'s52-msi'"), 'map-module/map.js has the s52-msi style pack');
ok(!!css && css.includes('.skipi-msi-legend'), 'map-module/map.css has the MSI legend styles');
ok(!!css && !css.includes('.viz-map-wrap {'), 'map-module/map.css does not collide with broker .viz-map-wrap');

// DI boundary: the module bundle never calls home globals.
ok(!!js && !js.includes('apiFetch('), 'module bundle has no apiFetch( call');
ok(!!js && !js.includes('invoke('), 'module bundle has no invoke( call');
ok(!!js && !js.includes('window.state'), 'module bundle has no window.state access');

// --- pin stamp ---
const pinRaw = readOrNull(path.join(DIST, 'map-module', 'VENDOR-PIN.json'));
ok(pinRaw !== null, 'dist/map-module/VENDOR-PIN.json pin stamp exists');
let pin = null;
try {
  pin = pinRaw ? JSON.parse(pinRaw) : null;
} catch {
  pin = null;
}
ok(pin !== null, 'VENDOR-PIN.json parses as JSON');
ok(!!pin && pin.version === PIN_VERSION, 'pin stamp version is ' + PIN_VERSION);
ok(!!pin && pin.source_commit === PIN_SHA, 'pin stamp source_commit is ' + PIN_SHA);

// --- offline base geojson siblings (module default: leaflet/world-*.geojson) ---
for (const [name, minBytes] of [
  ['world-land.geojson', 1024 * 1024],
  ['world-coastline.geojson', 1024 * 1024],
]) {
  const p = path.join(DIST, 'leaflet', name);
  const raw = readOrNull(p);
  ok(raw !== null, 'dist/leaflet/' + name + ' is vendored');
  ok(!!raw && raw.length > minBytes, 'dist/leaflet/' + name + ' looks full-size (> 1 MB)');
  let gj = null;
  try {
    gj = raw ? JSON.parse(raw) : null;
  } catch {
    gj = null;
  }
  ok(!!gj && gj.type === 'FeatureCollection', 'dist/leaflet/' + name + ' is a FeatureCollection');
}

// --- MSI fixture data ---
const msiRaw = readOrNull(path.join(DIST, 'msi', 'warnings.geojson'));
ok(msiRaw !== null, 'dist/msi/warnings.geojson is vendored (served as msi/warnings.geojson)');
let msi = null;
try {
  msi = msiRaw ? JSON.parse(msiRaw) : null;
} catch {
  msi = null;
}
ok(!!msi && msi.type === 'FeatureCollection', 'msi/warnings.geojson is a FeatureCollection');
ok(!!msi && Array.isArray(msi.features) && msi.features.length > 0, 'msi/warnings.geojson has features');
ok(
  !!msi && (msi.features || []).every((f) => f && f.geometry && f.properties),
  'every MSI feature has geometry + properties'
);

// --- host-side adapter in index.html ---
const html = readOrNull(path.join(DIST, 'index.html')) || '';
ok(html.includes('<link rel="stylesheet" href="map-module/map.css">'), 'index.html links map-module/map.css');
ok(html.includes('<script src="map-module/map.js"></script>'), 'index.html loads map-module/map.js');
ok(
  html.indexOf('<script src="leaflet/leaflet.js"></script>') !== -1 &&
    html.indexOf('<script src="leaflet/leaflet.js"></script>') < html.indexOf('<script src="map-module/map.js"></script>'),
  'map-module/map.js loads after leaflet.js (host owns Leaflet)'
);
ok(html.includes(PIN_SHA), 'index.html carries the pin SHA stamp');
ok(html.includes('id="viz-show-msi"'), 'Карта sidebar has the MSI layer checkbox');
ok(html.includes('vizToggleMsi(this.checked)'), 'MSI checkbox is wired to vizToggleMsi');
ok(/function\s+vizToggleMsi\s*\(/.test(html), 'index.html defines the vizToggleMsi adapter');
ok(html.includes('id="viz-msi-wrap"'), 'index.html has the MSI overlay wrap');
ok(html.includes('id="viz-msi-map"'), 'index.html has the MSI map mount container');
ok(html.includes("'msi/warnings.geojson'"), 'adapter fetches msi/warnings.geojson');
ok(html.includes("stylePack: 's52-msi'"), 'adapter requests the s52-msi style pack');
ok(html.includes("kind: 'geo'"), 'adapter uses layer kind geo');
ok(html.includes('Maritime Safety (MSI)'), 'layer label «Maritime Safety (MSI)» present');
ok(html.includes(DISCLAIMER), 'exact GMDSS/ECDIS disclaimer present in index.html');
ok(!html.includes('checked onchange="vizToggleMsi'), 'MSI layer is OFF by default (checkbox not checked)');

// --- preserve: legacy broker map fork untouched by the pin ---
ok(html.includes('<script src="map.js"></script>'), 'legacy dist/map.js still loaded (cargo/viz map preserved)');

if (fail) {
  console.error(`\n${fail} MSI module-pin assertion(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} MSI module-pin assertions passed`);
