import { config } from './config';

/**
 * نقاط البقاء = 10 × (n − المركز) ÷ (n − 1) مقرَّبة لأقرب 0.5
 * ينتج عنه للأخير 0 لا 1. الجدول في الواجهة يُحسب من هذه الدالة، لا يُكتب يدويًا.
 */
export function survivalPoints(n: number, rank: number): number {
  if (n <= 1) return 0;
  const raw = (config.scoring.survivalMax * (n - rank)) / (n - 1);
  const step = config.scoring.survivalRoundTo;
  // تقريب آمن من أخطاء الفاصلة العائمة
  return Math.round(raw / step) * step;
}

/** جدول البقاء لعدد لاعبين معيّن — مرتّب من المركز الأول. */
export function survivalTable(n: number): number[] {
  const out: number[] = [];
  for (let r = 1; r <= n; r++) out.push(survivalPoints(n, r));
  return out;
}

/**
 * يحوّل ترتيب السقوط إلى مراكز مع تقاسم المتوسط لمن سقطوا في نفس التِك.
 * fallOrder: معرفات اللاعبين مرتبة بحسب وقت السقوط تنازليًا (الأول سقط أولًا)
 * survivors: من بقي حيًا حتى النهاية (يتقاسمون المراكز الأولى)
 */
export function computeRanks(fallOrder: string[], survivors: string[]): Map<string, number> {
  const groups: string[][] = [];
  // الباقون في القمة، ثم الساقطون من الأحدث سقوطًا إلى الأقدم
  if (survivors.length) groups.push(survivors);
  const reversed = fallOrder.slice().reverse();
  for (const id of reversed) groups.push([id]);
  const ranks = new Map<string, number>();
  let slot = 1;
  for (const g of groups) {
    const avg = (slot + slot + g.length - 1) / 2;
    for (const id of g) ranks.set(id, avg);
    slot += g.length;
  }
  return ranks;
}

/** نقاط البقاء لمجموعة متقاسمي المركز (متوسط نقاط المراكز) */
export function sharedSurvivalPoints(n: number, slotStart: number, count: number): number {
  if (count <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += survivalPoints(n, slotStart + i);
  const avg = sum / count;
  const step = config.scoring.survivalRoundTo;
  return Math.round(avg / step) * step;
}
