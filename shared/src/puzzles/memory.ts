import { Rng, deriveSeed } from '../rng';
import { config } from '../config';
import type { Puzzle, MemoryPayload } from './types';

/**
 * الذاكرة — تومض بلاطات بالتتابع ثم يعيد اللاعب الترتيب.
 * ترتيب الوميض هو الجواب، لذلك لا يُرسل كاملًا للعميل: الخادم يبثّ وميضًا
 * واحدًا في وقته (flashPlan) والعميل يرسمه فقط.
 */
export function generateMemory(seed: number, difficulty: number): Puzzle<MemoryPayload> {
  const rng = new Rng(deriveSeed(seed, 'memory'));
  const [cols, rows] =
    difficulty <= 4 ? [3, 3] : difficulty <= 7 ? [4, 3] : [4, 4];

  const total = cols * rows;
  const count = Math.min(total, 3 + Math.floor(difficulty / 2));
  const flashSec =
    difficulty >= config.puzzle.flashHardFromDifficulty
      ? config.puzzle.flashSecHard
      : config.puzzle.flashSec;
  const preFlashMs = 600;

  const order = rng.shuffled(Array.from({ length: total }, (_, i) => i)).slice(0, count);

  const timeLimitSec =
    preFlashMs / 1000 + count * flashSec + 0.6 + config.puzzle.memoryAnswerSec;

  return {
    type: 'memory',
    payload: {
      type: 'memory',
      cols,
      rows,
      count,
      flashSec,
      preFlashMs,
      difficulty,
    },
    answer: order,
    timeLimitSec,
    flashPlan: order.map((cell, i) => ({ cell, atMs: preFlashMs + Math.round(i * flashSec * 1000) })),
  };
}
