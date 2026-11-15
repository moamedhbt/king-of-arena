/**
 * اختبار العدالة (القسم 15): بوتات متساوية المهارة — توزيع الفوز بحسب موضع
 * البداية يجب أن يكون متساويًا (±5 نقاط مئوية عن المتوقع).
 */
import { runBotRound } from './bots';

const TOL = 0.05;

function trial(playerCount: number, rounds: number) {
  const wins = new Array(playerCount).fill(0);
  let decided = 0;
  for (let i = 0; i < rounds; i++) {
    const r = runBotRound(playerCount, 100000 + i * 7919);
    // الفائز = آخر من بقي؛ التعادل عند نهاية الوقت يُقسم بالتساوي
    const alive = playerCount - r.fallOrder.length;
    if (alive === 0 && r.fallOrder.length === 0) continue;
    decided++;
    const fallen = new Set(r.fallOrder);
    const aliveIds = Array.from({ length: playerCount }, (_, i) => `p${i}`).filter((id) => !fallen.has(id));
    // الباقون يتقاسمون الفوز؛ وإن سقط الجميع فالفائز هو آخر من سقط (نفس قاعدة اللعبة)
    const winners = aliveIds.length ? aliveIds : [r.fallOrder[r.fallOrder.length - 1]];
    for (const id of winners) wins[Number(id.slice(1))] += 1 / winners.length;
  }
  console.log(`  ${playerCount} لاعبين × ${rounds} جولة (${decided} محسومة)`);
  const expected = 1 / playerCount;
  let worst = 0;
  wins.forEach((w, i) => {
    const share = w / Math.max(1, decided);
    worst = Math.max(worst, Math.abs(share - expected));
    console.log(`    موضع ${i + 1}: ${(share * 100).toFixed(1)}%`);
  });
  console.log(`    أقصى انحراف: ${(worst * 100).toFixed(2)} نقطة مئوية (الحد ${TOL * 100})`);
  return worst <= TOL;
}

console.log('— اختبار العدالة (موضع البداية) —');
let ok = true;
ok = trial(2, 1000) && ok;
ok = trial(4, 900) && ok;
ok = trial(8, 800) && ok;

if (!ok) {
  console.error('\nفشل اختبار العدالة: توزيع الفوز غير متساوٍ');
  process.exit(1);
}
console.log('\n✓ نجح اختبار العدالة');
