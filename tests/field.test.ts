/**
 * اختبار «حقل الملوك»: ألغام مخفية بأرقام مشتركة + مناطق سيطرة.
 * يتحقق من: عدالة الخريطة (تماثل، بداية آمنة)، صحة الأرقام، الانفجار والشلل،
 * نقاط السيطرة، وأن أحدًا لا يسقط من الحلبة في هذا الوضع.
 */
import { ArenaSim } from '../server/src/sim';
import { config, TILES, tileAt, spawnPositions } from '../shared/src/index';

config.mines.enabled = true;
config.collapse.enabled = false;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error('  ✗', msg);
  } else console.log('  ✓', msg);
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const mk = (n: number, seed: number) =>
  new ArenaSim({ seed, playerIds: ids(n), roundIndex: 0, startAlive: n });

console.log('— حقل الملوك —');

// 1) الخريطة: العدد صحيح، والتماثل تام (لكل لغم توأم معكوس)
{
  let allMirrored = true;
  let countOk = true;
  for (let s = 0; s < 40; s++) {
    const sim = mk(4, 7000 + s);
    if (sim.mineTiles.size < config.mines.count - 1) countOk = false;
    for (const id of sim.mineTiles) {
      const t = TILES[id];
      const twin = TILES.find((q) => Math.abs(q.x + t.x) < 1e-6 && Math.abs(q.z + t.z) < 1e-6);
      if (!twin || !sim.mineTiles.has(twin.id)) allMirrored = false;
    }
  }
  check(countOk, `عدد الألغام ≈ ${config.mines.count} في كل البذور`);
  check(allMirrored, 'كل لغم له توأم معكوس حول المركز — لا أفضلية لجهة');
}

// 2) نقاط البداية وجيرانها ومناطق السيطرة خالية من الألغام
{
  let safeStarts = true;
  let safeZones = true;
  for (const n of [2, 4, 6, 8]) {
    for (let s = 0; s < 25; s++) {
      const sim = mk(n, 9100 + s);
      for (const sp of spawnPositions(n)) {
        const t = tileAt(sp.x, sp.z);
        if (!t) continue;
        if (sim.mineTiles.has(t.id)) safeStarts = false;
        // جيران نقطة البداية آمنون أيضًا: أول خطوة لا تقتل أبدًا
        for (const nb of TILES.filter(
          (q) => Math.abs(q.gx - t.gx) <= 1 && Math.abs(q.gz - t.gz) <= 1
        ))
          if (sim.mineTiles.has(nb.id)) safeStarts = false;
      }
      for (const z of sim.zones) if (sim.mineTiles.has(z.tile)) safeZones = false;
    }
  }
  check(safeStarts, 'نقطة البداية وكل جيرانها آمنة (2/4/6/8 لاعبين)');
  check(safeZones, 'مناطق السيطرة نفسها خالية من الألغام');
}

// 3) الرقم المكشوف = عدد الألغام المجاورة فعلًا
{
  const sim = mk(4, 4242);
  let ok = true;
  for (const t of TILES) {
    if (sim.mineTiles.has(t.id)) continue;
    const manual = TILES.filter(
      (q) =>
        q.id !== t.id &&
        Math.abs(q.gx - t.gx) <= 1 &&
        Math.abs(q.gz - t.gz) <= 1 &&
        sim.mineTiles.has(q.id)
    ).length;
    if (sim.numberAt(t.id) !== manual) ok = false;
  }
  check(ok, 'رقم كل بلاطة = عدد الألغام في البلاطات الثماني المجاورة');
}

// 4) الكشف يحدث بالمشي، والرقم يُنشر للجميع
{
  const sim = mk(2, 777);
  const safe = TILES.find((t) => !sim.mineTiles.has(t.id) && sim.numberAt(t.id) > 0)!;
  const p = sim.players[0];
  p.x = safe.x;
  p.z = safe.z;
  p.lastTile = -1;
  sim.step(1 / 30);
  check(sim.mineNum[safe.id] === sim.numberAt(safe.id), 'الوقوف على بلاطة يكشف رقمها للجميع');
  check(
    sim.events.some((e) => e.type === 'reveal' && e.s === sim.numberAt(safe.id)),
    'حدث reveal يحمل الرقم (كل اللاعبين يرونه)'
  );
}

