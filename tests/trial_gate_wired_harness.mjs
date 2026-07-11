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
process.exit(fail);
