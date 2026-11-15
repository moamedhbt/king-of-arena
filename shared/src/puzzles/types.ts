export type PuzzleType = 'sequence' | 'arithmetic' | 'memory' | 'odd';

export interface SequencePayload {
  type: 'sequence';
  kind: string;
  terms: number[];
  options: number[];
  difficulty: number;
}

export interface ArithmeticPayload {
  type: 'arithmetic';
  expr: string;
  options: number[];
  difficulty: number;
}

export interface MemoryPayload {
  type: 'memory';
  cols: number;
  rows: number;
  count: number;
  flashSec: number;
  /** مهلة قبل أول وميض (ms) */
  preFlashMs: number;
  difficulty: number;
}

export interface OddShape {
  sides: number;
  dots: number;
  /** 1 = مع عقارب الساعة، -1 = عكسها */
  spin: 1 | -1;
  /** يظهر محور تماثل متقطع */
  sym: boolean;
}

export interface OddPayload {
  type: 'odd';
  shapes: OddShape[];
  difficulty: number;
}

export type PuzzlePayload =
  | SequencePayload
  | ArithmeticPayload
  | MemoryPayload
  | OddPayload;

export interface Puzzle<P extends PuzzlePayload = PuzzlePayload> {
  type: PuzzleType;
  payload: P;
  /** لا يُرسل للعميل أبدًا */
  answer: unknown;
  /** مدة المرحلة بالثواني (تشمل الوميض في الذاكرة) */
  timeLimitSec: number;
  /** خيارات MCQ إن وُجدت */
  options?: number[];
  /** خطة الوميض للذاكرة: إزاحات بالمللي ثانية من بداية المرحلة */
  flashPlan?: { cell: number; atMs: number }[];
}