// 5) الانفجار: شلل + ارتداد + نزع اللغم + مكافأة لمن دفعك خلال النافذة
{
  const sim = mk(2, 1313);
  const mine = TILES[[...sim.mineTiles][0]];
  const victim = sim.players[0];
  const pusher = sim.players[1];
  victim.x = mine.x;
  victim.z = mine.z;
  victim.lastTile = -1;
  victim.lastHitBy = pusher.id;
  victim.lastHitAt = sim.t;
  sim.step(1 / 30);
  check(victim.stunUntil > sim.t, `الضحية مشلولة ${config.mines.stunSec}s بعد الانفجار`);
  check(Math.hypot(victim.vx, victim.vz) > 5, 'ارتداد فعلي بعيدًا عن مركز اللغم');
  check(!sim.armed.has(mine.id), 'اللغم يُنزع بعد انفجاره (لا ينفجر مرتين)');
  check(sim.mineNum[mine.id] === 9, 'مكان اللغم يبقى ظاهرًا كحفرة للجميع');
  check(
    sim.roundPointsOf(pusher.id) === config.mines.ambushBonus,
    `+${config.mines.ambushBonus} لمن دفع خصمه إلى لغم`
  );
  // الشلل يُلغي التحكم
  sim.setInput(victim.id, 1, 0, true, false, 0);
  const vxBefore = victim.vx;
  sim.step(1 / 30);
  check(victim.vx <= vxBefore + 0.001, 'لا تحكم أثناء الشلل (الزخم وحده)');
}

// 6) نقاط السيطرة: منفردًا +1/ث، ومتزاحمَين لا شيء
{
  const sim = mk(2, 2024);
  const z = sim.zones[0];
  const a = sim.players[0];
  const b = sim.players[1];
  a.x = z.x;
  a.z = z.z;
  b.x = 99;
  b.z = 99;
  for (let i = 0; i < 90; i++) sim.step(1 / 30); // 3 ثوانٍ
  check(sim.roundPointsOf(a.id) >= 2, `سيطرة منفردة ≈ +${config.mines.zoneScorePerSec}/ث (حصل ${sim.roundPointsOf(a.id)} في 3 ثوانٍ)`);

  const sim2 = mk(2, 2025);
  const z2 = sim2.zones[0];
  sim2.players[0].x = z2.x;
  sim2.players[0].z = z2.z;
  sim2.players[1].x = z2.x + 0.4;
  sim2.players[1].z = z2.z;
  for (let i = 0; i < 90; i++) sim2.step(1 / 30);
  check(
    sim2.roundPointsOf(sim2.players[0].id) === 0 && sim2.roundPointsOf(sim2.players[1].id) === 0,
    'وجود خصم في المنطقة يوقف العدّ للطرفين'
  );
}

// 7) لا سقوط ولا موت في هذا الوضع: 8 لاعبين × 45 ثانية
{
  const sim = mk(8, 31337);
  for (let i = 0; i < 30 * 45; i++) {
    for (const p of sim.players) sim.setInput(p.id, Math.cos(i / 7 + p.index), Math.sin(i / 5 + p.index), i % 40 === 0, false, 0);
    sim.step(1 / 30);
  }
  check(sim.aliveCount === 8, 'لا أحد يسقط أو يموت — الأرضية ثابتة');
  const R = (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2;
  check(
    sim.players.every((p) => Math.hypot(p.x, p.z) <= R),
    'كل اللاعبين داخل حدود الحلبة (حاجز الحافة يعمل)'
  );
}

// 8) الحتمية: نفس البذرة ⇒ نفس الحقل، وبذور مختلفة ⇒ حقول مختلفة
{
  const a = [...mk(4, 555).mineTiles].sort((x, y) => x - y).join(',');
  const b = [...mk(4, 555).mineTiles].sort((x, y) => x - y).join(',');
  const c = [...mk(4, 556).mineTiles].sort((x, y) => x - y).join(',');
  check(a === b, 'نفس البذرة تُنتج نفس حقل الألغام (حتمية الخادم)');
  check(a !== c, 'بذرة مختلفة ⇒ حقل مختلف (لا تكرار بين المباريات)');
}

// 9) عدالة العبور: المسافة من كل نقطة بداية إلى أقرب منطقة سيطرة متقاربة
{
  let worst = 0;
  for (let s = 0; s < 30; s++) {
    const sim = mk(4, 8800 + s);
    const d = spawnPositions(4).map((sp) =>
      Math.min(...sim.zones.map((z) => Math.hypot(z.x - sp.x, z.z - sp.z)))
    );
    worst = Math.max(worst, Math.max(...d) - Math.min(...d));
  }
  check(worst < 0.5, `فارق المسافة إلى أقرب منطقة بين اللاعبين ${worst.toFixed(2)} وحدة (< 0.5)`);
}

if (failures) {
  console.error(`\n${failures} فحص فشل`);
  process.exit(1);
}
console.log('\n✓ نجح اختبار حقل الملوك');
