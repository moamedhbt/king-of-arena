import { Rng, deriveSeed } from '../rng';
import { config } from '../config';
import type { Puzzle, SequencePayload } from './types';

/**
 * المتتاليات — التوليد + حلّال يثبت أن الحل وحيد.
 * الحلّال يعدّد كل القواعد المعروفة المطابقة للحدود المعروضة؛ إن أعطت أكثر من
 * جواب مختلف يُرفض اللغز ويُعاد توليده ببذرة مشتقة.
 */

const EPS = 1e-9;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** كل القيم التالية الممكنة لقواعد معروفة مطابقة للحدود. */
export function solveNexts(terms: number[]): Set<number> {
  const out = new Set<number>();
  const n = terms.length;
  if (n < 3) return out;
  const eq = (a: number, b: number) => Math.abs(a - b) <= EPS;
  const push = (v: number) => {
    if (Number.isFinite(v) && Math.abs(v) < 1e9) out.add(round6(v));
  };

  // 1) حسابية: فرق ثابت
  {
    const d = terms[1] - terms[0];
    let ok = true;
    for (let i = 1; i < n - 1; i++) if (!eq(terms[i + 1] - terms[i], d)) ok = false;
    if (ok) push(terms[n - 1] + d);
  }

  // 2) هندسية: نسبة ثابتة
  if (Math.abs(terms[0]) > EPS) {
    const r = terms[1] / terms[0];
    let ok = true;
    for (let i = 1; i < n - 1; i++) if (!eq(terms[i + 1], terms[i] * r)) ok = false;
    if (ok) push(terms[n - 1] * r);
  }

  // 3) متناوبة: متتاليتان حسابيتان متداخلتان
  if (n >= 5) {
    const even = terms.filter((_, i) => i % 2 === 0);
    const odd = terms.filter((_, i) => i % 2 === 1);
    const constDiff = (a: number[]) => {
      if (a.length < 2) return null;
      const d = a[1] - a[0];
      for (let i = 1; i < a.length - 1; i++) if (!eq(a[i + 1] - a[i], d)) return null;
      return d;
    };
    const de = constDiff(even);
    const dodd = constDiff(odd);
    if (de !== null && dodd !== null) {
      if (n % 2 === 0) push(odd[odd.length - 1] + dodd);
      else push(even[even.length - 1] + de);
    }
  }

  // 4) فروق من الدرجة الثانية ثابتة (تربيعية)
  if (n >= 4) {
    const d1: number[] = [];
    for (let i = 0; i < n - 1; i++) d1.push(terms[i + 1] - terms[i]);
    let ok = true;
    const dd = d1[1] - d1[0];
    for (let i = 1; i < d1.length - 1; i++) if (!eq(d1[i + 1] - d1[i], dd)) ok = false;
    if (ok) push(terms[n - 1] + d1[d1.length - 1] + dd);
  }

  // 5) شبيهة بفيبوناتشي: a_n = p·a_{n−1} + q·a_{n−2}
  for (let p = -6; p <= 6; p++) {
    for (let q = -6; q <= 6; q++) {
      if (p === 0 && q === 0) continue;
      let ok = true;
      for (let i = 2; i < n; i++) {
        if (!eq(terms[i], p * terms[i - 1] + q * terms[i - 2])) { ok = false; break; }
      }
      if (ok) push(p * terms[n - 1] + q * terms[n - 2]);
    }
  }

  // 6) فيبوناتشي بإزاحة ثابتة: a_n = a_{n−1} + a_{n−2} + c
  if (n >= 4) {
    const c = terms[2] - terms[1] - terms[0];
    let ok = true;
    for (let i = 2; i < n; i++) {
      if (!eq(terms[i], terms[i - 1] + terms[i - 2] + c)) { ok = false; break; }
    }
    if (ok) push(terms[n - 1] + terms[n - 2] + c);
  }

  return out;
}

type Built = { terms: number[]; next: number; kind: string };

