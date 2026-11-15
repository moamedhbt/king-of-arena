/**
 * مشغّل الاختبارات: الألغاز ← المحاكاة ← العدالة ← الشبكة الشاملة.
 * الاستخدام: npm test  (أو PUZZLE_ITERS=2000 npm test لنسخة أسرع)
 */
import { spawnSync } from 'node:child_process';

const suites = [
  ['الألغاز', 'tests/puzzles.test.ts'],
  ['المحاكاة', 'tests/sim.test.ts'],
  ['الأدوات', 'tests/items.test.ts'],
  ['العدالة', 'tests/fairness.test.ts'],
  ['الشبكة الشاملة', 'tests/e2e.ts'],
];

let failed = 0;
for (const [name, file] of suites) {
  console.log(`\n════ ${name} ════`);
  const r = spawnSync('npx', ['tsx', file], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ فشل: ${name}`);
  }
}
if (failed) {
  console.error(`\n${failed} مجموعة اختبار فشلت`);
  process.exit(1);
}
console.log('\n✅ كل الاختبارات نجحت');
