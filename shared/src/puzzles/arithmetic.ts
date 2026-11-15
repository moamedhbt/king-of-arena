import { Rng, deriveSeed } from '../rng';
import { config } from '../config';
import type { Puzzle, ArithmeticPayload } from './types';

/**
 * الحساب السريع — نتائج وسيطة صحيحة دائمًا، ومشتتات من أخطاء شائعة:
 * ترتيب العمليات، ±1 أو ±10، الإشارة.
 */

type Op = '+' | '-' | '*' | '/';
interface Node {
  op?: Op;
  v?: number;
  l?: Node;
  r?: Node;
  val: number;
}
interface Opts {
  allowDiv: boolean;
  allowParen: boolean;
  maxAbs: number;
}

const PREC: Record<Op, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
const SYM: Record<Op, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' };

function leaf(rng: Rng, maxAbs: number): Node {
  return { v: rng.int(1, Math.max(2, maxAbs)), val: 0 };
}
function numNode(v: number): Node {
  return { v, val: v };
}

function makeNode(rng: Rng, opsLeft: number, o: Opts): Node {
  if (opsLeft <= 0) {
    const n = leaf(rng, Math.min(o.maxAbs, 12));
    return numNode(n.v!);
  }
  const ops: Op[] = ['+', '-', '*'];
  if (o.allowDiv) ops.push('/');

  let op: Op = rng.pick(ops);

  if (op === '/') {
    const l = makeNode(rng, opsLeft - 1, o);
    const candidates: number[] = [];
    for (let d = 2; d <= 9; d++) {
      if (l.val % d === 0 && Math.abs(l.val / d) > 0) candidates.push(d);
    }
    if (!candidates.length) op = '+';
    else {
      const d = rng.pick(candidates);
      const r = numNode(d);
      return { op: '/', l, r, val: l.val / d };
    }
  }

  if (op === '*') {
    const l = makeNode(rng, opsLeft - 1, o);
    const r = numNode(rng.int(2, 9));
    const val = l.val * r.val;
    if (Math.abs(val) > o.maxAbs * 4) return makeNode(rng, opsLeft, o);
    // ضرب في عدد أكبر يفسد التدرّج؛ نلتزم بحد منطقي
    return { op: '*', l, r, val };
  }

  const leftOps = rng.int(0, opsLeft - 1);
  const rightOps = opsLeft - 1 - leftOps;
  // الأقواس لا تُنتج إلا من الصعوبة 6: نمنع شجرة يمينية عميقة قبلها
  const l = makeNode(rng, leftOps, o);
  const r = o.allowParen
    ? makeNode(rng, rightOps, o)
    : rightOps === 0
    ? numNode(rng.int(1, Math.min(o.maxAbs, 12)))
    : numNode(rng.int(1, Math.min(o.maxAbs, 12)));
  const val = op === '+' ? l.val + r.val : l.val - r.val;
  if (Math.abs(val) > o.maxAbs * 3) return makeNode(rng, opsLeft, o);
  return { op, l, r, val };
}

function render(n: Node, parentOp?: Op, isRight = false): string {
  if (!n.op) return String(n.v);
  const s = `${render(n.l!, n.op, false)} ${SYM[n.op]} ${render(n.r!, n.op, true)}`;
  const needParens =
    parentOp !== undefined &&
    (PREC[n.op] < PREC[parentOp] || (PREC[n.op] === PREC[parentOp] && isRight));
  return needParens ? `(${s})` : s;
}

/** تقييم من اليسار لليمين متجاهلًا الأولوية — الخطأ الشائع رقم 1 */
function evalLTR(n: Node): number | null {
  if (!n.op) return n.v!;
  const a = evalLTR(n.l!);
  const b = evalLTR(n.r!);
  if (a === null || b === null) return null;
  switch (n.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 || a % b !== 0 ? null : a / b;
  }
}

export function generateArithmetic(
  seed: number,
  difficulty: number
): Puzzle<ArithmeticPayload> | null {
  const opsCount = Math.min(5, 2 + Math.floor((difficulty - 1) / 2.5));
  const opts: Opts = {
    allowDiv: difficulty >= 3,
    allowParen: difficulty >= 6,
    maxAbs: difficulty <= 3 ? 12 : difficulty <= 6 ? 25 : 40,
  };

  for (let attempt = 0; attempt < 80; attempt++) {
    const rng = new Rng(deriveSeed(seed, 'arith', attempt));
    const tree = makeNode(rng, opsCount, opts);
    const correct = tree.val;
    if (!Number.isInteger(correct) || Math.abs(correct) > 999 || Math.abs(correct) < 2) continue;

    const pool: number[] = [];
    const ltr = evalLTR(tree);
    if (ltr !== null && Number.isInteger(ltr) && ltr !== correct) pool.push(ltr);
    pool.push(correct + 1, correct - 1, correct + 10, correct - 10, -correct, correct + 2, correct - 2);

    const distractors: number[] = [];
    for (const v of rng.shuffled(pool)) {
      if (v === correct || distractors.includes(v)) continue;
      distractors.push(v);
      if (distractors.length === config.puzzle.optionsCount - 1) break;
    }
    if (distractors.length < config.puzzle.optionsCount - 1) continue;

    const options = rng.shuffled([correct, ...distractors]);
    return {
      type: 'arithmetic',
      payload: {
        type: 'arithmetic',
        expr: render(tree),
        options,
        difficulty,
      },
      answer: correct,
      options,
      timeLimitSec: config.phase.puzzle,
    };
  }
  return null;
}
