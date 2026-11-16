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
  CENTER_TILE,
  ITEM_IDS,
  neighborsOf,
} from '../../shared/src/index';
import type { ItemId } from '../../shared/src/index';

export const SOLID = 0;
export const WARNED = 1;
export const GONE = 2;

export interface SimEvent {
  type: 'hit' | 'ko' | 'fall' | 'warn' | 'dash' | 'item' | 'pickup' | 'finale' | 'reveal' | 'mine' | 'zone';
  x?: number;
  z?: number;
  s?: number;
  id?: string;
  by?: string;
  /** لنوع الأداة في حدث item */
  itemType?: ItemId;
  /** هل كانت الضربة مشحونة (×2) */
  charged?: boolean;
  /** بداية النهضة الأخيرة */
  finale?: boolean;
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
  wantItemSlot: number;
  faceX: number;
  faceZ: number;

  dashReadyAt: number;
  dashUntil: number;
  dashHitUsed: boolean;
  onGround: boolean;

  lastHitBy: string | null;
  lastHitAt: number;

  items: ItemId[];
  /** الأداة التي فُعّلت (تبقى بعد استهلاك المخزون) */
  lastItem: ItemId | null;
  itemActiveUntil: number;
  chargeUsed: boolean;
  anchorTile: number | null;
  anchorUntil: number;

  /** آخر لحظة تصادم مع كل لاعب، لمنع تعدد الضربات في نفس التلامس */
  touchAt: Map<string, number>;

  /** شلل مؤقت (انفجار لغم) */
  stunUntil: number;
  /** آخر بلاطة وقف عليها (لكشف الأرقام مرة واحدة) */
  lastTile: number;
  /** كم لغمًا انفجر به (للملخّص) */
  minesHit: number;
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

  private collisionTurn = 0;
  private tieRng: Rng;

  /** النهضة الأخيرة: البلاطة المركزية تتقلّص حتى يبقى الأقرب للمركز */
  finaleActive = false;
  finaleStart = 0;
  finaleRadius = 0;

  /** بيكابات الأدوات في الحلبة (نظام بلور: حركة = مكافأة) */
  pickups: Array<{ id: number; x: number; z: number; item: ItemId; bornAt: number }> = [];
  private pickupNextAt = 0;
  private pickupSeq = 0;
  private pickupRng: Rng;