function build(rng: Rng, diff: number): Built | null {
  const band = diff <= 3 ? 'A' : diff <= 6 ? 'B' : 'C';
  const count = diff >= 7 ? 6 : 5; // عدد الحدود المعروضة
  const kinds =
    band === 'A'
      ? ['arith', 'geom', 'arith', 'geom']
      : band === 'B'
      ? ['alt', 'quad', 'alt', 'arith', 'geom']
      : ['fib', 'fibshift', 'quad', 'geom', 'alt', 'arith'];
  const kind = rng.pick(kinds);

  const series: number[] = [];
  switch (kind) {
    case 'arith': {
      const a1 = rng.int(1, band === 'A' ? 9 : 40);
      const d = (band === 'A' ? rng.int(2, 9) : rng.int(4, 19)) * rng.sign();
      for (let i = 0; i < count + 1; i++) series.push(a1 + d * i);
      break;
    }
    case 'geom': {
      const r = band === 'A' ? rng.pick([2, 3]) : rng.pick([2, 3, -2]);
      const a1 = rng.int(1, band === 'A' ? 4 : 9);
      for (let i = 0; i < count + 1; i++) series.push(a1 * Math.pow(r, i));
      break;
    }
    case 'alt': {
      let d1 = rng.int(2, 9) * rng.sign();
      let d2 = rng.int(2, 9) * rng.sign();
      if (d1 === d2) d2 = -d2;
      const e0 = rng.int(1, 20);
      const o0 = rng.int(1, 20);
      for (let i = 0; i < count + 1; i++) {
        series.push(i % 2 === 0 ? e0 + d1 * (i / 2) : o0 + d2 * ((i - 1) / 2));
      }
      break;
    }
    case 'quad': {
      const a1 = rng.int(1, 12);
      let d = rng.int(1, 9) * rng.sign();
      const dd = rng.int(1, band === 'C' ? 7 : 4) * rng.sign();
      let cur = a1;
      for (let i = 0; i < count + 1; i++) {
        series.push(cur);
        cur += d;
        d += dd;
      }
      break;
    }
    case 'fib':
    case 'fibshift': {
      let a = rng.int(1, 6);
      let b = rng.int(2, 9);
      const c = kind === 'fibshift' ? rng.int(-3, 3) : 0;
      series.push(a, b);
      for (let i = 2; i < count + 1; i++) {
        const v = series[i - 1] + series[i - 2] + c;
        series.push(v);
      }
      break;
    }
    default:
      return null;
  }

  // حدود معقولة الحجم
  if (series.some((v) => !Number.isFinite(v) || Math.abs(v) > 5000)) return null;
  const shown = series.slice(0, count);
  const next = series[count];
  if (shown.some((v, i) => i > 0 && v === shown[i - 1] && rng.f() < 0.5)) return null;
  return { terms: shown, next, kind };
}

/** مشتتات من أخطاء منطقية: قاعدة خاطئة، خطأ بخطوة، خطأ إشارة. */
function distractors(terms: number[], next: number, kind: string, rng: Rng): number[] {
  const last = terms[terms.length - 1];
  const prev = terms[terms.length - 2];
  const step = last - prev;
  const pool: number[] = [
    next + step, // خطوة زائدة
    next - step, // خطوة ناقصة
    last + step, // تجاهل آخر حد
    last * 2, // قاعدة خاطئة (هندسية)
    next + Math.abs(step), // خطأ إشارة
    next - Math.abs(step),
    next + rng.int(1, 9),
    next - rng.int(1, 9),
    kind === 'geom' ? last + (terms[1] - terms[0]) : last * 2,
  ];
  const uniq: number[] = [];
  for (const v of rng.shuffled(pool)) {
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v - next) < 1e-9) continue;
    if (uniq.some((u) => Math.abs(u - v) < 1e-9)) continue;
    uniq.push(v);
    if (uniq.length === config.puzzle.optionsCount - 1) break;
  }
  return uniq;
}

export function generateSequence(
  seed: number,
  difficulty: number,
  opts: { termsWindowSec?: number } = {}
): Puzzle<SequencePayload> | null {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = new Rng(deriveSeed(seed, 'seq', attempt));
    const built = build(rng, difficulty);
    if (!built) continue;
    const nexts = solveNexts(built.terms);
    // الحل وحيد: الحلّال يجد جوابًا واحدًا فقط وهو جوابنا
    if (nexts.size !== 1 || !nexts.has(round6(built.next))) continue;
    // حدود صحيحة وغير مكررة
    if (new Set(built.terms).size !== built.terms.length) continue;
    const ds = distractors(built.terms, built.next, built.kind, rng);
    if (ds.length < config.puzzle.optionsCount - 1) continue;
    const options = rng.shuffled([built.next, ...ds]);
    return {
      type: 'sequence',
      payload: {
        type: 'sequence',
        kind: built.kind,
        terms: built.terms,
        options,
        difficulty,
      },
      answer: built.next,
      options,
      timeLimitSec: opts.termsWindowSec ?? config.phase.puzzle,
    };
  }
  return null;
}
