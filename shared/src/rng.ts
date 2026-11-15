/**
 * عشوائية مشتركة ومبذورة — لا حظ فردي، ولا Math.random في أي مسار لعب.
 */

/** FNV-1a 32-bit */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** يولّد بذرة فرعية من بذرة أساس + أجزاء — نفس المدخلات = نفس البذرة دائمًا. */
export function deriveSeed(base: number, ...parts: Array<string | number>): number {
  let h = base >>> 0;
  for (const p of parts) {
    const v = typeof p === 'number' ? Math.imul(p | 0, 0x9e3779b1) : hashString(p);
    h ^= v >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** PRNG سريع وحتمي (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed >>> 0);
  }
  /** [0,1) */
  f(): number {
    return this.next();
  }
  /** عدد صحيح في [min,max] شاملًا */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** عنصر عشوائي */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  /** تبديل داخلي (Fisher–Yates) ويعيد المصفوفة نفسها */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** نسخة مبدّلة */
  shuffled<T>(arr: readonly T[]): T[] {
    return this.shuffle(arr.slice());
  }
  /** عناصر متمايزة من 0..n-1 */
  sampleIndices(n: number, count: number): number[] {
    const idx = Array.from({ length: n }, (_, i) => i);
    return this.shuffle(idx).slice(0, count).sort((a, b) => a - b);
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
}

/** كود غرفة بلا أحرف ملتبسة (بلا O و I و 0 و 1). */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomRoomCode(rand: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}
