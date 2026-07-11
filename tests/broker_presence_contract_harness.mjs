// Runtime presence contract for Broker required modules.
//
// The required module list lives only in presence-manifest.json. This harness
// mounts the real dist/index.html into a small DOM, executes the inline app
// scripts, and then drives the app's own navigation functions.
//
//   node tests/broker_presence_contract_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'presence-manifest.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const html = fs.readFileSync(path.join(ROOT, manifest.artifact), 'utf8');

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + msg);
  } else {
    fail++;
    console.error('  \u2717 ' + msg);
  }
}

function section(title) {
  console.log('\n# ' + title);
}

function cleanSelector(selector) {
  if (!selector || typeof selector !== 'string') throw new Error('selector must be a string');
  return selector.trim();
}

function parseAttrs(raw) {
  const attrs = {};
  const text = raw || '';
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

class StyleDecl {
  constructor(raw = '') {
    this._props = {};
    raw.split(';').forEach((part) => {
      const idx = part.indexOf(':');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) this.setProperty(key, val);
    });
  }

  setProperty(key, value) {
    const k = String(key || '').trim();
    if (!k) return;
    this._props[k] = String(value ?? '');
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    this[camel] = this._props[k];
  }

  getPropertyValue(key) {
    return this._props[String(key || '').trim()] || '';
  }

  removeProperty(key) {
    const k = String(key || '').trim();
    const old = this._props[k] || '';
    delete this._props[k];
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    delete this[camel];
    return old;
  }

  toString() {
    return Object.entries(this._props).map(([k, v]) => `${k}:${v}`).join(';');
  }
}