  // ---- حقل الملوك: ألغام مخفية بأرقام مشتركة + مناطق سيطرة ----
  /** كل البلاطات الملغومة (الخريطة الثابتة للجولة) */
  mineTiles = new Set<number>();
  /** الألغام التي لم تنفجر بعد */
  armed = new Set<number>();
  /** -1 مجهولة، 0..8 رقم مجاور، 9 لغم منفجر */
  mineNum = new Int8Array(TILE_COUNT).fill(-1);
  zones: Array<{ tile: number; x: number; z: number; owner: string | null }> = [];
  /** نقاط الجولة: سيطرة + إسقاط بلغم */
  points = new Map<string, number>();
  private zoneAcc = 0;

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
    this.tieRng = new Rng(deriveSeed(opts.seed, 'tie', opts.roundIndex));
    this.pickupRng = new Rng(deriveSeed(opts.seed, 'pickups', opts.roundIndex));
    if (config.mines.enabled) this.initMines(new Rng(deriveSeed(opts.seed, 'mines', opts.roundIndex)), n);
    this.pickupNextAt = config.collapse.grace;
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
        wantItemSlot: 0,
        faceX: Math.cos((-Math.PI / 2) + (order[i] * 2 * Math.PI) / n),
        faceZ: Math.sin((-Math.PI / 2) + (order[i] * 2 * Math.PI) / n),
        dashReadyAt: 0,
        dashUntil: 0,
        dashHitUsed: false,
        onGround: true,
        lastHitBy: null,
        lastHitAt: -999,
        items: [],
        lastItem: null,
        itemActiveUntil: 0,
        chargeUsed: false,
        anchorTile: null,
        anchorUntil: 0,
        touchAt: new Map(),
        stunUntil: 0,
        lastTile: -1,
        minesHit: 0,
      });
    });
  }

  /** توليد متماثل: كل لغم له توأم معكوس، والمناطق ونقاط البداية آمنة */
  private initMines(rng: Rng, n: number) {
    const half = (config.arena.gridSize - 1) / 2;
    for (const pair of config.mines.zones as number[][]) {
      const t = TILES.find((q) => q.gx === pair[0] + half && q.gz === pair[1] + half);
      if (!t) continue;
      this.zones.push({ tile: t.id, x: t.x, z: t.z, owner: null });
    }
    const zoneSet = new Set(this.zones.map((z) => z.tile));
    const safe = new Set<number>();
    for (const sp of spawnPositions(n)) {
      const t = tileAt(sp.x, sp.z);
      if (!t) continue;
      safe.add(t.id);
      for (const nb of neighborsOf(t.id)) safe.add(nb);
    }
    const mirrorOf = (id: number) => {
      const t = TILES[id];
      return TILES.find((q) => Math.abs(q.x + t.x) < 1e-6 && Math.abs(q.z + t.z) < 1e-6)?.id ?? id;
    };
    const cand = TILES.map((t) => t.id);
    rng.shuffle(cand);
    for (const id of cand) {
      if (this.mineTiles.size >= config.mines.count) break;
      const mid = mirrorOf(id);
      if (this.mineTiles.has(id) || this.mineTiles.has(mid)) continue;
      if (zoneSet.has(id) || zoneSet.has(mid) || safe.has(id) || safe.has(mid)) continue;
      this.mineTiles.add(id);
      this.armed.add(id);
      if (mid !== id) {
        this.mineTiles.add(mid);
        this.armed.add(mid);
      }
    }
  }

  /** عدد الألغام المجاورة لبلاطة */
  numberAt(id: number): number {
    let c = 0;
    for (const nb of neighborsOf(id)) if (this.mineTiles.has(nb)) c++;
    return c;
  }

  addPoints(id: string, n: number) {
    this.points.set(id, (this.points.get(id) ?? 0) + n);
  }

  roundPointsOf(id: string): number {
    return this.points.get(id) ?? 0;
  }

  /** كشف البلاطة عند الوقوف عليها، أو تفجير اللغم */
  private updateMines() {
    for (const p of this.players) {
      if (!p.alive) continue;
      const t = tileAt(p.x, p.z);
      if (!t) continue;
      if (p.lastTile === t.id) continue;
      p.lastTile = t.id;
      if (this.mineNum[t.id] !== -1) continue;
      if (this.armed.has(t.id)) this.explodeMine(t.id, p);
      else {
        this.mineNum[t.id] = this.numberAt(t.id);
        this.emit({ type: 'reveal', x: t.x, z: t.z, s: this.mineNum[t.id] });
      }
    }
  }

  private explodeMine(tileId: number, p: SimPlayer) {
    const t = TILES[tileId];
    this.armed.delete(tileId);
    this.mineNum[tileId] = 9;
    let dx = p.x - t.x;
    let dz = p.z - t.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.05) {
      // وقف في منتصف اللغم تمامًا: ارتدّ عكس اتجاه حركته، وإلا بعيدًا عن المركز
      dx = -p.vx || -p.faceX || p.x || 1;
      dz = -p.vz || -p.faceZ || p.z || 0;
      len = Math.hypot(dx, dz) || 1;
    }
    p.vx = (dx / len) * config.mines.knockback;
    p.vz = (dz / len) * config.mines.knockback;
    p.vy = 7;
    p.onGround = false;
    p.stunUntil = this.t + config.mines.stunSec;
    p.minesHit++;
    p.lastTile = -1;
    // إسقاط بلغم: من دفعك إلى اللغم يكافأ
    const by = p.lastHitBy && this.t - p.lastHitAt <= config.mines.ambushWindowSec ? p.lastHitBy : null;
    if (by) this.addPoints(by, config.mines.ambushBonus);
    this.emit({ type: 'mine', x: t.x, z: t.z, id: p.id, by: by ?? undefined, s: config.mines.ambushWindowSec });
  }

  /** نقطة كل ثانية لمن يقف وحده في منطقة سيطرة */
  private updateZones(dt: number) {
    this.zoneAcc += dt;
    if (this.zoneAcc < 1) return;
    this.zoneAcc -= 1;
    for (const z of this.zones) {
      let owner: string | null = null;
      let count = 0;
      for (const p of this.players) {
        if (!p.alive) continue;
        const t = tileAt(p.x, p.z);
        if (!t || t.id !== z.tile) continue;
        count++;
        owner = p.id;
      }
      if (count !== 1) owner = null;
      if (owner) this.addPoints(owner, config.mines.zoneScorePerSec);
      if (owner !== z.owner) {
        z.owner = owner;
        this.emit({ type: 'zone', id: owner ?? undefined, x: z.x, z: z.z });
      }
    }
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

  setInput(id: string, x: number, z: number, dash: boolean, item: boolean, slot = 0) {
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
    if (item) {
      p.wantItem = true;
      p.wantItemSlot = slot;
    }
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

    // انتهت كل الحلقات وبقي أكثر من لاعب → ابدأ النهضة الأخيرة
    if (this.groupIdx >= this.queue.length && !this.finaleActive && this.aliveCount > 1) {
      this.finaleActive = true;
      this.finaleStart = this.t + config.collapse.finaleWarnSec;
      this.finaleRadius = config.arena.tileSize / 2;
      this.emit({ type: 'warn', s: 1, finale: true });
    }
    if (this.finaleActive && this.t >= this.finaleStart) {
      const k = Math.min(1, (this.t - this.finaleStart) / config.collapse.finaleSec);
      this.finaleRadius = Math.max(0.35, (config.arena.tileSize / 2) * (1 - k));
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
    if (this.finaleActive && this.t >= this.finaleStart) {
      const t = tileAt(x, z);
      if (t && t.id === CENTER_TILE.id) return Math.max(Math.abs(x), Math.abs(z)) <= this.finaleRadius;
    }
    const t = tileAt(x, z);
    if (!t) return false;
    return this.tileStates[t.id] !== GONE;
  }

  // ---------------------------------------------------------------- الأدوات
  private useItem(p: SimPlayer, slot = 0) {
    if (!p.alive) return;
    if (p.itemActiveUntil > this.t) return; // مفعّلة بالفعل
    const idx = slot >= 0 && slot < p.items.length ? slot : 0;
    const item = p.items[idx];
    if (!item || !ITEM_IDS.includes(item)) return;
    p.items.splice(idx, 1);
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

  /** بيكابات في سلاسل متماثلة حول المركز: تجبر على الحركة وتقتل استراتيجية السكون */
  private updatePickups() {
    if (!config.pickups.enabled) return;
    // إسقاط ما وقع على بلاطة ذهبت
    this.pickups = this.pickups.filter((pk) => {
      const t = tileAt(pk.x, pk.z);
      return !!t && this.tileStates[t.id] !== GONE;
    });

    if (this.t >= this.pickupNextAt) {
      this.pickupNextAt = this.t + config.pickups.intervalSec;
      const solid = TILES.filter((t) => this.tileStates[t.id] === SOLID && t.ring > 0);
      if (solid.length) {
        const pick = solid[Math.floor(this.pickupRng.f() * solid.length)];
        const pool = config.pickups.itemPool as ItemId[];
        const chain = [
          { x: pick.x, z: pick.z },
          { x: -pick.x, z: -pick.z }, // المرآة: لا أفضلية لجانب
        ].slice(0, config.pickups.perChain);
        for (const pos of chain) {
          const item = pool[Math.floor(this.pickupRng.f() * pool.length)];
          this.pickups.push({ id: this.pickupSeq++, x: pos.x, z: pos.z, item, bornAt: this.t });
        }
        this.emit({ type: 'warn', s: 0 }); // نبضة بصرية خفيفة
      }
    }

    for (const pk of [...this.pickups]) {
      for (const p of this.players) {
        if (!p.alive) continue;
        if (p.items.length >= config.items.maxSlots) continue;
        if (Math.hypot(p.x - pk.x, p.z - pk.z) > config.pickups.radius) continue;
        p.items.push(pk.item);
        this.pickups = this.pickups.filter((q) => q !== pk);
        this.emit({ type: 'pickup', id: p.id, itemType: pk.item, x: pk.x, z: pk.z });
        break;
      }
    }
  }

  private isShielded(p: SimPlayer): boolean {
    return p.itemActiveUntil > this.t && p.lastItem === 'shield';
  }

  // ---------------------------------------------------------------- الخطوة
  step(dt: number) {
    if (dt <= 0) return;
    this.t += dt;
    if (config.collapse.enabled) this.updateCollapse();
    if (config.mines.enabled) {
      this.updateMines();
      this.updateZones(dt);
    }
    this.updatePickups();

    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.wantItem) {
        p.wantItem = false;
        this.useItem(p, p.wantItemSlot);
      }
      this.integrate(p, dt);
      if (config.mines.enabled) this.clampInside(p);
    }

    this.resolveCollisions();
    this.checkDeaths();
  }

  private integrate(p: SimPlayer, dt: number) {
    const C = config.physics;

    // شلل انفجار اللغم: لا تحكم (الزخم وحده يحرّكك)
    if (this.t < p.stunUntil) {
      p.inputX = 0;
      p.inputZ = 0;
      p.wantDash = false;
      p.wantItem = false;
    }

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
    // ترتيب معالجة التصادم يتغيّر كل إطار: يمنع أفضلية منهجية لمن هو أول في المصفوفة
    const raw = this.alivePlayers;
    const off = raw.length > 1 ? this.collisionTurn++ % raw.length : 0;
    const alive = off ? raw.slice(off).concat(raw.slice(0, off)) : raw;

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
          let push = config.dash.bonus;
          const charged = attacker.itemActiveUntil > now && attacker.lastItem === 'charge' && !attacker.chargeUsed;
          if (charged) {
            push *= config.items.charge.multiplier;
            chargedHit = true;
            attacker.chargeUsed = true;
            attacker.itemActiveUntil = 0;
          }
          // نظام بلور: لكل قوة مضادّها — الضربة المشحونة **تكسّر** الدرع
          let victimShield = this.isShielded(victim);
          if (charged && victimShield) {
            victim.itemActiveUntil = 0;
            victimShield = false;
            this.emit({ type: 'warn', s: 0, x: victim.x, z: victim.z });
          }
          const shielded = victimShield || this.isShielded(attacker);
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

  /** حاجز على شكل الحلبة نفسها (مثمّن): يمنع السقوط بدل أن يعاقب عليه */
  private clampInside(p: SimPlayer) {
    const pitch = config.arena.tileSize + config.arena.tileGap;
    const half = (config.arena.gridSize - 1) / 2;
    const cut = config.arena.cornerCut ?? 0;
    const m = config.physics.radius * 0.8;
    const ax = half * pitch + config.arena.tileSize / 2 - m; // الحد المستقيم
    const diag = (2 * half - cut) * pitch + config.arena.tileSize / 2 - m; // الحد القطري
    let hit = false;
    if (p.x > ax) { p.x = ax; hit = true; } else if (p.x < -ax) { p.x = -ax; hit = true; }
    if (p.z > ax) { p.z = ax; hit = true; } else if (p.z < -ax) { p.z = -ax; hit = true; }
    const s2 = Math.abs(p.x) + Math.abs(p.z);
    if (s2 > diag) {
      const k = diag / s2;
      p.x *= k;
      p.z *= k;
      hit = true;
    }
    if (hit) {
      p.vx *= 0.35;
      p.vz *= 0.35;
      if (p.y < 0) {
        p.y = 0;
        p.vy = Math.max(0, p.vy);
        p.onGround = true;
      }
    }
  }

  private checkDeaths() {
    const dying: SimPlayer[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      if (config.mines.enabled) continue; // حقل الملوك: لا سقوط ولا موت
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
        dying.push(p);
      }
    }
    // سقوط متزامن: الأبعد عن المركز يُحتسب أولًا (قاعدة معلنة ومتماثلة)
    if (dying.length > 1) {
      const key = (p: SimPlayer) => Math.max(Math.abs(p.x), Math.abs(p.z));
      // تعادل تام (مسافة متساوية): قرعة مبذورة — عادلة في التوقّع لا محسومة لأحد
      const tie = new Map(dying.map((p) => [p.id, this.tieRng.f()]));
      dying.sort((a, b) => key(b) - key(a) || tie.get(a.id)! - tie.get(b.id)!);
    }
    for (const p of dying) {
      this.fallOrder.push(p.id);
      this.emit({ type: 'ko', id: p.id, by: p.killerId ?? undefined, x: p.x, z: p.z });
      this.emit({ type: 'fall', id: p.id, x: p.x, z: p.z });
    }
  }

  /** يُستدعى عند بداية الحلبة لتوزيع الأدوات المختارة */
  giveItems(map: Record<string, ItemId | ItemId[] | null>) {
    for (const p of this.players) {
      const raw = map[p.id] ?? null;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      p.items = list.filter((it) => ITEM_IDS.includes(it)).slice(0, config.items.maxSlots);
      if (p.items.length) p.lastItem = p.items[0];
    }
  }
}
