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

/** 81 بلاطة 9×9 حول المركز (0,0)، والحلقة = مسافة Chebyshev من المركز. */
export function buildTiles(): TileDef[] {
  const size = config.arena.gridSize;
  const half = (size - 1) / 2;
  const tiles: TileDef[] = [];
  let id = 0;
  for (let gz = 0; gz < size; gz++) {
    for (let gx = 0; gx < size; gx++) {
      const dx = gx - half;
      const dz = gz - half;
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

/** البلاطة التي يقف فوقها موضع ما */
export function tileAt(x: number, z: number): TileDef | null {
  const half = (config.arena.gridSize - 1) / 2;
  const gx = Math.round(x / PITCH + half);
  const gz = Math.round(z / PITCH + half);
  if (gx < 0 || gz < 0 || gx >= config.arena.gridSize || gz >= config.arena.gridSize) return null;
  const t = TILES[gz * config.arena.gridSize + gx];
  const hs = config.arena.tileSize / 2;
  if (Math.abs(x - t.x) > hs || Math.abs(z - t.z) > hs) return null;
  return t;
}

/** مواضع بداية متماثلة: دائرة نصف قطرها spawnRadius بزوايا متساوية */
export function spawnPositions(n: number): Array<{ x: number; z: number }> {
  const r = config.arena.spawnRadius;
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push({ x: Math.round(Math.cos(a) * r * 1000) / 1000, z: Math.round(Math.sin(a) * r * 1000) / 1000 });
  }
  return out;
}

/** حدود الحلقة (عدد البلاطات في كل حلقة): 1, 8, 16, 24, 32 */
export function ringTiles(ring: number): TileDef[] {
  return TILES.filter((t) => t.ring === ring);
}
