import fs from 'node:fs';

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const html = fs.readFileSync('dist/index.html', 'utf8');
const rust = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');

console.log('# Stack v1 Stage 4 negative control');
ok(html.includes('function stackVerificationState(info)'), 'fail-closed stackVerificationState helper exists');
ok(html.includes("verification_status: 'unavailable'"), 'default verification is unavailable');
ok(!html.includes("verification_status: 'verified'"), 'forged future verified status is not hardcoded');
ok(rust.includes('verification_status: "unavailable"'), 'native default verification is unavailable');
ok(html.includes('Stack mismatch') && html.includes('Stack verification unavailable'), 'explicit mismatch remains visible');

console.log(`NEGATIVE CONTROL PASS: ${passed} fail-closed checks passed`);
