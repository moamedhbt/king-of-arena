import { Rng, deriveSeed } from '../rng';
import { config } from '../config';
import type { Puzzle, OddPayload, OddShape } from './types';

/**
 * الدخيل — أشكال في حلقة، أربعة تحقق قاعدة خفية والباقي يخالفها.
 * التحقق: لا توجد قاعدة أخرى تفصل شكلًا واحدًا مختلفًا عن المطلوب.
 */

type RuleFamily = 'sidesEven' | 'sidesOdd' | 'dotsEven' | 'dotsOdd' | 'spinCW' | 'spinCCW' | 'symYes' | 'symNo';

function violators(shapes: OddShape[], test: (s: OddShape) => boolean): number[] {
  const out: number[] = [];
  shapes.forEach((s, i) => {
    if (!test(s)) out.push(i);
  });
  return out;
}

function singleViolatorIndexes(shapes: OddShape[]): Set<number> {
  const families: Array<(s: OddShape) => boolean> = [
    (s) => s.sides % 2 === 0,
    (s) => s.sides % 2 === 1,
    (s) => s.dots % 2 === 0,
    (s) => s.dots % 2 === 1,
    (s) => s.spin === 1,
    (s) => s.spin === -1,
    (s) => s.sym,
    (s) => !s.sym,
  ];
  for (let v = 3; v <= 8; v++) families.push((s) => s.sides === v);
  const res = new Set<number>();
  for (const f of families) {
    const bad = violators(shapes, f);
    if (bad.length === 1) res.add(bad[0]);
  }
  return res;
}

export function generateOdd(seed: number, difficulty: number): Puzzle<OddPayload> | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rng = new Rng(deriveSeed(seed, 'odd', attempt));
    const count = difficulty >= 6 ? 6 : 5;
    const family = rng.pick<RuleFamily>([
      'sidesEven',
      'sidesOdd',
      'dotsEven',
      'dotsOdd',
      'spinCW',
      'symYes',
      ...(difficulty >= 5 ? (['spinCCW', 'symNo'] as RuleFamily[]) : []),
    ]);

    const fixedSides = rng.int(3, 7);
    const fixedDots = rng.int(0, 3);
    const fixedSpin: 1 | -1 = rng.bool() ? 1 : -1;
    const fixedSym = rng.bool();

    const make = (i: number): OddShape => {
      const base: OddShape = { sides: fixedSides, dots: fixedDots, spin: fixedSpin, sym: fixedSym };
      return { ...base };
    };

    const shapes: OddShape[] = [];
    const oddIndex = rng.int(0, count - 1);
    for (let i = 0; i < count; i++) {
      const s = make(i);
      const isOdd = i === oddIndex;
      switch (family) {
        case 'sidesEven':
          s.sides = isOdd ? rng.pick([3, 5, 7]) : rng.pick([4, 6, 8]);
          break;
        case 'sidesOdd':
          s.sides = isOdd ? rng.pick([4, 6, 8]) : rng.pick([3, 5, 7]);
          break;
        case 'dotsEven':
          s.dots = isOdd ? rng.pick([1, 3]) : rng.pick([0, 2]);
          break;
        case 'dotsOdd':
          s.dots = isOdd ? rng.pick([0, 2]) : rng.pick([1, 3]);
          break;
        case 'spinCW':
          s.spin = isOdd ? -1 : 1;
          break;
        case 'spinCCW':
          s.spin = isOdd ? 1 : -1;
          break;
        case 'symYes':
          s.sym = !isOdd;
          break;
        case 'symNo':
          s.sym = isOdd;
          break;
      }
      shapes.push(s);
    }

    const found = singleViolatorIndexes(shapes);
    if (found.size !== 1 || !found.has(oddIndex)) continue;
    // لا بد أن يكون الشكل الدخيل متمايزًا بصريًا
    const oddShape = shapes[oddIndex];
    if (family.startsWith('sides') && shapes.filter((s) => s.sides === oddShape.sides).length === count) continue;

    return {
      type: 'odd',
      payload: { type: 'odd', shapes, difficulty },
      answer: oddIndex,
      timeLimitSec: config.phase.puzzle,
      options: undefined,
    };
  }
  return null;
}
