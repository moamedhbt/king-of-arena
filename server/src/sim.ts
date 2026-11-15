/**
 * محاكاة الحلبة «الجسر» — 30 Hz، خادم فقط، حتمية بالكامل من بذرة.
 * لا تعتمد على Socket.io حتى يمكن تشغيلها بلا واجهة في الاختبارات.
 */
import {
  config,
  TILES,
  TILE_COUNT,
  tileAt,
  Rng,
  deriveSeed,
  spawnPositions,
  ITEM_IDS,
} from '../../shared/src/index';
import type { ItemId } from '../../shared/src/index';

export const SOLID = 0;
export const WARNED = 1;
export const GONE = 2;

export interface SimEvent {
  type: 'hit' | 'ko' | 'fall' | 'warn' | 'dash' | 'item';
  x?: number;
  z?: number;
  s?: number;
  id?: string;
  by?: string;
  /** لنوع الأداة في حدث item */
  itemType?: ItemId;
  /** هل كانت الضربة مشحونة (×2) */
  charged?: boolean;
}

export interface SimPlayer {
  id: string;
  index: number;

  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;

  alive: boolean;
  deathTime: number | null;
  deathCause: 'pushed' | 'collapse' | null;
  killerId: string | null;
  kos: number;

  inputX: number;
  inputZ: number;
  wantDash: boolean;
  wantItem: boolean;
  faceX: number;
  faceZ: number;

  dashReadyAt: number;
  dashUntil: number;
  dashHitUsed: boolean;
  onGround: boolean;

  lastHitBy: string | null;
  lastHitAt: number;

  item: ItemId | null;
  /** الأداة التي فُعّلت (تبقى بعد استهلاك المخزون) */
  lastItem: ItemId | null;
  itemActiveUntil: number;
  chargeUsed: boolean;
  anchorTile: number | null;
  anchorUntil: number;

  /** آخر لحظة تصادم مع كل لاعب، لمنع تعدد الضربات في نفس التلامس */
  touchAt: Map<string, number>;
}

export interface SimOptions {
  seed: number;
  playerIds: string[];
  roundIndex: number;
  /** من كان حيًا عند بداية الجولة (لموت المفاجئ) */
  startAlive?: number;
}

export class ArenaSim {
  t = 0;
  players: SimPlayer[] = [];
  tileStates = new Uint8Array(TILE_COUNT);
  /** وقت سقوط كل بلاطة (بالثواني من بداية الحلبة) */
  collapseAt = new Float64Array(TILE_COUNT).fill(Infinity);

  events: SimEvent[] = [];
  fallOrder: string[] = [];

  private queue: Array<{ tiles: number[]; intervalSec: number }> = [];
  private groupIdx = 0;
  private nextGroupAt = 0;
  private readonly startAlive: number;
  private readonly playerScale: number;
  private finaleTriggered = false;

  constructor(opts: SimOptions) {
    const n = opts.playerIds.length;
    this.startAlive = opts.startAlive ?? n;
    this.playerScale = config.collapse.playerCountScale[String(n) as '2'] ?? 1;

    // ---- بلاطات ----
    this.tileStates.fill(SOLID);
    const rngTiles = new Rng(deriveSeed(opts.seed, 'collapse', opts.roundIndex));
    for (const ringCfg of config.collapse.rings) {
      const tiles = TILES.filter((t) => t.ring === ringCfg.ring).map((t) => t.id);
      // ترتيب داخل الحلقة بمخلوط مبذور
      rngTiles.shuffle(tiles);
      for (let i = 0; i < tiles.length; i += ringCfg.groupSize) {
        this.queue.push({
          tiles: tiles.slice(i, i + ringCfg.groupSize),
          intervalSec: ringCfg.intervalSec,
        });
      }
    }
    this.nextGroupAt = config.collapse.grace;

    // ---- لاعبون ----
    const spawns = spawnPositions(n);
    const rngSpawn = new Rng(deriveSeed(opts.seed, 'spawn', opts.roundIndex));
    const order = rngSpawn.shuffled(Array.from({ length: n }, (_, i) => i));
    opts.playerIds.forEach((id, i) => {
      const s = spawns[order[i]];
      this.players.push({
        id,
        index: order[i],
        x: s.x,
        y: 0,
        z: s.z,
        vx: 0,
        vy: 0,
        vz: 0,
        alive: true,
        deathTime: null,
        deathCause: null,
        killerId: null,
        kos: 0,
        inputX: 0,
        inputZ: 0,
        wantDash: false,
        wantItem: false,
        faceX: Math.cos((-Math.PI / 2) + (order[i] * 2 * Math.PI) / n),
        faceZ: Math.sin((-Math.PI / 2) + (order[i] * 2 * Math.PI) / n),
        dashReadyAt: 0,
        dashUntil: 0,
        dashHitUsed: false,
        onGround: true,
        lastHitBy: null,
        lastHitAt: -999,
        item: null,
        lastItem: null,
        itemActiveUntil: 0,
        chargeUsed: false,
        anchorTile: null,
        anchorUntil: 0,
        touchAt: new Map(),
      });
    });
  }

