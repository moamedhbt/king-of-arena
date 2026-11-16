/**
 * اختبار المحاكاة (القسم 15): بوتات بلا واجهة
 * 8 لاعبين × 100 مباراة: لا انهيار ولا مرحلة عالقة وكل مباراة تنتهي.
 */
import { runBotRound } from './bots';
import { ArenaSim } from '../server/src/sim';
import { config, TILES } from '../shared/src/index';

// هذه المجموعة تختبر وضع «انهيار الأرضية» الكلاسيكي صراحةً (الوضع الافتراضي الآن هو حقل الملوك)
config.collapse.enabled = true;
config.mines.enabled = false;

let failures = 0;
const fail = (m: string) => {
  failures++;
  if (failures < 20) console.error('  ✗', m);
};

console.log('— محاكاة الحلبة —');

// 1) 8 لاعبين × 100 مباراة
const N8 = Number(process.env.SIM_ITERS ?? 100);
let maxDur = 0;
let sumDur = 0;
for (let i = 0; i < N8; i++) {
  const r = runBotRound(8, 1000 + i);
  sumDur += r.durationSec;
  maxDur = Math.max(maxDur, r.durationSec);
  if (r.durationSec >= config.phase.arenaMax + config.phase.finaleFallSec + 2) {
    fail(`جولة ${i} تجاوزت الحد: ${r.durationSec.toFixed(1)}s`);
  }
  // تنتهي الجولة إذا بقي واحد أو لم يبقَ أحد (سقوط متزامن مشروع) أو فنيت البلاطات
  if (r.aliveCount > 1 && r.tilesLeft > 1) {
    fail(`جولة ${i} لم تنتهِ بشكل صحيح (أحياء=${r.aliveCount}, بلاطات=${r.tilesLeft})`);
  }
}
console.log(
  `  8 لاعبين × ${N8}: متوسط ${(sumDur / N8).toFixed(1)}s، أقصى ${maxDur.toFixed(1)}s`
);

// 2) 2 لاعبين × 50
for (let i = 0; i < 50; i++) {
  const r = runBotRound(2, 5000 + i);
  if (r.durationSec >= config.phase.arenaMax + config.phase.finaleFallSec + 2) {
    fail(`جولة لاعبين ${i} تجاوزت الحد: ${r.durationSec.toFixed(1)}s`);
  }
}
console.log('  2 لاعبين × 50: ✓');

// 3) 3 لاعبين × 50
for (let i = 0; i < 50; i++) runBotRound(3, 9000 + i);
console.log('  3 لاعبين × 50: ✓');

// 4) جدول الانهيار يتناسب مع عدد اللاعبين
console.log('— جدول الانهيار —');
function scheduleSpan(n: number): number {
  const sim = new ArenaSim({ seed: 42, playerIds: Array.from({ length: n }, (_, i) => `p${i}`), roundIndex: 1 });
  const dt = 1 / 30;
  // نُشغّل بلا لاعبين متحركين حتى تسقط كل البلاطات المجدولة
  let t = 0;
  let scheduledGone = 0;
  const target = TILES.filter((x) => x.ring >= 1).length;
  while (t < 120 && scheduledGone < target) {
    sim.step(dt);
    t = sim.t;
    scheduledGone = sim.tileStatesString().split('').filter((c) => c === '2').length;
  }
  return t;
}
const spans = [2, 3, 4, 5, 8].map((n) => [n, scheduleSpan(n)] as const);
for (const [n, s] of spans) console.log(`  ${n} لاعبين: كل البلاطات المجدولة تسقط بعد ≈ ${s.toFixed(1)}s`);
const s5 = spans.find(([n]) => n === 5)![1];
for (const [n, s] of spans) {
  if (n >= 5 && Math.abs(s - s5) > 4) fail(`جدول ${n} لاعبين غير متسق: ${s.toFixed(1)}`);
  if (n < 5 && !(s < s5)) fail(`جدول ${n} لاعبين ليس أسرع من 5 لاعبين (${s.toFixed(1)} ≥ ${s5.toFixed(1)})`);
}
// 2 لاعبين لا يطبّق عليهم الموت المفاجئ (بدأت الجولة بلاعبين)
if (spans.find(([n]) => n === 2)![1] > 45) fail('جدول اللاعبين الاثنين بطيء أكثر من اللازم');

if (failures) {
  console.error(`\nفشل: ${failures}`);
  process.exit(1);
}
console.log('\n✓ نجح اختبار المحاكاة');
