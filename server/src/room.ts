/**
 * غرفة واحدة = مباراة كاملة. الخادم هو الحكم الوحيد في كل شيء.
 * الملف لا يعرف Socket.io مباشرة، بل يستخدم واجهة إرسال يحقنها index.ts.
 */
import {
  config,
  ITEM_IDS,
  PLAYER_COLORS,
  Rng,
  deriveSeed,
  checkAnswer,
  generatePuzzle,
  pickType,
  roundDifficulty,
  sharedSurvivalPoints,
  survivalPoints,
  PUZZLE_TYPES,
  type ItemId,
  type MatchResult,
  type PuzzleType,
  type RoundResult,
  type RoundResultRow,
  type Puzzle,
  type PuzzleResultRow,
} from '../../shared/src/index';
import { ArenaSim } from './sim';
import { appendRoundLog } from './telemetry';

export type Send = (socketId: string, event: string, data: any) => void;

export interface Player {
  id: string;
  token: string;
  name: string;
  color: string;
  socketId: string;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
  disconnectedAt: number | null;

  score: number;
  kos: number;
  roundWins: number;
  puzzleMsSum: number;
  puzzleAnswered: number;
  predicted: string | null;

  // الجولة الحالية
  sentAt: number;
  flashEndAt: number;
  rttMs: number;
  lockedUntil: number;
  correctAtMs: number | null;
  wrongCount: number;
  draftPick: ItemId | null;
  item: ItemId | null;
  roundRank: number;
  roundSurvival: number;
  roundKos: number;
  roundPuzzleBonus: number;
  roundPredictBonus: number;
  deathCause: 'pushed' | 'collapse' | 'timeout' | null;
  killedByName: string | null;
  roundPoints: number;
}

type PhaseName =
  | 'LOBBY'
  | 'COUNTDOWN'
  | 'PUZZLE'
  | 'DRAFT'
  | 'ARENA_INTRO'
  | 'ARENA'
  | 'ROUND_RESULT'
  | 'MATCH_RESULT';

const TICK_MS = 1000 / config.net.tickHz;
const SNAP_EVERY = Math.round(config.net.tickHz / config.net.snapshotHz);

export class Room {
  code: string;
  seed: number;
  hostId = '';
  rounds = config.room.roundsDefault;
  round = 0;
  phase: PhaseName = 'LOBBY';
  phaseEndsAt = 0;

  players = new Map<string, Player>();
  order: string[] = []; // ترتيب الانضمام
  sim: ArenaSim | null = null;
  emptySince: number | null = null; // متى صارت الغرفة فارغة (لمهلة البقاء)

  puzzle: Puzzle | null = null;
  puzzleType: PuzzleType | null = null;
  prevPuzzleType: PuzzleType | null = null;
  puzzleDifficulty = 0;
  timerBase = 0;
  puzzleRows: PuzzleResultRow[] = [];

  inventory: Record<ItemId, number> = { charge: 0, shield: 0, anchor: 0, jump: 0 };
  draftOrder: string[] = [];

  roundResults: RoundResult[] = [];
  roundStartAlive = 0;

  private send: Send;
  private log: (msg: string) => void;
  private loop: NodeJS.Timeout | null = null;
  private acc = 0;
  private lastTick = 0;
  private tickCount = 0;
  private pendingFlashes: Array<{ cell: number; at: number }> = [];
  private arenaEndAt = 0;
  private arenaStartSimT = 0;
  private dead = false;

  constructor(code: string, seed: number, send: Send, log: (m: string) => void = () => {}) {
    this.code = code;
    this.seed = seed;
    this.send = send;
    this.log = log;
    this.startLoop();
  }

  // ------------------------------------------------------------------ أدوات
  private rnd(): Rng {
    return new Rng(deriveSeed(this.seed, 'misc', this.round, this.order.length));
  }

  broadcast(event: string, data: any) {
    for (const p of this.players.values()) {
      if (p.connected && p.socketId) this.send(p.socketId, event, data);
    }
  }

  to(p: Player, event: string, data: any) {
    if (p.connected && p.socketId) this.send(p.socketId, event, data);
  }

