// Broker Map source-split contract harness.
//
// The broker-specific map UI is vendored as a lightweight global-script module:
//   dist/map.js + dist/map.css
// Leaflet itself remains in dist/leaflet/ and is still loaded by index.html.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIST, 'map.js'), 'utf8');
const css = fs.readFileSync(path.join(DIST, 'map.css'), 'utf8');

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

function hasDefinition(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?:^|\\n)function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)async\\s+function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)var\\s+${escaped}\\b`),
    new RegExp(`(?:^|\\n)const\\s+${escaped}\\b`)
  ].some((re) => re.test(source));
}

ok(html.includes('<link rel="stylesheet" href="leaflet/leaflet.css">'), 'index.html keeps leaflet.css');
ok(html.includes('<script src="leaflet/leaflet.js"></script>'), 'index.html keeps leaflet.js');
ok(html.includes('<link rel="stylesheet" href="map.css">'), 'index.html links map.css');
ok(html.includes('<script src="map.js"></script>'), 'index.html loads map.js');
ok(html.indexOf('<script src="leaflet/leaflet.js"></script>') < html.indexOf('<script src="map.js"></script>'), 'map.js loads after leaflet.js');
ok(hasDefinition(js, '_vizInitMap'), 'map.js defines _vizInitMap');
ok(hasDefinition(js, 'renderVizMap'), 'map.js defines renderVizMap');
ok(hasDefinition(js, '_renderLeadMap'), 'map.js defines _renderLeadMap');
ok(hasDefinition(js, 'showLeadOnMap'), 'map.js defines showLeadOnMap');
ok(hasDefinition(js, 'PORT_COORDS'), 'map.js defines PORT_COORDS');
ok(css.includes('.viz-map-wrap'), 'map.css contains .viz-map-wrap');
ok(css.includes('.lead-map-wrap'), 'map.css contains .lead-map-wrap');
ok(!hasDefinition(html, '_vizInitMap'), 'index.html no longer defines _vizInitMap inline');
ok(!hasDefinition(html, 'renderVizMap'), 'index.html no longer defines renderVizMap inline');
ok(!hasDefinition(html, '_renderLeadMap'), 'index.html no longer defines _renderLeadMap inline');
ok(!hasDefinition(html, 'showLeadOnMap'), 'index.html no longer defines showLeadOnMap inline');
ok(!hasDefinition(html, 'PORT_COORDS'), 'index.html no longer defines PORT_COORDS inline');
ok(!html.includes('.viz-map-wrap {'), 'index.html no longer carries .viz-map-wrap CSS inline');
ok(!html.includes('.lead-map-wrap {'), 'index.html no longer carries .lead-map-wrap CSS inline');

if (fail) {
  console.error(`\n${fail} Map contract assertion(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} Map contract assertions passed`);
