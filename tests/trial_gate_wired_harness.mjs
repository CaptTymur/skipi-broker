// Regression guard: the 2-week trial gate must be PRESENT and WIRED INTO BOOT.
//
// Catches the "reported done but not actually inserted" class: an agent claims the
// trial is implemented, but trialGateApply() is never called in the boot path, or the
// contacts/constants are missing — so users never see the banner/block. This is exactly
// the regression pattern the curator caught by hand (2026-07-10).
//
// Asserts against dist/index.html (the shipped monolithic frontend).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'dist', 'index.html'), 'utf8');

const checks = [
  ['trialPhase() defined', /function\s+trialPhase\s*\(/],
  ['trialGateApply() defined', /function\s+trialGateApply\s*\(/],
  ['trialGateApply() WIRED into boot (called with await)', /await\s+trialGateApply\s*\(\)/],
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
