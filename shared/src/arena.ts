import { config } from './config';

export interface TileDef {
  id: number;
  gx: number;
  gz: number;
  ring: number;
  x: number;
  z: number;
}

export const PITCH = config.arena.tileSize + config.arena.tileGap;

/**
 * حلبة ثمانية الأضلاع: شبكة 9×9 يُقطع من كل زاوية مربّع cornerCut×cornerCut.
 * الحلقة = مسافة Chebyshev من المركز (تبقى صالحة للانهيار الحلقي).
 */
export function buildTiles(): TileDef[] {
  const size = config.arena.gridSize;
  const half = (size - 1) / 2;
  const cut = config.arena.cornerCut ?? 0;
  const tiles: TileDef[] = [];
  let id = 0;
  for (let gz = 0; gz < size; gz++) {
    for (let gx = 0; gx < size; gx++) {
      const dx = gx - half;
      const dz = gz - half;
      // قطع الزوايا لصناعة الثمانية
      if (cut > 0 && Math.abs(dx) + Math.abs(dz) > 2 * half - cut) continue;
      tiles.push({
        id: id++,
        gx,
        gz,
        ring: Math.max(Math.abs(dx), Math.abs(dz)),
        x: dx * PITCH,
        z: dz * PITCH,
      });
    }
  }
  return tiles;
}

export const TILES = buildTiles();
export const TILE_COUNT = TILES.length;
export const CENTER_TILE = TILES.find((t) => t.gx === (config.arena.gridSize - 1) / 2 && t.gz === (config.arena.gridSize - 1) / 2)!;

/** بحث سريع بالشبكة (الزوايا المقطوعة غير موجودة) */
const BY_GRID = new Map<string, TileDef>(TILES.map((t) => [`${t.gx},${t.gz}`, t]));

/** البلاطة التي يقف فوقها موضع ما */
export function tileAt(x: number, z: number): TileDef | null {
  const half = (config.arena.gridSize - 1) / 2;
  const gx = Math.round(x / PITCH + half);
  const gz = Math.round(z / PITCH + half);
  if (gx < 0 || gz < 0 || gx >= config.arena.gridSize || gz >= config.arena.gridSize) return null;
  const t = BY_GRID.get(`${gx},${gz}`);
  if (!t) return null;
  const hs = config.arena.tileSize / 2;
  if (Math.abs(x - t.x) > hs || Math.abs(z - t.z) > hs) return null;
  return t;
}

/**
 * مواضع بداية متماثلة: كل اللاعبين على **نفس الحلقة** (spawnRing) موزّعين بزوايا متساوية.
 * سابقًا كانت دائرة نصف قطرها ثابت، فوقع بعضهم على حلقة أقرب للمركز → ميزة غير عادلة.
 */
export function spawnPositions(n: number): Array<{ x: number; z: number }> {
  const ring = config.arena.spawnRing ?? 2;
  const slots = TILES.filter((t) => t.ring === ring).sort(
    (a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x)
  );
  if (!slots.length) {
    // احتياط: دائرة
    const r = config.arena.spawnRadius;
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return { x: Math.round(Math.cos(a) * r * 1000) / 1000, z: Math.round(Math.sin(a) * r * 1000) / 1000 };
    });
  }
  // اختيار بلاطات الحلقة الأقرب لزوايا متساوية (تماثل دقيق لـ 2 و4 و8)
  const used = new Set<number>();
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const target = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < slots.length; k++) {
      if (used.has(k)) continue;
      const a = Math.atan2(slots[k].z, slots[k].x);
      let d = Math.abs(Math.atan2(Math.sin(a - target), Math.cos(a - target)));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) break;
    used.add(best);
    out.push({ x: slots[best].x, z: slots[best].z });
  }
  return out;
}

/** حدود الحلقة (عدد البلاطات في كل حلقة): 1, 8, 16, 24, 32 */
export function ringTiles(ring: number): TileDef[] {
  return TILES.filter((t) => t.ring === ring);
}