  get aliveCount(): number {
    return this.players.reduce((a, p) => a + (p.alive ? 1 : 0), 0);
  }

  get alivePlayers(): SimPlayer[] {
    return this.players.filter((p) => p.alive);
  }

  byId(id: string): SimPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  setInput(id: string, x: number, z: number, dash: boolean, item: boolean) {
    const p = this.byId(id);
    if (!p || !p.alive) return;
    // لا يُصدَّق أي رقم من العميل سوى اتجاه مقصوص إلى طول 1
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    p.inputX = Number.isFinite(x) ? x : 0;
    p.inputZ = Number.isFinite(z) ? z : 0;
    if (Math.hypot(x, z) > 0.1) {
      p.faceX = x;
      p.faceZ = z;
    }
    if (dash) p.wantDash = true;
    if (item) p.wantItem = true;
  }

  private suddenDeath(): boolean {
    if (config.collapse.suddenDeathRequiresStartAbove2 && this.startAlive <= 2) return false;
    return this.aliveCount <= 2;
  }

  private emit(e: SimEvent) {
    if (this.events.length < 400) this.events.push(e);
  }

  // ---------------------------------------------------------------- البلاطات
  private updateCollapse() {
    const sd = this.suddenDeath() ? config.collapse.suddenDeathFactor : 1;
    const scale = this.playerScale * sd;

    while (this.groupIdx < this.queue.length && this.t >= this.nextGroupAt) {
      const g = this.queue[this.groupIdx++];
      let warned = 0;
      for (const id of g.tiles) {
        if (this.tileStates[id] === SOLID) {
          this.tileStates[id] = WARNED;
          this.collapseAt[id] = this.t + config.collapse.warnTime;
          warned++;
        }
      }
      if (warned) this.emit({ type: 'warn', s: warned });
      this.nextGroupAt = this.t + g.intervalSec * scale;
    }

    for (let id = 0; id < TILE_COUNT; id++) {
      if (this.tileStates[id] !== WARNED) continue;
      if (this.t < this.collapseAt[id]) continue;
      // المرساة توقف انهيار بلاطتك
      const anchored = this.players.some(
        (p) => p.alive && p.anchorTile === id && p.anchorUntil > this.t
      );
      if (anchored) {
        this.collapseAt[id] = this.players.find((p) => p.anchorTile === id)!.anchorUntil + 0.05;
        continue;
      }
      this.tileStates[id] = GONE;
      this.emit({ type: 'fall', x: TILES[id].x, z: TILES[id].z });
    }
  }

  /** الثانية 60: كل ما تبقى يسقط خلال finaleFallSec */
  triggerFinale() {
    if (this.finaleTriggered) return;
    this.finaleTriggered = true;
    const remaining = TILES.filter((t) => this.tileStates[t.id] !== GONE);
    const rng = new Rng(deriveSeed(1, 'finale'));
    rng.shuffle(remaining);
    remaining.forEach((t, i) => {
      const spread = (config.phase.finaleFallSec * i) / Math.max(1, remaining.length);
      if (this.tileStates[t.id] === SOLID) this.tileStates[t.id] = WARNED;
      this.collapseAt[t.id] = Math.min(this.collapseAt[t.id], this.t + spread);
    });
  }

  tileStatesString(): string {
    let s = '';
    for (let i = 0; i < TILE_COUNT; i++) s += String(this.tileStates[i]);
    return s;
  }

