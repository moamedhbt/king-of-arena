import { Rng, deriveSeed } from '../rng';
import { config } from '../config';
import type { Puzzle, PuzzleType } from './types';
import { generateSequence } from './sequence';
import { generateArithmetic } from './arithmetic';
import { generateMemory } from './memory';
import { generateOdd } from './odd';

export * from './types';
export { solveNexts, generateSequence } from './sequence';
export { generateArithmetic } from './arithmetic';
export { generateMemory } from './memory';
export { generateOdd } from './odd';

export const PUZZLE_TYPES: PuzzleType[] = ['sequence', 'arithmetic', 'memory', 'odd'];

/** صعوبة الجولة: لمباراة من 5 جولات [2,4,5,7,9]، ولغيرها توزيع خطي من 2 إلى 9. */
export function roundDifficulty(round: number, totalRounds: number): number {
  const table = config.puzzle.difficultyByRound;
  if (totalRounds === table.length) {
    return table[Math.min(round - 1, table.length - 1)];
  }
  if (totalRounds <= 1) return config.puzzle.minDifficulty;
  const lo = config.puzzle.minDifficulty;
  const hi = config.puzzle.maxDifficulty;
  const d = lo + ((hi - lo) * (round - 1)) / (totalRounds - 1);
  return Math.round(d);
}

/** نوع الجولة: ترتيب مبذور، ولا يتكرر النوع نفسه جولتين متتاليتين. */
export function pickType(matchSeed: number, roundIndex: number, prevType: PuzzleType | null): PuzzleType {
  const cycle = Math.floor(roundIndex / PUZZLE_TYPES.length);
  const perm = new Rng(deriveSeed(matchSeed, 'types', cycle)).shuffled(PUZZLE_TYPES);
  let t = perm[roundIndex % PUZZLE_TYPES.length];
  if (t === prevType) {
    t = perm[(roundIndex + 1) % PUZZLE_TYPES.length];
    if (t === prevType) t = perm.find((x) => x !== prevType) ?? t;
  }
  return t;
}

export function generatePuzzle(
  matchSeed: number,
  roundIndex: number,
  difficulty: number,
  type: PuzzleType
): Puzzle {
  for (let attempt = 0; attempt < 12; attempt++) {
    const seed = deriveSeed(matchSeed, 'puzzle', roundIndex, type, attempt);
    let p: Puzzle | null = null;
    switch (type) {
      case 'sequence':
        p = generateSequence(seed, difficulty);
        break;
      case 'arithmetic':
        p = generateArithmetic(seed, difficulty);
        break;
      case 'memory':
        p = generateMemory(seed, difficulty);
        break;
      case 'odd':
        p = generateOdd(seed, difficulty);
        break;
    }
    if (p) return p;
  }
  // احتياطي مضمون: حساب سريع بسيط لا يفشل
  const fallback: Puzzle = {
    type: 'arithmetic',
    payload: {
      type: 'arithmetic',
      expr: '2 + 3',
      options: [5, 6, 4, 7],
      difficulty: 1,
    },
    answer: 5,
    options: [5, 6, 4, 7],
    timeLimitSec: config.phase.puzzle,
  };
  return fallback;
}

/** فحص إجابة اللغز في الخادم فقط. */
export function checkAnswer(p: Puzzle, answer: unknown): boolean {
  switch (p.type) {
    case 'memory': {
      const want = p.answer as number[];
      if (!Array.isArray(answer) || answer.length !== want.length) return false;
      return want.every((v, i) => Number(answer[i]) === v);
    }
    case 'odd': {
      return Number(answer) === (p.answer as number);
    }
    default:
      return Number(answer) === Number(p.answer) && Number.isFinite(Number(answer));
  }
}