  private freeColor(): string {
    const used = new Set(Array.from(this.players.values()).map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
  }

  // ------------------------------------------------------------------ انضمام
  addPlayer(id: string, token: string, name: string, socketId: string): Player | null {
    if (this.players.size >= config.room.maxPlayers) return null;
    if (this.phase !== 'LOBBY' && !config.room.joinAfterStart) return null;
    const p: Player = {
      id,
      token,
      name: sanitizeName(name),
      color: this.freeColor(),
      socketId,
      connected: true,
      isHost: this.players.size === 0,
      joinedAt: Date.now(),
      disconnectedAt: null,
      score: 0,
      kos: 0,
      roundWins: 0,
      puzzleMsSum: 0,
      puzzleAnswered: 0,
      predicted: null,
      sentAt: 0,
      flashEndAt: 0,
      rttMs: 0,
      lockedUntil: 0,
      correctAtMs: null,
      wrongCount: 0,
      draftPick: null,
      item: null,
      roundRank: 0,
      roundSurvival: 0,
      roundKos: 0,
      roundPuzzleBonus: 0,
      roundPredictBonus: 0,
      deathCause: null,
      killedByName: null,
      roundPoints: 0,
    };
    this.players.set(id, p);
    this.order.push(id);
    if (!this.hostId) this.hostId = id;
    this.broadcastState();
    return p;
  }

  reconnect(token: string, socketId: string): Player | null {
    for (const p of this.players.values()) {
      if (p.token === token) {
        p.socketId = socketId;
        p.connected = true;
        p.disconnectedAt = null;
        this.broadcastState();
        this.to(p, 'phase', this.phaseMsg());
        return p;
      }
    }
    return null;
  }

  markDisconnected(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    this.migrateHost();
    this.broadcastState();
  }

  /** إخراج نهائي (انتهت مهلة إعادة الاتصال أو خرج من اللوبي) */
  /**
   * عند خروج آخر لاعب: أعِد الغرفة إلى اللوبي بدل إتلافها،
   * ليبقى كود الغرفة صالحًا للمشاركة خلال مهلة room.emptyTtlSec.
   */
  resetToLobbyIfEmpty(): boolean {
    if (this.players.size > 0) return false;
    if (this.phase !== 'LOBBY') {
      this.sim = null;
      this.puzzle = null;
      this.draftOrder = [];
      this.roundResults = [];
      this.roundStartAlive = 0;
      this.round = 0;
      this.phase = 'LOBBY';
      this.phaseEndsAt = 0;
      this.log('عودة الغرفة إلى اللوبي (لا لاعبين)');
    }
    this.hostId = '';
    return true;
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.sim) {
      const sp = this.sim.byId(id);
      if (sp && sp.alive) {
        sp.alive = false;
        sp.deathTime = this.sim.t;
        sp.deathCause = 'collapse';
        this.sim.fallOrder.push(id); // يُحسب في آخر ترتيب
      }
    }
    this.migrateHost();
    this.broadcastState();
  }

  private migrateHost() {
    const current = this.players.get(this.hostId);
    if (current && current.connected) return;
    const next = this.order
      .map((id) => this.players.get(id)!)
      .filter((p) => p && p.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      for (const p of this.players.values()) p.isHost = false;
      next.isHost = true;
      this.hostId = next.id;
    }
  }

  isHost(id: string) {
    return this.hostId === id;
  }

  setRounds(id: string, rounds: number) {
    if (!this.isHost(id)) return;
    if (!config.room.roundsOptions.includes(rounds)) return;
    if (this.phase !== 'LOBBY') return;
    this.rounds = rounds;
    this.broadcastState();
  }

  isEmpty(): boolean {
    return Array.from(this.players.values()).every((p) => !p.connected);
  }