  private supported(x: number, z: number): boolean {
    const t = tileAt(x, z);
    if (!t) return false;
    return this.tileStates[t.id] !== GONE;
  }

  // ---------------------------------------------------------------- الأدوات
  private useItem(p: SimPlayer) {
    if (!p.item || !p.alive) return;
    if (p.itemActiveUntil > this.t) return; // مفعّلة بالفعل
    const item = p.item;
    p.item = null;
    // الأداة المفعّلة هي المرجع (كان يعتمد على lastItem من giveItems فقط)
    p.lastItem = item;
    switch (item) {
      case 'charge':
        p.itemActiveUntil = this.t + config.items.charge.duration;
        p.chargeUsed = false;
        break;
      case 'shield':
        p.itemActiveUntil = this.t + config.items.shield.duration;
        break;
      case 'anchor': {
        const t = tileAt(p.x, p.z);
        p.anchorTile = t ? Math.max(0, t.id) : null;
        p.anchorUntil = this.t + config.items.anchor.duration;
        // لكي يعرض العميل «نشط» مع حلقة العدّ التنازلي مثل بقية الأدوات
        p.itemActiveUntil = p.anchorUntil;
        break;
      }
      case 'jump':
        p.vy = config.items.jump.impulse;
        p.onGround = false;
        break;
    }
    this.emit({ type: 'item', id: p.id, itemType: item, x: p.x, z: p.z });
  }

  private isShielded(p: SimPlayer): boolean {
    return p.itemActiveUntil > this.t && p.lastItem === 'shield';
  }

