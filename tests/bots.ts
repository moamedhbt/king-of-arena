/** بوتات بلا واجهة — تُستخدم في اختبارات المحاكاة والعدالة. */
import { ArenaSim, GONE, WARNED, SOLID } from '../server/src/sim';
import { TILES, tileAt, config } from '../shared/src/index';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** يوجّه كل لاعب حي نحو أقرب خصم، ويتفادى الحواف والبلاطات المنهارة. */
export function botStep(sim: ArenaSim, aggression = 1, flee = true) {
  const alive = sim.alivePlayers;
  for (const p of alive) {
    let nearest = null as null | (typeof alive)[number];
    let best = Infinity;
    for (const q of alive) {
      if (q.id === p.id) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < best) {
        best = d;
        nearest = q;
      }
    }

    let dx = 0;
    let dz = 0;
    if (nearest) {
      dx = nearest.x - p.x;
      dz = nearest.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      if (best < 2.0) {
        // ادفع بقوة
        dx *= aggression;
        dz *= aggression;
      }
    } else {
      dx = -Math.sign(p.x) * 0.3;
      dz = -Math.sign(p.z) * 0.3;
    }

    // تفادي السقوط: إن كانت البلاطة أمامك أو تحتك على وشك الانهيار، اتجه للمركز
    if (flee) {
      const here = tileAt(p.x, p.z);
      const bad =
        !here ||
        sim.tileStates[here.id] !== SOLID ||
        Math.abs(p.x) > config.arena.tileSize * 3.5 ||
        Math.abs(p.z) > config.arena.tileSize * 3.5;
      if (bad) {
        const nx = -p.x;
        const nz = -p.z;
        const l = Math.hypot(nx, nz) || 1;
        dx = (nx / l) * 1.2;
        dz = (nz / l) * 1.2;
        // إن كان المركز نفسه غير آمن، ابحث عن أقرب بلاطة صلبة
        const center = tileAt(0, 0);
        if (!center || sim.tileStates[center.id] !== SOLID) {
          let bestTile: (typeof TILES)[number] | null = null;
          let bd = Infinity;
          for (const t of TILES) {
            if (sim.tileStates[t.id] !== SOLID) continue;
            const d = Math.hypot(t.x - p.x, t.z - p.z);
            if (d < bd) {
              bd = d;
              bestTile = t;
            }
          }
          if (bestTile) {
            const l2 = Math.hypot(bestTile.x - p.x, bestTile.z - p.z) || 1;
            dx = (bestTile.x - p.x) / l2;
            dz = (bestTile.z - p.z) / l2;
          }
        }
      }
    }

    const useDash = nearest !== null && best < 2.6 && Math.random() < 0.5 * aggression;
    sim.setInput(p.id, clamp(dx, -1, 1), clamp(dz, -1, 1), useDash, true);
  }
}

/** يشغّل جولة كاملة بلا واجهة ويعيد ملخصًا. */
export function runBotRound(
  playerCount: number,
  seed: number,
  maxSec = 75,
  /** أداة موحّدة لكل البوتات — لعزل متغيّر الأداة في اختبار العدالة */
  item: string | null = null
) {
  const ids = Array.from({ length: playerCount }, (_, i) => `p${i}`);
  const sim = new ArenaSim({ seed, playerIds: ids, roundIndex: 1, startAlive: playerCount });
  sim.giveItems(Object.fromEntries(ids.map((id) => [id, item as any])));
  const dt = 1 / config.net.tickHz;
  let steps = 0;
  let finale = false;
  while (sim.aliveCount > 1 && sim.t < maxSec) {
    if (sim.t >= config.phase.arenaMax && !finale) {
      sim.triggerFinale();
      finale = true;
    }
    botStep(sim, 1);
    sim.step(dt);
    steps++;
    if (steps > 30 * (maxSec + 10)) break; // لا مرحلة عالقة
  }
  const winner = sim.alivePlayers[0]?.id ?? null;
  return {
    seed,
    durationSec: sim.t,
    winner,
    aliveCount: sim.aliveCount,
    fallOrder: sim.fallOrder.slice(),
    kos: sim.players.reduce((a, p) => a + p.kos, 0),
    tilesLeft: sim.tileStatesString().split('').filter((c) => c !== String(GONE)).length,
    warned: sim.tileStatesString().split('').filter((c) => c === String(WARNED)).length,
  };
}
