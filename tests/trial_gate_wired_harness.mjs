// Regression guard: the 2-week trial gate must be PRESENT and WIRED INTO BOOT.
//
// Catches the "reported done but not actually inserted" class: an agent claims the
// trial is implemented, but trialGateApply() is never called in the boot path, or the
// contacts/constants are missing — so users never see the banner/block. This is exactly
// the regression pattern the curator caught by hand (2026-07-10).
//
// Hardened (2026-07-11, grok C1): all checks run against a COMMENT-STRIPPED view of the
// HTML, so a commented-out wiring line (`// await trialGateApply()...`) no longer counts
// as wired. The WIRED check additionally requires the return value to be CONSUMED
// (`=== 'blocked'`), matching the real guard `if (await trialGateApply() === 'blocked') return;`
// — a bare/ignored dead call does not satisfy it.
// Residual (not covered): a call buried in `if(false){...}` dead code, and true runtime
// reachability — those need a headless boot smoke (Slice 4). Documented, not silently missed.
//
// Asserts against dist/index.html (the shipped monolithic frontend).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '..', 'dist', 'index.html'), 'utf8');

// Strip comments so commented-out code cannot satisfy a check. Heuristic but safe for the
// non-minified inline JS in dist: remove /* ... */ blocks, then drop // line-comments that
// are NOT part of a scheme (spare http://, https:// by requiring the // not be preceded by ':').
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.split('\n').map((line) => {
    let inS = null; // track ' " ` to avoid cutting // inside strings
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inS) { if (c === inS && line[i - 1] !== '\\') inS = null; continue; }
      if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
      if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}
const html = stripComments(raw);

const checks = [
  ['trialPhase() defined', /function\s+trialPhase\s*\(/],
  ['trialGateApply() defined', /function\s+trialGateApply\s*\(/],
  // WIRED = the result is actually consumed to gate boot, not a bare/dead call.
  ['trialGateApply() WIRED into boot (result consumed: === \'blocked\')',
    /await\s+trialGateApply\s*\(\)\s*===\s*['"]blocked['"]/],
  ['blocked overlay present', /trial-block-overlay/],
  ['warning banner present', /trial-warning-banner/],
  ['contact email info@tymur.org', /info@tymur\.org/],
  ['contact phone +357 97 617 412', /\+?357\s*97\s*617\s*412|35797617412/],
  ['TRIAL_DAYS constant', /TRIAL_DAYS\s*=/],
  ['TRIAL_WARNING_FROM_DAY constant', /TRIAL_WARNING_FROM_DAY\s*=/],
  ['license token activation endpoint', /\/api\/trial\/activate/],
];

let fail = 0;
for (const [name, re] of checks) {
  if (re.test(html)) {
    console.log('OK:', name);
  } else {
    console.error('FAIL: trial gate missing/unwired —', name);
    fail = 1;
  }
}
if (fail) {
  console.error('\n>>> Trial gate is NOT fully wired. Users would not see the banner/block.');
  console.error('>>> This is the "reported done but not inserted" regression. See project_trial_gate.');
}

function makeLocalStorage(startedDaysAgo) {
  const store = new Map();
  store.set('skipi_trial_started_at', new Date(Date.now() - startedDaysAgo * 86400000).toISOString());
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    dump() { return Object.fromEntries(store.entries()); },
  };
}

function makeDocument() {
  const nodes = Object.create(null);
  const body = {
    appendChild(el) {
      el.parentNode = body;
      if (el.id) nodes[el.id] = el;
    },
    removeChild(el) {
      if (el && el.id) delete nodes[el.id];
      if (el) el.parentNode = null;
    },
  };
  return {
    nodes,
    body,
    createElement(tag) {
      return { tag, id: '', style: {}, innerHTML: '', textContent: '', disabled: false, parentNode: null, focus() {} };
    },
    getElementById(id) { return nodes[id] || null; },
    setNode(id, props = {}) {
      nodes[id] = Object.assign({ id, style: {}, value: '', textContent: '', disabled: false, parentNode: body, focus() {} }, props);
      return nodes[id];
    },
  };
}

function extractTrialScript() {
  const start = raw.indexOf('var TRIAL_STARTED_KEY');
  const end = raw.indexOf('// ---------- Boot ----------', start);
  assert.ok(start > 0 && end > start, 'trial script markers present');
  return raw.slice(start, end);
}

function loadTrialContext({ serverMode, startedDaysAgo }) {
  const document = makeDocument();
  const localStorage = makeLocalStorage(startedDaysAgo);
  const ctx = {
    console,
    Date,
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 1; },
    localStorage,
    document,
    window: {},
    state: { settings: { broker_id: '11111111-1111-4111-8111-111111111111', bearer_token: '11111111-1111-4111-8111-111111111111', server_url: 'https://api.skipi.app' }, access: null },
    _authLastReason: 'ok',
    bootRefreshes: 0,
    esc(v) { return String(v == null ? '' : v); },
    showToast() {},
    _isDemo() { return false; },
    refreshIdentityBadge() {},
    async refreshAll() { ctx.bootRefreshes += 1; },
    startAutoRefresh() {},
    initTeamChat() {},
    showView() {},
    emitTeamEvent() {},
    checkForUpdates() {},
    maybePromptForFeedback() {},
    async fetch() { return { ok: true, async json() { return { active: true }; } }; },
    async _authGateValidate() {
      if (serverMode === 'active') {
        ctx.state.access = { active: true, days_left: 30 };
        ctx._authLastReason = 'ok';
        return true;
      }
      if (serverMode === 'expired') {
        ctx.state.access = { active: false, days_left: 0 };
        ctx._authLastReason = 'expired';
        return false;
      }
      ctx.state.access = null;
      ctx._authLastReason = 'network';
      return false;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractTrialScript()}\nthis.__trial = { trialGateApply, trialPhase, trialActivateLicense, trialShowBlockedOverlay };`, ctx);
  return ctx;
}

async function runtimeChecks() {
  let ctx = loadTrialContext({ serverMode: 'active', startedDaysAgo: 20 });
  assert.equal(await ctx.__trial.trialGateApply(), 'free', 'server active overrides expired local trial');
  assert.equal(ctx.document.getElementById('trial-block-overlay'), null, 'server active removes blocked overlay');

  ctx = loadTrialContext({ serverMode: 'expired', startedDaysAgo: 0 });
  assert.equal(await ctx.__trial.trialGateApply(), 'blocked', 'server expired blocks despite fresh local clock');
  assert.ok(ctx.document.getElementById('trial-block-overlay'), 'server expired shows blocked overlay');

  ctx = loadTrialContext({ serverMode: 'active', startedDaysAgo: 20 });
  ctx.__trial.trialShowBlockedOverlay('');
  ctx.document.setNode('trial-license', { value: 'valid-license-token' });
  ctx.document.setNode('trial-license-error');
  ctx.document.setNode('trial-license-btn');
  await ctx.__trial.trialActivateLicense();
  assert.equal(ctx.document.getElementById('trial-block-overlay'), null, 'activate success removes overlay');
  assert.equal(ctx.localStorage.dump().skipi_license_token, 'valid-license-token', 'activate stores license token');
  assert.ok(ctx.bootRefreshes > 0, 'activate continues boot without re-blocking');
  console.log('OK: runtime trial gate — server active/expired/activate cases');
}

await runtimeChecks();
process.exit(fail);
