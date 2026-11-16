import type { PuzzlePayload } from './puzzles/types';

export type PhaseName =
  | 'LOBBY'
  | 'COUNTDOWN'
  | 'PUZZLE'
  | 'DRAFT'
  | 'ARENA_INTRO'
  | 'ARENA'
  | 'ROUND_RESULT'
  | 'MATCH_RESULT';

export type ItemId = 'charge' | 'shield' | 'anchor' | 'jump';
export const ITEM_IDS: ItemId[] = ['charge', 'shield', 'anchor', 'jump'];

export const PLAYER_COLORS = [
  '#ff5a5f',
  '#31c3ff',
  '#ffd23f',
  '#7bdc4a',
  '#c66bff',
  '#ff8a3d',
  '#33e0c0',
  '#f45ec7',
]; // 8 ألوان ثابتة

export interface LobbyPlayer {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  connected: boolean;
  score: number;
}

export interface RoomState {
  code: string;
  phase: PhaseName;
  rounds: number;
  round: number;
  hostId: string;
  players: LobbyPlayer[];
  youId: string;
  canStart: boolean;
}

export interface PhaseMsg {
  name: PhaseName;
  endsAt: number;
  round: number;
  totalRounds: number;
  data?: any;
}

export interface SnapPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  /** 0 = ميت، 1 = حي */
  a: number;
  /** الأداة المتبقية، null إن لا شيء (الفتحة الأولى) */
  it: ItemId | null;
  /** مخزون الأدوات كاملًا (حتى maxSlots) */
  its?: ItemId[];
  /** الأداة مفعّلة */
  ia: ItemId | null;
  /** الثواني المتبقية من الأداة المفعّلة (0 إن لا شيء) */
  iat?: number;
  /** رقم البلاطة المثبّتة بالمرساة، -1 إن لا شيء */
  at?: number;
  /** جاهزية الاندفاع 0..1 */
  dc: number;
  /** الاتجاه الذي ينظر إليه */
  fx: number;
  fz: number;
  /** مطرود؟ (منقطع) */
  off?: number;
  /** نقاط الحقل (سيطرة + إسقاط بلغم) */
  rp?: number;
}

export interface Snap {
  /** زمن الخادم المطلق */
  t: number;
  tick: number;
  players: SnapPlayer[];
  /** 81 حرفًا: 0 صلبة، 1 تحذير، 2 ساقطة، 3 ذهبت */
  tiles: string;
  /** بيكابات الأدوات الملقاة في الحلبة */
  pk?: Array<{ i: ItemId; x: number; z: number }>;
  /** البلاطات المكشوفة: n = 0..8 رقم، 9 لغم منفجر */
  mn?: Array<{ i: number; n: number }>;
  /** مناطق السيطرة: o = صاحب السيطرة (null = لا أحد أو متعددون) */
  zn?: Array<{ i: number; o: string | null }>;
}

export type SfxType =
  | 'hit'
  | 'ko'
  | 'fall'
  | 'warn'
  | 'dash'
  | 'item'
  | 'select'
  | 'join'
  | 'correct'
  | 'wrong';

export interface GameEvent {
  type: SfxType;
  /** شدة 0..1 للتأثيرات */
  s?: number;
  x?: number;
  z?: number;
  /** أعلى دفع مسموح */
  id?: string;
  /** معرف الضحية/المصدر */
  by?: string;
  t?: number;
}

export interface PuzzleResultRow {
  playerId: string;
  name: string;
  color: string;
  correct: boolean;
  /** الزمن الفعلي بالمللي ثانية، null إن لم يجب */
  effectiveMs: number | null;
  rank: number;
  bonus: number;
}

export interface RoundResultRow {
  playerId: string;
  name: string;
  color: string;
  rank: number;
  survival: number;
  kos: number;
  puzzleBonus: number;
  predictBonus: number;
  roundPoints: number;
  totalScore: number;
  /** نقاط حقل الملوك: سيطرة + إسقاط بلغم */
  field?: number;
  /** تفصيل مقروء لسبب النقاط (سيطرة/إسقاط/انفجار) */
  fieldWhy?: string;
  /** سبب السقوط: pushed | collapse | timeout | null إن نجا */
  deathCause: 'pushed' | 'collapse' | 'timeout' | null;
  killedByName: string | null;
}

export interface RoundResult {
  round: number;
  rows: RoundResultRow[];
  arenaDurationSec: number;
  fallOrder: string[];
}

export interface MatchRow {
  playerId: string;
  name: string;
  color: string;
  total: number;
  kos: number;
  roundWins: number;
  puzzleMsSum: number;
  tied?: boolean;
}

export interface MatchResult {
  rows: MatchRow[];
  winners: string[];
}

export interface DraftState {
  /** المخزون الحي لكل أداة */
  inventory: Record<ItemId, number>;
  endsAt: number;
  /** اختيارات اللاعبين الظاهرة للجميع بعد الحسم */
  picked?: Record<string, ItemId | null>;
}

export type PuzzleDataMsg = {
  round: number;
  difficulty: number;
  type: PuzzlePayload['type'];
  payload: PuzzlePayload;
  timeLimitMs: number;
  /** للحفظ: بداية عرض الوميض (للذاكرة) */
  flashStartAt?: number;
};