class ClassList {
  constructor(raw = '') {
    this._set = new Set(String(raw || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    names.flatMap((n) => String(n).split(/\s+/)).filter(Boolean).forEach((n) => this._set.add(n));
  }

  remove(...names) {
    names.flatMap((n) => String(n).split(/\s+/)).filter(Boolean).forEach((n) => this._set.delete(n));
  }

  contains(name) {
    return this._set.has(name);
  }

  toggle(name, force) {
    if (force === true) {
      this._set.add(name);
      return true;
    }
    if (force === false) {
      this._set.delete(name);
      return false;
    }
    if (this._set.has(name)) {
      this._set.delete(name);
      return false;
    }
    this._set.add(name);
    return true;
  }

  toString() {
    return Array.from(this._set).join(' ');
  }
}

class FakeElement {
  constructor(document, tagName = 'div', attrs = {}, initialHtml = '') {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.parentNode = null;
    this.attrs = { ...attrs };
    this.id = attrs.id || '';
    this.type = attrs.type || '';
    this.value = attrs.value || '';
    this.title = attrs.title || '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientWidth = 1024;
    this.clientHeight = 768;
    this.classList = new ClassList(attrs.class || '');
    this.style = new StyleDecl(attrs.style || '');
    this._innerHTML = initialHtml;
    this._textContent = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
  }

  get textContent() {
    return this._textContent || this._innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this._innerHTML = this._textContent;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new ClassList(value);
    this.attrs.class = this.classList.toString();
  }

  setAttribute(key, value) {
    const k = String(key);
    const v = String(value ?? '');
    this.attrs[k] = v;
    if (k === 'id') {
      if (this.id) this.ownerDocument._ids.delete(this.id);
      this.id = v;
      this.ownerDocument._ids.set(v, this);
    } else if (k === 'class') {
      this.classList = new ClassList(v);
    } else if (k === 'style') {
      this.style = new StyleDecl(v);
    } else {
      this[k] = v;
    }
  }

  getAttribute(key) {
    const k = String(key);
    if (k === 'class') return this.classList.toString();
    if (k === 'style') return this.style.toString();
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }

  removeAttribute(key) {
    const k = String(key);
    delete this.attrs[k];
    if (k === 'class') this.classList = new ClassList('');
    if (k === 'style') this.style = new StyleDecl('');
  }

  appendChild(child) {
    if (child) {
      this.children.push(child);
      child.parentNode = this;
    }
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child) child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  querySelector(selector) {
    return this.ownerDocument.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.ownerDocument.querySelectorAll(selector);
  }
}

class FakeDocument {
  constructor(sourceHtml) {
    this._ids = new Map();
    this._all = [];
    this._listeners = new Map();
    this.title = '';
    this.documentElement = this._makeElement('html', { id: '__html', lang: 'ru', 'data-theme': 'light' });
    this.head = this._makeElement('head', { id: '__head' });
    this.body = this._makeElement('body', { id: '__body' });
    this.parse(sourceHtml);
  }

  _makeElement(tagName, attrs = {}, initialHtml = '') {
    const el = new FakeElement(this, tagName, attrs, initialHtml);
    this._all.push(el);
    if (el.id) this._ids.set(el.id, el);
    return el;
  }

  parse(sourceHtml) {
    const re = /<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?>/g;
    let m;
    while ((m = re.exec(sourceHtml))) {
      const tag = m[1].toLowerCase();
      if (tag.startsWith('!') || tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') continue;
      const attrs = parseAttrs(m[2] || '');
      if (!attrs.id && !attrs['data-i18n'] && !attrs['data-i18n-title'] && !attrs['data-qa']) continue;
      const close = sourceHtml.indexOf(`</${tag}>`, re.lastIndex);
      const initialHtml = close >= 0 ? sourceHtml.slice(re.lastIndex, close) : '';
      this._makeElement(tag, attrs, initialHtml);
    }
  }

  getElementById(id) {
    return this._ids.get(String(id)) || null;
  }

  createElement(tagName) {
    const el = this._makeElement(tagName, {});
    if (String(tagName).toLowerCase() === 'canvas') {
      el.getContext = () => ({
        drawImage() {},
        fillRect() {},
        clearRect() {},
        getImageData: () => ({ data: [] }),
      });
      el.toDataURL = () => 'data:image/png;base64,';
    }
    return el;
  }

  createTextNode(text) {
    const el = this._makeElement('#text', {});
    el.textContent = text;
    return el;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener() {}

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const s = cleanSelector(selector);
    if (s.startsWith('#')) {
      const el = this.getElementById(s.slice(1));
      return el ? [el] : [];
    }
    const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
    if (attr) {
      const key = attr[1];
      const expected = attr[2];
      return this._all.filter((el) => {
        const actual = el.getAttribute(key);
        return actual !== null && (expected === undefined || actual === expected);
      });
    }
    if (s.startsWith('.')) return this._all.filter((el) => el.classList.contains(s.slice(1)));
    return this._all.filter((el) => el.tagName.toLowerCase() === s.toLowerCase());
  }
}

function installRuntime(sourceHtml) {
  const document = new FakeDocument(sourceHtml);
  const store = new Map();
  const intervalIds = [];

  const tauriInvoke = async (cmd) => {
    if (cmd === 'get_build_info') return { version: '0.1.146', sha: 'presence-harness' };
    if (cmd === 'get_settings') return {};
    if (cmd === 'init_app_diagnostics') return {};
    if (cmd === 'app_heartbeat') return {};
    if (cmd === 'record_app_diagnostic') return {};
    if (cmd === 'mark_app_shutdown') return {};
    return {};
  };

  const sandbox = {
    console,
    document,
    navigator: {
      userAgent: 'Node Presence Harness',
      platform: 'Linux x86_64',
      clipboard: { writeText: async () => {} },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    location: { hash: '', pathname: '/presence-harness', reload() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    crypto: webcrypto,
    __TAURI__: {
      core: { invoke: tauriInvoke },
      invoke: tauriInvoke,
      window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
    },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (...args) => {
      intervalIds.push(args);
      return intervalIds.length;
    },
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    alert() {},
    confirm: () => true,
    prompt: () => null,
    Blob: class Blob {},
    FileReader: class FileReader {},
    Image: class Image {},
    URL: { createObjectURL: () => 'blob:presence-harness', revokeObjectURL() {} },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  const scripts = Array.from(sourceHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .map(([, attrs, code]) => {
      const src = /\ssrc\s*=\s*["']([^"']+)["']/.exec(attrs || '');
      if (!src) return code;
      if (src[1] === 'map.js') return fs.readFileSync(path.join(ROOT, 'dist', 'map.js'), 'utf8');
      return null;
    })
    .filter(Boolean);

  scripts.forEach((code, idx) => {
    try {
      vm.runInContext(code, sandbox, { filename: `dist/index.html#script-${idx + 1}` });
    } catch (e) {
      throw new Error(`inline script ${idx + 1} failed: ${e.stack || e.message}`);
    }
  });

  return { sandbox, document, store };
}

function selectorOne(document, selector) {
  const el = document.querySelector(cleanSelector(selector));
  ok(!!el, `${selector} exists`);
  return el;
}

function displayOf(el) {
  return String(el && (el.style.display || el.getAttribute('display') || '')).trim();
}

function isHidden(el) {
  if (!el) return true;
  if (el.getAttribute('hidden') !== null) return true;
  if (/^(none|hidden)$/i.test(displayOf(el))) return true;
  if (/hidden/i.test(String(el.style.visibility || ''))) return true;
  if (/^(0|0\.0+)$/.test(String(el.style.opacity || ''))) return true;
  if (/\b(?:hidden|is-hidden|internal-tool)\b/.test(el.classList.toString())) return true;
  return false;
}

function isVisible(el) {
  return !!el && !isHidden(el);
}

function assertVisible(document, selector, msg) {
  const el = selectorOne(document, selector);
  ok(isVisible(el), msg || `${selector} is visible`);
  return el;
}

function assertHidden(document, selector, msg) {
  const el = selectorOne(document, selector);
  ok(isHidden(el), msg || `${selector} is hidden`);
  return el;
}

function assertManifestShape() {
  section('manifest');
  ok(manifest.schema_version === 'skipi.presence-manifest.v1', 'schema_version is skipi.presence-manifest.v1');
  ok(manifest.home === 'broker', 'manifest home is broker');
  ok(typeof manifest.artifact === 'string' && manifest.artifact === 'dist/index.html', 'manifest points at dist/index.html');
  ok(Array.isArray(manifest.required_modules) && manifest.required_modules.length > 0, 'manifest has required_modules');
  const ids = new Set();
  for (const mod of manifest.required_modules || []) {
    ok(!!mod.id && !ids.has(mod.id), `module id is unique: ${mod.id}`);
    ids.add(mod.id);
    ok(!!mod.name, `${mod.id} has a name`);
  }
}

function installNavigationStubs(sandbox) {
  const noop = () => {};
  const resolved = () => Promise.resolve();
  Object.assign(sandbox, {
    updateCtxBarVisibility: noop,
    renderTeamUnread: noop,
    _hideTeamNewBadge: noop,
    refreshDedup: () => {
      if (sandbox.state && sandbox.state.dedup) sandbox.state.dedup.loaded = true;
      return Promise.resolve();
    },
    renderDedup: noop,
    renderPartners: noop,
    refreshCounterpartFlags: resolved,
    refreshCounterpartsCRM: resolved,
    openMailView: noop,
    _disarmMailAutoRefresh: noop,
    renderLeads2View: noop,
    renderCasesView: noop,
    refreshSignalsBrowse: resolved,
    renderSignalsBrowse: noop,
    refreshBazaarPairs: resolved,
    refreshInbox: resolved,
    mobileUpdateCasesBadge: noop,
    _getCases: () => [],
  });
  if (sandbox.state) {
    sandbox.state.dedup = sandbox.state.dedup || {};
    sandbox.state.dedup.loaded = true;
    sandbox.state.dedup.loading = false;
    sandbox.state.signalsBrowse = sandbox.state.signalsBrowse || {};
    sandbox.state.signalsBrowse.loaded = true;
  }
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function assertChecks(document, sandbox, mod) {
  for (const check of mod.checks || []) {
    const el = selectorOne(document, check.selector);
    if (!el) continue;
    if (check.expect_present) ok(!!el, `${mod.name}: ${check.selector} is present`);
    if (check.expect_visible) ok(isVisible(el), `${mod.name}: ${check.selector} is visible`);
    if (check.expect_display !== undefined) ok(displayOf(el) === check.expect_display, `${mod.name}: ${check.selector} display is ${check.expect_display}`);
    if (check.onclick_contains) ok(String(el.getAttribute('onclick') || '').includes(check.onclick_contains), `${mod.name}: ${check.selector} onclick contains ${check.onclick_contains}`);
  }

  for (const action of mod.actions || []) {
    const fn = sandbox[action.call];
    ok(typeof fn === 'function', `${mod.name}: runtime function ${action.call} exists`);
    if (typeof fn === 'function') {
      fn(...(action.args || []));
      await settle();
      for (const selector of action.visible || []) assertVisible(document, selector, `${mod.name}: ${selector} visible after ${action.call}`);
      for (const selector of action.hidden || []) assertHidden(document, selector, `${mod.name}: ${selector} hidden after ${action.call}`);
    }
  }
}

async function assertDesktopNavigation(document, sandbox, mod) {
  const nav = mod.desktop_navigation;
  if (!nav) return;
  assertVisible(document, nav.nav_selector, `${mod.name}: desktop nav is visible`);
  ok(String(selectorOne(document, nav.nav_selector).getAttribute('onclick') || '').includes(`showView('${nav.route}')`), `${mod.name}: desktop nav calls showView('${nav.route}')`);
  ok(typeof sandbox.showView === 'function', `${mod.name}: showView is executable`);
  sandbox.showView(nav.route);
  await settle();
  ok(sandbox.state && sandbox.state.view === nav.route, `${mod.name}: state.view switched to ${nav.route}`);
  ok(displayOf(selectorOne(document, nav.view_selector)) !== 'none', `${mod.name}: desktop view ${nav.view_selector} is shown`);
  ok(selectorOne(document, nav.nav_selector).classList.contains('active'), `${mod.name}: desktop nav is active`);
}

async function assertMobileNavigation(document, sandbox, mod) {
  const nav = mod.mobile_navigation;
  if (!nav) return;
  assertVisible(document, nav.nav_selector, `${mod.name}: mobile nav is visible`);
  ok(String(selectorOne(document, nav.nav_selector).getAttribute('onclick') || '').includes(`mobileSwitchView('${nav.route}')`), `${mod.name}: mobile nav calls mobileSwitchView('${nav.route}')`);
  ok(typeof sandbox.mobileSwitchView === 'function', `${mod.name}: mobileSwitchView is executable`);
  sandbox.mobileSwitchView(nav.route);
  await settle();
  ok(sandbox.state && sandbox.state.view === nav.route, `${mod.name}: mobile state.view switched to ${nav.route}`);
  ok(selectorOne(document, nav.view_selector).getAttribute('data-mobile-active') === '1', `${mod.name}: mobile view ${nav.view_selector} marked active`);
  ok(selectorOne(document, nav.nav_selector).classList.contains('active'), `${mod.name}: mobile nav is active`);
}

assertManifestShape();

const runtime = installRuntime(html);
await settle();
installNavigationStubs(runtime.sandbox);
await settle();

section('runtime app mount');
ok(runtime.document.getElementById('auth-gate-overlay')?.style.display === 'flex', 'boot mounted launch/auth gate without backend access');
ok(typeof runtime.sandbox.showView === 'function', 'app showView function is loaded');
ok(typeof runtime.sandbox.mobileSwitchView === 'function', 'app mobileSwitchView function is loaded');

for (const mod of manifest.required_modules) {
  section(mod.name);
  await assertChecks(runtime.document, runtime.sandbox, mod);
  await assertDesktopNavigation(runtime.document, runtime.sandbox, mod);
  await assertMobileNavigation(runtime.document, runtime.sandbox, mod);
}

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