  // ---------------------------------------------------------------- الخطوة
  step(dt: number) {
    if (dt <= 0) return;
    this.t += dt;
    this.updateCollapse();

    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.wantItem) {
        p.wantItem = false;
        this.useItem(p);
      }
      this.integrate(p, dt);
    }

    this.resolveCollisions();
    this.checkDeaths();
  }

  private integrate(p: SimPlayer, dt: number) {
    const C = config.physics;

    // اندفاع
    if (p.wantDash) {
      p.wantDash = false;
      if (this.t >= p.dashReadyAt) {
        let dx = p.inputX;
        let dz = p.inputZ;
        if (Math.hypot(dx, dz) < 0.1) {
          dx = p.faceX;
          dz = p.faceZ;
        }
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        p.vx += dx * config.dash.impulse;
        p.vz += dz * config.dash.impulse;
        p.dashReadyAt = this.t + config.dash.cooldown;
        p.dashUntil = this.t + config.dash.window;
        p.dashHitUsed = false;
        p.faceX = dx;
        p.faceZ = dz;
        this.emit({ type: 'dash', id: p.id, x: p.x, z: p.z });
      }
    }

    const anchorActive = p.anchorUntil > this.t;
    const speedFactor = anchorActive ? config.items.anchor.speedFactor : 1;
    const airFactor = p.onGround ? 1 : C.airControlFactor;

    p.vx += p.inputX * C.accel * airFactor * speedFactor * dt;
    p.vz += p.inputZ * C.accel * airFactor * speedFactor * dt;

    const dragF = Math.exp(-C.drag * dt);
    p.vx *= dragF;
    p.vz *= dragF;

    const sp = Math.hypot(p.vx, p.vz);
    if (sp > C.maxHorizontalSpeed) {
      p.vx = (p.vx / sp) * C.maxHorizontalSpeed;
      p.vz = (p.vz / sp) * C.maxHorizontalSpeed;
    }

    p.x += p.vx * dt;
    p.z += p.vz * dt;

    // رأسية
    if (!p.onGround) {
      p.vy -= C.gravity * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) {
        if (this.supported(p.x, p.z)) {
          p.y = 0;
          p.vy = 0;
          p.onGround = true;
        } else {
          p.y = Math.min(p.y, -0.0001);
        }
      }
    } else {
      if (!this.supported(p.x, p.z)) {
        p.onGround = false;
        p.vy = 0;
      } else {
        p.y = 0;
        p.vy = 0;
      }
    }
  }

  private resolveCollisions() {
    const C = config.physics;
    const minDist = C.radius * 2;
    const alive = this.alivePlayers;

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (Math.abs(a.y - b.y) > C.collideMaxY) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        if (dist > minDist) continue;
        if (dist < 1e-6) {
          dx = 0.01;
          dz = 0;
          dist = 0.01;
        }
        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = minDist - dist;

        // فصل
        a.x -= nx * overlap * 0.5;
        a.z -= nz * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.z += nz * overlap * 0.5;

        const aShield = this.isShielded(a);
        const bShield = this.isShielded(b);

        // تبادل الدفع بمعامل الارتداد
        const vnA = a.vx * nx + a.vz * nz;
        const vnB = b.vx * nx + b.vz * nz;
        const rel = vnA - vnB;
        // الدرع: يتجاهل الدفع ولا يدفع — فلا تبادل دفع إن كان أحدهما محميًا
        if (rel > 0 && !aShield && !bShield) {
          const jimp = ((1 + C.restitution) / 2) * rel;
          a.vx -= jimp * nx;
          a.vz -= jimp * nz;
          b.vx += jimp * nx;
          b.vz += jimp * nz;
        }

        // نافذة الاندفاع — ضربة إضافية
        const now = this.t;
        const hitByDash = (
          attacker: SimPlayer,
          victim: SimPlayer,
          sx: number,
          sz: number
        ) => {
          let chargedHit = false;
          const last = attacker.touchAt.get(victim.id) ?? -999;
          if (now - last < 0.25) return;
          attacker.touchAt.set(victim.id, now);
          const shielded = this.isShielded(victim) || this.isShielded(attacker);
          let push = config.dash.bonus;
          if (attacker.itemActiveUntil > now && attacker.lastItem === 'charge' && !attacker.chargeUsed) {
            push *= config.items.charge.multiplier;
            chargedHit = true;
            attacker.chargeUsed = true;
            attacker.itemActiveUntil = 0;
          }
          if (!shielded) {
            victim.vx += sx * push;
            victim.vz += sz * push;
            attacker.vx -= sx * config.dash.recoil;
            attacker.vz -= sz * config.dash.recoil;
            victim.lastHitBy = attacker.id;
            victim.lastHitAt = now;
          }
          attacker.dashHitUsed = true;
          this.emit({
            type: 'hit',
            x: victim.x,
            z: victim.z,
            s: Math.min(1, push / 18),
            by: attacker.id,
            id: victim.id,
            charged: chargedHit,
          });
        };

        // اندفاعان في نفس اللحظة = تصادم متكافئ (بلا أفضلية لترتيب المصفوفة)
        const aDashing = a.dashUntil > now && !a.dashHitUsed;
        const bDashing = b.dashUntil > now && !b.dashHitUsed;
        if (aDashing && bDashing) {
          hitByDash(a, b, nx, nz);
          hitByDash(b, a, -nx, -nz);
        } else if (aDashing) hitByDash(a, b, nx, nz);
        else if (bDashing) hitByDash(b, a, -nx, -nz);

        // تصادم عادي عنيف يُنسب أيضًا (لأجل الإسقاط)
        if (rel > 3) {
          if (!aShield) {
            a.lastHitBy = b.id;
            a.lastHitAt = now;
          }
          if (!bShield) {
            b.lastHitBy = a.id;
            b.lastHitAt = now;
          }
          this.emit({ type: 'hit', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, s: Math.min(1, rel / 16) });
        }
      }
    }
  }

  private checkDeaths() {
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.y < config.physics.killY) {
        p.alive = false;
        p.deathTime = this.t;
        const fresh = this.t - p.lastHitAt <= config.scoring.koWindow;
        if (fresh && p.lastHitBy && p.lastHitBy !== p.id) {
          p.killerId = p.lastHitBy;
          p.deathCause = 'pushed';
          const killer = this.byId(p.lastHitBy);
          if (killer) killer.kos++;
        } else {
          p.deathCause = 'collapse';
        }
        this.fallOrder.push(p.id);
        this.emit({ type: 'ko', id: p.id, by: p.killerId ?? undefined, x: p.x, z: p.z });
        this.emit({ type: 'fall', id: p.id, x: p.x, z: p.z });
      }
    }
  }

  /** يُستدعى عند بداية الحلبة لتوزيع الأدوات المختارة */
  giveItems(map: Record<string, ItemId | null>) {
    for (const p of this.players) {
      const it = map[p.id] ?? null;
      p.item = it && ITEM_IDS.includes(it) ? it : null;
      if (it) p.lastItem = it;
    }
  }
}
