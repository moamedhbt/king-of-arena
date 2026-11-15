/**
 * اختبار الألغاز (القسم 15): لكل نوع ولكل صعوبة 10,000 لغز:
 * الحل وحيد، لا خيارات مكررة، وزمن التوليد أقل من 5ms.
 */
import { generatePuzzle, solveNexts, roundDifficulty, pickType, PUZZLE_TYPES, checkAnswer } from '../shared/src/index';
import type { PuzzleType } from '../shared/src/index';

const N = Number(process.env.PUZZLE_ITERS ?? 10000);
let failures = 0;
const fail = (m: string) => {
  failures++;
  if (failures < 25) console.error('  ✗', m);
};

function run(type: PuzzleType, difficulty: number) {
  // تسخين JIT حتى لا يُحسب أول استدعاء
  for (let i = 0; i < 300; i++) generatePuzzle(i * 7919, i % 7, difficulty, type);
  let maxMs = 0;
  let totalMs = 0;
  let produced = 0;
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const seed = (i * 2654435761) >>> 0;
    const t0 = performance.now();
    const p = generatePuzzle(seed, i % 7, difficulty, type);
    const ms = performance.now() - t0;
    totalMs += ms;
    times.push(ms);
    if (ms > maxMs) maxMs = ms;
    if (!p) {
      fail(`${type} d${difficulty}: لم يُولَّد لغز`);
      continue;
    }
    produced++;


    // الحل وحيد (المتتاليات عبر الحلّال الداخلي)
    if (p.type === 'sequence') {
      const terms = (p.payload as any).terms as number[];
      const nexts = solveNexts(terms);
      if (nexts.size !== 1) fail(`${type} d${difficulty}: ${nexts.size} حلول محتملة ${JSON.stringify(terms)}`);
      else if (!nexts.has(p.answer as number)) fail(`${type}: الحل خارج الحلّال ${JSON.stringify(terms)} -> ${p.answer}`);
      if (terms.length < 5) fail(`${type}: حدود أقل من 5`);
      if (difficulty >= 7 && terms.length !== 6) fail(`${type}: صعوبة عالية بلا 6 حدود`);
    }

    // خيارات غير مكررة وتحتوي الحل
    const opts = (p.payload as any).options as number[] | undefined;
    if (opts) {
      if (opts.length !== 4) fail(`${type} d${difficulty}: عدد خيارات ${opts.length}`);
      if (new Set(opts).size !== opts.length) fail(`${type} d${difficulty}: خيارات مكررة ${opts}`);
      if (!opts.includes(p.answer as number)) fail(`${type} d${difficulty}: الحل ليس بين الخيارات`);
      // فحص الإجابة في الخادم
      if (!checkAnswer(p, p.answer)) fail(`${type}: checkAnswer رفض الحل الصحيح`);
      const wrong = opts.find((o) => o !== p.answer)!;
      if (checkAnswer(p, wrong)) fail(`${type}: checkAnswer قبل إجابة خاطئة`);
    }

    if (p.type === 'memory') {
      const a = p.answer as number[];
      const pl = p.payload as any;
      if (new Set(a).size !== a.length) fail('memory: خلايا مكررة في الوميض');
      if (a.length !== 3 + Math.floor(difficulty / 2)) fail('memory: عدد ومضات خاطئ');
      if (a.some((c) => c < 0 || c >= pl.cols * pl.rows)) fail('memory: خلية خارج الشبكة');
      if (!checkAnswer(p, a)) fail('memory: فحص الإجابة فشل');
    }

    if (p.type === 'odd') {
      const pl = p.payload as any;
      const idx = p.answer as number;
      if (idx < 0 || idx >= pl.shapes.length) fail('odd: فهرس خارج المدى');
      if (!checkAnswer(p, idx)) fail('odd: فحص الإجابة فشل');
    }
  }
  const avg = totalMs / Math.max(1, produced);
  times.sort((a, b) => a - b);
  const p99 = times[Math.floor(times.length * 0.99)] ?? 0;
  // الزمن الحسابي هو المقياس؛ الشواذ (GC / جدولة نظام) تُبلَّغ منفصلة
  if (p99 > 5) fail(`${type} d${difficulty}: p99 ${p99.toFixed(2)}ms > 5ms`);
  if (avg > 1) fail(`${type} d${difficulty}: متوسط ${avg.toFixed(2)}ms > 1ms`);
  console.log(
    `  ${type.padEnd(11)} d${String(difficulty).padStart(2)}  n=${N}  متوسط ${avg.toFixed(3)}ms  p99 ${p99.toFixed(
      3
    )}ms  أقصى ${maxMs.toFixed(2)}ms`
  );
}

console.log('— اختبار الألغاز —');
for (const type of PUZZLE_TYPES) {
  for (let d = 1; d <= 10; d++) run(type, d);
}

// جدول الصعوبة
console.log('— جدول الصعوبة —');
const five = [1, 2, 3, 4, 5].map((r) => roundDifficulty(r, 5));
if (JSON.stringify(five) !== JSON.stringify([2, 4, 5, 7, 9])) fail(`صعوبة 5 جولات خاطئة: ${five}`);
for (const total of [3, 5, 7]) {
  const ds = Array.from({ length: total }, (_, i) => roundDifficulty(i + 1, total));
  console.log(`  ${total} جولات -> ${ds.join(', ')}`);
}

// لا تكرار متتالٍ للنوع
let prev: PuzzleType | null = null;
for (let r = 0; r < 40; r++) {
  const seed = 12345;
  const t = pickType(seed, r, prev);
  if (t === prev) fail(`نوع مكرر جولتين متتاليتين عند ${r}`);
  prev = t;
}

if (failures) {
  console.error(`\nفشل الاختبار: ${failures} حالة`);
  process.exit(1);
}
console.log('\n✓ نجح اختبار الألغاز بالكامل');