  destroy() {
    this.dead = true;
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  // ------------------------------------------------------------------ الحالة
  roomState(youId: string) {
    return {
      code: this.code,
      phase: this.phase,
      rounds: this.rounds,
      round: this.round,
      hostId: this.hostId,
      youId,
      canStart: this.players.size >= config.room.minPlayers && this.phase === 'LOBBY',
      players: this.order
        .map((id) => this.players.get(id))
        .filter((p): p is Player => !!p)
        .map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          isHost: p.id === this.hostId,
          connected: p.connected,
          score: p.score,
        })),
    };
  }

  broadcastState() {
    for (const p of this.players.values()) this.to(p, 'room:state', this.roomState(p.id));
  }

  private phaseMsg() {
    let data: any = undefined;
    if (this.phase === 'PUZZLE' && this.puzzle) {
      data = {
        round: this.round,
        difficulty: this.puzzleDifficulty,
        type: this.puzzle.type,
        payload: this.puzzle.payload,
        timeLimitMs: this.puzzle.timeLimitSec * 1000,
        flashStartAt: this.puzzle.flashPlan ? this.timerBase : undefined,
      };
    } else if (this.phase === 'DRAFT') {
      data = {
        inventory: { ...this.inventory },
        demand: this.demand(),
        order: this.draftOrder.map((id) => this.players.get(id)?.name ?? ''),
      };
    } else if (this.phase === 'ARENA_INTRO') {
      data = {
        items: Object.fromEntries(Array.from(this.players.values()).map((p) => [p.id, p.item])),
        remaining: { ...this.inventory },
      };
    }
    return {
      name: this.phase,
      endsAt: this.phaseEndsAt,
      round: this.round,
      totalRounds: this.rounds,
      data,
    };
  }

  enterPhase(name: PhaseName, durationMs: number) {
    this.phase = name;
    this.phaseEndsAt = durationMs > 0 ? Date.now() + durationMs : 0;
    const msg = this.phaseMsg();
    for (const p of this.players.values()) this.to(p, 'phase', msg);
  }

  // ------------------------------------------------------------------ البدء
  start(id: string) {
    if (!this.isHost(id)) return false;
    if (this.phase !== 'LOBBY') return false;
    if (this.players.size < config.room.minPlayers) return false;
    for (const p of this.players.values()) {
      p.score = 0;
      p.kos = 0;
      p.roundWins = 0;
      p.puzzleMsSum = 0;
      p.puzzleAnswered = 0;
    }
    this.round = 0;
    this.roundResults = [];
    this.prevPuzzleType = null;
    this.enterPhase('COUNTDOWN', config.phase.countdown * 1000);
    return true;
  }

  private nextRound() {
    this.round++;
    this.startPuzzle();
  }

  // ------------------------------------------------------------------ الألغاز
  private startPuzzle() {
    const total = this.rounds;
    this.puzzleDifficulty = roundDifficulty(this.round, total);
    // خطاف تشخيصي للاختبار فقط: FORCE_PUZZLE=memory
    const forced = process.env.FORCE_PUZZLE as PuzzleType | undefined;
    const type =
      forced && PUZZLE_TYPES.includes(forced) ? forced : pickType(this.seed, this.round - 1, this.prevPuzzleType);
    this.prevPuzzleType = type;
    const puzzle = generatePuzzle(this.seed, this.round - 1, this.puzzleDifficulty, type);
    this.puzzle = puzzle;
    this.puzzleType = type;

    // إعادة تهيئة حالة كل لاعب للجولة
    for (const p of this.players.values()) {
      p.correctAtMs = null;
      p.wrongCount = 0;
      p.lockedUntil = 0;
      p.draftPick = null;
      p.item = null;
      p.predicted = null;
      p.roundKos = 0;
      p.roundPuzzleBonus = 0;
      p.roundPredictBonus = 0;
      p.deathCause = null;
      p.killedByName = null;
      p.roundPoints = 0;
    }

    const now = Date.now();
    const totalMs = puzzle.timeLimitSec * 1000;
    this.timerBase = now;
    for (const p of this.players.values()) p.sentAt = now;
    this.pendingFlashes = (puzzle.flashPlan ?? []).map((f) => ({ cell: f.cell, at: now + f.atMs }));
    this.enterPhase('PUZZLE', totalMs);
  }

  private flashEndAt(): number {
    const plan = this.puzzle?.flashPlan;
    if (!plan || !plan.length) return this.timerBase;
    const last = plan[plan.length - 1];
    const flashMs = this.puzzle!.payload.type === 'memory' ? (this.puzzle!.payload as any).flashSec * 1000 : 600;
    return this.timerBase + last.atMs + flashMs;
  }

  answer(playerId: string, payload: unknown) {
    const p = this.players.get(playerId);
    if (!p || this.phase !== 'PUZZLE' || !this.puzzle) return;
    const now = Date.now();
    if (p.correctAtMs !== null) return;
    if (now < p.lockedUntil) return;
    if (this.puzzle.flashPlan && now < this.flashEndAt() - 50) return; // أثناء الوميض

    if (checkAnswer(this.puzzle, payload)) {
      const base = this.puzzle.flashPlan ? this.flashEndAt() : p.sentAt;
      const eff = Math.max(0, now - base - p.rttMs / 2);
      p.correctAtMs = eff;
      p.puzzleMsSum += eff;
      p.puzzleAnswered++;
      this.to(p, 'puzzle:ack', { correct: true, effectiveMs: eff });
    } else {
      p.wrongCount++;
      p.lockedUntil = now + config.puzzle.lockSec * 1000;
      this.to(p, 'puzzle:ack', { correct: false, lockedMs: config.puzzle.lockSec * 1000 });
    }
  }

  private resolvePuzzle() {
    const tie = config.puzzle.tieWindowMs;
    const rows: PuzzleResultRow[] = [];
    for (const p of this.players.values()) {
      rows.push({
        playerId: p.id,
        name: p.name,
        color: p.color,
        correct: p.correctAtMs !== null,
        effectiveMs: p.correctAtMs,
        rank: 0,
        bonus: 0,
      });
    }
    // ترتيب بحسب الزمن الفعلي، وفارق أقل من 50ms تعادل
    const correct = rows.filter((r) => r.correct).sort((a, b) => a.effectiveMs! - b.effectiveMs!);
    const rng = new Rng(deriveSeed(this.seed, 'tiebreak'));
    const tieOrder = new Map<string, number>();
    this.order.forEach((id, i) => tieOrder.set(id, i + rng.f() * 0.001));

    let slot = 1;
    let i = 0;
    const groups: PuzzleResultRow[][] = [];
    while (i < correct.length) {
      const g = [correct[i]];
      let j = i + 1;
      while (j < correct.length && correct[j].effectiveMs! - correct[i].effectiveMs! <= tie) {
        g.push(correct[j]);
        j++;
      }
      groups.push(g);
      i = j;
    }
    for (const g of groups) {
      const avg = (slot + slot + g.length - 1) / 2;
      for (const r of g) r.rank = avg;
      slot += g.length;
    }
    // من لم يجب يتشارك المركز الأخير
    const unanswered = rows.filter((r) => !r.correct);
    if (unanswered.length) {
      const avg = (slot + slot + unanswered.length - 1) / 2;
      for (const r of unanswered) r.rank = avg;
    }
    // البونص
    const bonus = config.scoring.puzzleBonus;
    if (groups[0]) for (const r of groups[0]) r.bonus = Math.max(r.bonus, bonus[0]);
    if (groups[1]) for (const r of groups[1]) r.bonus = Math.max(r.bonus, bonus[1]);

    for (const r of rows) {
      const p = this.players.get(r.playerId);
      if (p) p.roundPuzzleBonus = r.bonus;
    }

    rows.sort((a, b) => a.rank - b.rank || (tieOrder.get(a.playerId)! - tieOrder.get(b.playerId)!));
    this.puzzleRows = rows;
    this.draftOrder = rows.map((r) => r.playerId);
    this.broadcast('puzzle:result', { rows });
  }

  // ------------------------------------------------------------------ الاختيار
  private startDraft() {
    const n = this.players.size;
    const per = Math.ceil(n / 3);
    this.inventory = { charge: per, shield: per, anchor: per, jump: per };
    this.enterPhase('DRAFT', config.phase.draft * 1000);
  }

  demand(): Record<ItemId, number> {
    const d: Record<ItemId, number> = { charge: 0, shield: 0, anchor: 0, jump: 0 };
    for (const p of this.players.values()) if (p.draftPick) d[p.draftPick]++;
    return d;
  }

  pick(playerId: string, item: ItemId) {
    const p = this.players.get(playerId);
    if (!p || this.phase !== 'DRAFT') return;
    if (!ITEM_IDS.includes(item)) return;
    p.draftPick = item;
    this.broadcast('draft:demand', { demand: this.demand(), inventory: { ...this.inventory } });
  }

  /** الحسم بترتيب نتيجة اللغز: من نفد مخزون اختياره أخذ أول أداة متاحة بترتيب ثابت */
  private resolveDraft() {
    const order = this.draftOrder.length
      ? this.draftOrder
      : Array.from(this.players.keys());
    const picked: Record<string, ItemId | null> = {};
    const reasons: Record<string, { reason: 'ok' | 'outOfStock' | 'noPick'; wanted: ItemId | null }> = {};
    const itemOrder = config.draft.itemOrder as ItemId[];
    for (const id of order) {
      const p = this.players.get(id);
      if (!p) continue;
      let chosen: ItemId | null = null;
      let reason: 'ok' | 'outOfStock' | 'noPick' = 'ok';
      if (p.draftPick && this.inventory[p.draftPick] > 0) chosen = p.draftPick;
      else {
        reason = p.draftPick ? 'outOfStock' : 'noPick';
        chosen = itemOrder.find((it) => this.inventory[it] > 0) ?? null;
      }
      if (chosen) this.inventory[chosen]--;
      p.item = chosen;
      picked[id] = chosen;
      reasons[id] = { reason, wanted: p.draftPick ?? null };
    }
    this.broadcast('draft:picked', { picked, reasons, remaining: { ...this.inventory } });
    this.startArena();
  }

  // ------------------------------------------------------------------ الحلبة
  private startArena() {
    const ids = this.order.filter((id) => this.players.get(id));
    this.sim = new ArenaSim({
      seed: this.seed,
      playerIds: ids,
      roundIndex: this.round,
      startAlive: ids.length,
    });
    this.roundStartAlive = ids.length;
    this.sim.giveItems(Object.fromEntries(ids.map((id) => [id, this.players.get(id)!.item])));
    this.arenaEndAt = 0;
    this.arenaStartSimT = 0;
    this.enterPhase('ARENA_INTRO', config.phase.arenaIntro * 1000);
  }

  feedInput(playerId: string, m: { seq?: number; x?: number; z?: number; dash?: boolean; item?: boolean }) {
    if (!this.sim || this.phase !== 'ARENA') return;
    this.sim.setInput(playerId, Number(m.x) || 0, Number(m.z) || 0, !!m.dash, !!m.item);
  }

  predict(playerId: string, targetId: string) {
    const p = this.players.get(playerId);
    if (!p || !this.sim || this.phase !== 'ARENA') return;
    const me = this.sim.byId(playerId);
    if (me && me.alive) return; // الأحياء لا يتوقعون
    if (p.predicted) return;
    if (this.sim.aliveCount < 3) return;
    const target = this.sim.byId(targetId);
    if (!target || !target.alive) return;
    p.predicted = targetId;
    this.to(p, 'predict:ack', { targetId });
  }

  // ------------------------------------------------------------------ النقاط
  private finishArena() {
    const sim = this.sim;
    if (!sim) return;
    const n = this.players.size;
    const arenaDurationSec = sim.t;

    // مجموعات السقوط: نفس اللحظة = نفس المجموعة
    const deadIds = sim.players
      .filter((p) => !p.alive)
      .sort((a, b) => (b.deathTime ?? 0) - (a.deathTime ?? 0));
    const survivors = sim.players.filter((p) => p.alive).map((p) => p.id);

    const groups: Array<{ ids: string[]; kind: 'survivor' | 'dead' }> = [];
    if (survivors.length) groups.push({ ids: survivors, kind: 'survivor' });
    let i = 0;
    while (i < deadIds.length) {
      const t = deadIds[i].deathTime ?? 0;
      const g = [deadIds[i]];
      let j = i + 1;
      while (j < deadIds.length && Math.abs((deadIds[j].deathTime ?? 0) - t) < 1e-6) {
        g.push(deadIds[j]);
        j++;
      }
      groups.push({ ids: g.map((x) => x.id), kind: 'dead' });
      i = j;
    }

    let slot = 1;
    const rankMap = new Map<string, number>();
    const survMap = new Map<string, number>();
    for (const g of groups) {
      const avgRank = (slot + slot + g.ids.length - 1) / 2;
      const pts = sharedSurvivalPoints(n, slot, g.ids.length);
      for (const id of g.ids) {
        rankMap.set(id, avgRank);
        survMap.set(id, pts);
      }
      slot += g.ids.length;
    }

    const rows: RoundResultRow[] = [];
    for (const p of this.players.values()) {
      const sp = sim.byId(p.id);
      const rank = rankMap.get(p.id) ?? n;
      const survival = survMap.get(p.id) ?? 0;
      const kos = Math.min(config.scoring.koCap, sp?.kos ?? 0) * config.scoring.koBonus;
      const predictBonus =
        p.predicted && rankMap.get(p.predicted) === 1 ? config.scoring.predictBonus : 0;
      const points = survival + kos + p.roundPuzzleBonus + predictBonus;

      p.roundRank = rank;
      p.roundSurvival = survival;
      p.roundKos = kos;
      p.roundPredictBonus = predictBonus;
      p.roundPoints = points;
      p.score = Math.round((p.score + points) * 10) / 10;
      p.deathCause = sp ? (sp.deathCause ?? (sp.alive ? null : 'collapse')) : 'timeout';
      const killer = sp?.killerId ? this.players.get(sp.killerId) : null;
      p.killedByName = killer ? killer.name : null;
      if (rank === 1) p.roundWins++;
      p.kos += Math.min(config.scoring.koCap, sp?.kos ?? 0);

      rows.push({
        playerId: p.id,
        name: p.name,
        color: p.color,
        rank,
        survival,
        kos,
        puzzleBonus: p.roundPuzzleBonus,
        predictBonus,
        roundPoints: points,
        totalScore: p.score,
        deathCause: p.deathCause,
        killedByName: p.killedByName,
      });
    }

    rows.sort((a, b) => a.rank - b.rank || b.roundPoints - a.roundPoints);

    const result: RoundResult = {
      round: this.round,
      rows,
      arenaDurationSec: Math.round(arenaDurationSec * 10) / 10,
      fallOrder: sim.fallOrder.slice(),
    };
    this.roundResults.push(result);
    this.broadcast('round:result', result);

    // سجل الجولة
    appendRoundLog({
      ts: new Date().toISOString(),
      room: this.code,
      seed: this.seed,
      round: this.round,
      rounds: this.rounds,
      players: this.players.size,
      puzzleType: this.puzzleType,
      difficulty: this.puzzleDifficulty,
      arenaDurationSec: result.arenaDurationSec,
      fallOrder: result.fallOrder,
      rows: rows.map((r) => ({
        id: r.playerId,
        name: r.name,
        correct: this.puzzleRows.find((x) => x.playerId === r.playerId)?.correct ?? false,
        effectiveMs: this.puzzleRows.find((x) => x.playerId === r.playerId)?.effectiveMs ?? null,
        item: this.players.get(r.playerId)?.item ?? null,
        rank: r.rank,
        kos: r.kos,
        deathCause: r.deathCause,
        points: r.roundPoints,
      })),
    });

    this.sim = null;
    this.enterPhase('ROUND_RESULT', config.phase.roundResult * 1000);
  }

  private finishMatch() {
    const rows = Array.from(this.players.values()).map((p) => ({
      playerId: p.id,
      name: p.name,
      color: p.color,
      total: p.score,
      kos: p.kos,
      roundWins: p.roundWins,
      puzzleMsSum: p.puzzleAnswered ? p.puzzleMsSum / p.puzzleAnswered : Number.MAX_SAFE_INTEGER,
      tied: false,
    }));
    rows.sort(
      (a, b) =>
        b.total - a.total ||
        b.kos - a.kos ||
        b.roundWins - a.roundWins ||
        a.puzzleMsSum - b.puzzleMsSum
    );
    // التعادل التام = فوز مشترك
    const top = rows[0];
    const winners = rows
      .filter(
        (r) =>
          r.total === top.total &&
          r.kos === top.kos &&
          r.roundWins === top.roundWins &&
          r.puzzleMsSum === top.puzzleMsSum
      )
      .map((r) => r.playerId);
    if (winners.length > 1) for (const r of rows) if (winners.includes(r.playerId)) r.tied = true;

    const result: MatchResult = { rows, winners };
    this.broadcast('match:result', result);
    this.enterPhase('MATCH_RESULT', config.phase.matchResult * 1000);
  }

  // ------------------------------------------------------------------ الحلقة
  private startLoop() {
    this.lastTick = performance.now();
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    if (this.dead) return;
    const now = performance.now();
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (dt > 0.25) dt = 0.25;
    this.acc += dt;
    const step = 1 / config.net.tickHz;

    // الوميض المجدول
    if (this.phase === 'PUZZLE' && this.pendingFlashes.length) {
      const nowMs = Date.now();
      while (this.pendingFlashes.length && this.pendingFlashes[0].at <= nowMs) {
        const f = this.pendingFlashes.shift()!;
        this.broadcast('puzzle:flash', { cell: f.cell });
      }
      if (!this.pendingFlashes.length) this.broadcast('puzzle:flashEnd', {});
    }

    if (this.phase === 'ARENA' && this.sim) {
      while (this.acc >= step) {
        this.acc -= step;
        this.sim.step(step);
        this.tickCount++;
        // أحداث
        if (this.sim.events.length) {
          const evs = this.sim.events.splice(0, this.sim.events.length);
          for (const e of evs) this.broadcast('event', e);
        }
        if (this.tickCount % SNAP_EVERY === 0) this.broadcastSnap();
      }

      const sim = this.sim;
      if (!this.arenaEndAt) {
        if (sim.aliveCount <= 1) {
          this.arenaEndAt = Date.now() + config.phase.arenaEndDelay * 1000;
        } else if (sim.t >= config.phase.arenaMax) {
          sim.triggerFinale();
          this.arenaEndAt = Date.now() + (config.phase.finaleFallSec + 0.4) * 1000;
        }
      } else if (Date.now() >= this.arenaEndAt) {
        this.finishArena();
        return;
      }
    } else {
      this.acc = 0;
    }

    if (this.phaseEndsAt && Date.now() >= this.phaseEndsAt) this.advance();
  }

  private broadcastSnap() {
    const sim = this.sim;
    if (!sim) return;
    const players = sim.players.map((p) => ({
      id: p.id,
      x: round3(p.x),
      y: round3(p.y),
      z: round3(p.z),
      a: p.alive ? 1 : 0,
      it: p.item,
      ia: p.itemActiveUntil > sim.t ? p.lastItem : null,
      iat: Math.round(Math.max(0, p.itemActiveUntil - sim.t) * 10) / 10,
      at: p.anchorUntil > sim.t && p.anchorTile !== null ? p.anchorTile : -1,
      dc: Math.max(0, Math.min(1, 1 - (p.dashReadyAt - sim.t) / config.dash.cooldown)),
      fx: round3(p.faceX),
      fz: round3(p.faceZ),
      off: this.players.get(p.id)?.connected ? 0 : 1,
    }));
    const msg = { t: Date.now(), tick: this.tickCount, players, tiles: sim.tileStatesString() };
    this.broadcast('snap', msg);
  }

  private advance() {
    switch (this.phase) {
      case 'COUNTDOWN':
        this.nextRound();
        break;
      case 'PUZZLE':
        this.resolvePuzzle();
        this.startDraft();
        break;
      case 'DRAFT':
        this.resolveDraft();
        break;
      case 'ARENA_INTRO': {
        this.enterPhase('ARENA', config.phase.arenaMax * 1000 + (config.phase.finaleFallSec + 1) * 1000);
        // بدء احتساب الوميض/الحركة من الآن
        this.lastTick = performance.now();
        this.acc = 0;
        this.tickCount = 0;
        break;
      }
      case 'ARENA':
        this.finishArena();
        break;
      case 'ROUND_RESULT':
        if (this.round >= this.rounds) this.finishMatch();
        else this.nextRound();
        break;
      case 'MATCH_RESULT':
        this.phase = 'LOBBY';
        this.round = 0;
        this.roundResults = [];
        for (const p of this.players.values()) {
          p.score = 0;
          p.kos = 0;
          p.roundWins = 0;
          p.puzzleMsSum = 0;
          p.puzzleAnswered = 0;
        }
        this.enterPhase('LOBBY', 0);
        this.broadcastState();
        break;
      default:
        break;
    }
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function sanitizeName(raw: unknown): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/[\u0000-\u001f\u007f-\u009f<>"'`\\/]/g, '');
  s = s.replace(/\s+/g, ' ');
  if (!s) s = 'لاعب';
  return Array.from(s).slice(0, config.room.nameMaxLen).join('');
}

export { survivalPoints };
