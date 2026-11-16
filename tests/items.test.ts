/**
 * اختبار الأدوات بلا واجهة (البند 1/ز): يتأكد أن **الأثر الفعلي** حدث في الفيزياء،
 * لا أن الرسالة وصلت فقط.
 *
 *   الضربة  → الدفع يتضاعف (×2) مع الحدث charged
 *   الدرع   → الدفع الواصل صفر، ودفعها هي صفر
 *   المرساة → البلاطة لا تسقط طوال مدة التثبيت، والسرعة ×0.7
 *   القفزة  → ارتفاع y يتجاوز 1
 *
 * التشغيل: npx tsx tests/items.test.ts
 */
import { ArenaSim } from '../server/src/sim';
import { config, TILES, GONE as _G, type ItemId } from '../shared/src/index';

// هذه المجموعة تختبر وضع «انهيار الأرضية» الكلاسيكي صراحةً (الوضع الافتراضي الآن هو حقل الملوك)
config.collapse.enabled = true;
config.mines.enabled = false;

const DT = 1 / 30;
let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}: ${msg}`);
};
const ok = (name: string, detail: string) => console.log(`  ✓ ${name} — ${detail}`);

function newSim(seed = 1234): ArenaSim {
  const sim = new ArenaSim({ seed, playerIds: ['a', 'b'], roundIndex: 0, startAlive: 2 });
  // موضعان مصطنعان: a في المركز و b على تماس معه
  const a = sim.byId('a')!;
  const b = sim.byId('b')!;
  a.x = 0;
  a.z = 0;
  a.y = 0;
  b.x = 0;
  b.z = config.physics.radius * 2 * 0.97;
  b.y = 0;
  return sim;
}

/** يدفع a نحو b باندفاع ويعيد سرعة b بعد أول تلامس */
function dashImpact(item: ItemId | null): { speed: number; charged: boolean } {
  const sim = newSim();
  const a = sim.byId('a')!;
  const b = sim.byId('b')!;
  if (item) a.items = [item];
  sim.setInput('a', 0, 1, true, !!item); // اتجاه +z مع اندفاع + تفعيل الأداة
  sim.setInput('b', 0, 0, false, false);
  let speed = 0;
  let charged = false;
  for (let i = 0; i < 10; i++) {
    const before = b.vz;
    sim.step(DT);
    if (speed === 0 && Math.abs(b.vz) > Math.abs(before) + 0.01) speed = Math.hypot(b.vx, b.vz);
    for (const e of sim.events) if (e.type === 'hit' && e.charged) charged = true;
  }
  return { speed, charged };
}

console.log('— أثر الأدوات في الفيزياء —');

// ============ 1) الضربة: الدفع ×2 ============
{
  const plain = dashImpact(null);
  const charged = dashImpact('charge');
  const bonus = config.dash.bonus;
  const delta = charged.speed - plain.speed;
  if (plain.speed <= 0) fail('الضربة', 'لا اندفاع في الحالة الأساسية');
  else if (!charged.charged) fail('الضربة', 'حدث الإصابة لم يحمل charged=true');
  else if (Math.abs(delta - bonus) > 0.6)
    fail('الضربة', `زيادة الدفع ${delta.toFixed(2)} بدل ${bonus} (المضاعف لم يُطبَّق)`);
  else ok('الضربة', `دفع إضافي +${delta.toFixed(2)} = bonus ×2 (${plain.speed.toFixed(2)} → ${charged.speed.toFixed(2)})`);
}

// ============ 2) الدرع: يمنع الدفع ولا يدفع ============
{
  // (أ) خصم يندفع نحو المدعوم → لا دفع يصل إليه
  const sim = newSim();
  const a = sim.byId('a')!;
  const b = sim.byId('b')!;
  b.items = ['shield'];
  sim.setInput('b', 0, 0, false, true);
  sim.step(DT);
  const shieldActive = sim.byId('b')!.itemActiveUntil > sim.t;
  sim.setInput('a', 0, 1, true, false); // اندفاع عادي
  let maxB = 0;
  for (let i = 0; i < 20; i++) {
    sim.step(DT);
    maxB = Math.max(maxB, Math.hypot(b.vx, b.vz));
  }
  if (!shieldActive) fail('الدرع', 'الدرع لم يُفعّل');
  else if (maxB > 1.0) fail('الدرع', `الدفع وصل رغم الدرع: سرعة ${maxB.toFixed(2)}`);
  else ok('الدرع/الامتصاص', `صدّ الضربة العادية (${maxB.toFixed(2)})`);

  // (ج) المضادّ: الضربة المشحونة تكسر الدرع
  const sim3 = newSim();
  const a3 = sim3.byId('a')!;
  const b3 = sim3.byId('b')!;
  b3.items = ['shield'];
  sim3.setInput('b', 0, 0, false, true);
  sim3.step(DT);
  a3.items = ['charge'];
  sim3.setInput('a', 0, 1, true, true);
  let maxB3 = 0;
  for (let i = 0; i < 20; i++) {
    sim3.step(DT);
    maxB3 = Math.max(maxB3, Math.hypot(b3.vx, b3.vz));
  }
  const broke = sim3.byId('b')!.itemActiveUntil <= sim3.t;
  if (!broke) fail('المضادّ', 'الضربة المشحونة لم تكسر الدرع');
  else if (maxB3 < 2) fail('المضادّ', `الدرع انكسر لكن دون دفع (${maxB3.toFixed(2)})`);
  else ok('المضادّ', `الضربة المشحونة كسرت الدرع ودفعته (${maxB3.toFixed(2)})`);

  // (ب) المدعوم هو من يندفع → لا يدفع خصمه
  const sim2 = newSim();
  const a2 = sim2.byId('a')!;
  const b2 = sim2.byId('b')!;
  b2.items = ['shield'];
  sim2.setInput('b', 0, 0, false, true);
  sim2.step(DT);
  b2.z = a2.z + config.physics.radius * 2 * 0.97; // يقفز فوق a2
  sim2.setInput('b', 0, -1, true, false);
  let maxA2 = 0;
  for (let i = 0; i < 20; i++) {
    sim2.step(DT);
    maxA2 = Math.max(maxA2, Math.hypot(a2.vx, a2.vz));
  }
  if (maxA2 > 1.0) fail('الدرع', `الدرع دفع الخصم: سرعة ${maxA2.toFixed(2)}`);
  else ok('الدرع/الدفع', `المدعوم لم يدفع خصمه (${maxA2.toFixed(2)})`);
}

// ============ 3) المرساة: البلاطة لا تسقط + السرعة ×0.7 ============
{
  const sim = newSim(777);
  const a = sim.byId('a')!;
  b: {
    const b = sim.byId('b')!;
    b.alive = false; // نُخرج الخصم لتفادي التصادم
  }
  // نمشي حتى تصبح بلاطة a في حالة تحذير
  let warned = false;
  for (let i = 0; i < 60 * 30 && !warned; i++) {
    sim.step(DT);
    const t = TILES.find((tt) => Math.abs(tt.x - a.x) < 1e-6 && Math.abs(tt.z - a.z) < 1e-6);
    if (t && sim.tileStates[t.id] !== 0) warned = true;
  }
  const tile = TILES.find((tt) => Math.abs(tt.x - a.x) < 0.9 && Math.abs(tt.z - a.z) < 0.9)!;
  a.items = ['anchor'];
  sim.setInput('a', 0, 0, false, true);
  sim.step(DT);
  const anchored = sim.byId('a')!.anchorUntil > sim.t;
  let collapsed = false;
  const steps = Math.floor((config.items.anchor.duration - 0.1) / DT);
  for (let i = 0; i < steps; i++) {
    sim.step(DT);
    if (sim.tileStates[tile.id] === 2) collapsed = true;
  }
  if (!anchored) fail('المرساة', 'المرساة لم تُفعّل');
  else if (collapsed) fail('المرساة', `البلاطة ${tile.id} سقطت رغم التثبيت (تحذير=${warned})`);
  else ok('المرساة', `البلاطة ${tile.id} ثبتت ${config.items.anchor.duration}s (تحذير سابق=${warned})`);

  // السرعة ×0.7: نقارن التسارع مع/بدون
  const accel = (anchor: boolean) => {
    const s2 = newSim(99);
    const p = s2.byId('a')!;
    s2.byId('b')!.alive = false;
    p.x = 0;
    p.z = 0;
    p.vx = 0;
    p.vz = 0;
    if (anchor) {
      p.items = ['anchor'];
      s2.setInput('a', 0, 0, false, true);
      s2.step(DT);
    }
    s2.setInput('a', 1, 0, false, false);
    for (let i = 0; i < 12; i++) s2.step(DT);
    return Math.abs(s2.byId('a')!.vx);
  };
  const v0 = accel(false);
  const v1 = accel(true);
  const r = v0 > 0 ? v1 / v0 : 0;
  const want = config.items.anchor.speedFactor;
  if (Math.abs(r - want) > 0.12) fail('المرساة/السرعة', `النسبة ${r.toFixed(2)} بدل ${want}`);
  else ok('المرساة/السرعة', `×${r.toFixed(2)} (المطلوب ${want})`);
}

// ============ 4) القفزة: ارتفاع حقيقي ============
{
  const sim = newSim(321);
  const a = sim.byId('a')!;
  sim.byId('b')!.alive = false;
  a.items = ['jump'];
  sim.setInput('a', 0, 0, false, true);
  sim.step(DT);
  let peak = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(DT);
    peak = Math.max(peak, sim.byId('a')!.y);
  }
  const used = sim.byId('a')!.items.length === 0;
  if (!used) fail('القفزة', 'الأداة لم تُستهلك');
  else if (peak <= 1) fail('القفزة', `الارتفاع الأقصى ${peak.toFixed(2)} (المطلوب > 1)`);
  else ok('القفزة', `ذروة الارتفاع ${peak.toFixed(2)}`);
}

// ============ 5) الاستهلاك مرة واحدة فقط ============
{
  const sim = newSim(55);
  const a = sim.byId('a')!;
  sim.byId('b')!.alive = false;
  a.items = ['jump'];
  sim.setInput('a', 0, 0, false, true);
  sim.step(DT);
  const firstVy = sim.byId('a')!.vy;
  // محاولة ثانية أثناء الطيران: يجب ألا يحدث شيء
  a.y = 1.5;
  sim.setInput('a', 0, 0, false, true);
  sim.step(DT);
  const secondVy = sim.byId('a')!.vy;
  if (firstVy <= 0.5) fail('مرة واحدة', `القفزة الأولى لم تعمل (vy=${firstVy.toFixed(2)})`);
  else if (secondVy > config.items.jump.impulse * 0.95)
    fail('مرة واحدة', `الأداة نُفّذت مرتين (vy=${secondVy.toFixed(2)})`);
  else ok('مرة واحدة', `القفزة الثانية مُنعت (vy=${secondVy.toFixed(2)})`);
}

if (failures) {
  console.error(`\n✗ فشل ${failures} تحقق في الأدوات`);
  process.exit(1);
}
console.log('\n✓ كل تحققات الأدوات نجحت');
