import { io, type Socket } from 'socket.io-client';
import type { Snap, PhaseName, LobbyPlayer, ItemId } from '@shared/index';

type Handler = (data?: any) => void;

export class Emitter {
  private map = new Map<string, Set<Handler>>();
  on(ev: string, h: Handler) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(h);
    return () => this.map.get(ev)!.delete(h);
  }
  emit(ev: string, data?: any) {
    const set = this.map.get(ev);
    if (set) for (const h of set) h(data);
  }
}

export interface ClientState {
  code: string | null;
  youId: string | null;
  token: string | null;
  name: string;
  players: LobbyPlayer[];
  hostId: string;
  phase: PhaseName;
  endsAt: number;
  round: number;
  rounds: number;
  canStart: boolean;
  phaseData: any;
  puzzle: any;
  draft: { inventory: Record<ItemId, number>; demand: Record<ItemId, number> } | null;
  items: Record<string, ItemId | null>;
  connected: boolean;
}

export class Net extends Emitter {
  socket: Socket;
  clockOffset = 0; // serverNow - clientNow
  rtt = 0;
  snaps: Snap[] = [];
  state: ClientState = {
    code: null,
    youId: null,
    token: null,
    name: '',
    players: [],
    hostId: '',
    phase: 'LOBBY',
    endsAt: 0,
    round: 0,
    rounds: 3,
    canStart: false,
    phaseData: null,
    puzzle: null,
    draft: null,
    items: {},
    connected: false,
  };

  private bestRtt = Infinity;
  private pingTimer: number | null = null;
  private clockTimer: number | null = null;

  constructor() {
    super();
    this.socket = io({
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      this.state.connected = true;
      this.startPing();
      this.emit('connected');
    });
    this.socket.on('disconnect', () => {
      this.state.connected = false;
      this.emit('disconnected');
    });

    this.socket.on('pong', (m: { c: number; s: number }) => {
      const now = Date.now();
      const rtt = Math.max(0, now - m.c);
      // نعتمد أفضل عيّنة لتقليل الضجيج
      if (rtt <= this.bestRtt) {
        this.bestRtt = rtt;
        this.clockOffset = m.s + rtt / 2 - now;
      }
      this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
    });

    this.socket.on('joined', (m: any) => {
      this.state.code = m.code;
      this.state.youId = m.playerId;
      this.state.token = m.token;
      if (this.state.token) localStorage.setItem('koa_token_' + m.code, this.state.token);
      if (this.state.name) localStorage.setItem('koa_name', this.state.name);
      this.applyRoomState(m.state);
      this.emit('joined', m);
    });

    this.socket.on('room:state', (s: any) => this.applyRoomState(s));

    this.socket.on('phase', (p: any) => {
      this.state.phase = p.name;
      this.state.endsAt = p.endsAt;
      this.state.round = p.round;
      this.state.rounds = p.totalRounds;
      this.state.phaseData = p.data ?? null;
      if (p.name === 'PUZZLE') this.state.puzzle = p.data;
      if (p.name === 'DRAFT') this.state.draft = { inventory: p.data.inventory, demand: p.data.demand };
      if (p.name === 'ARENA_INTRO') this.state.items = p.data?.items ?? {};
      if (p.name !== 'ARENA' && p.name !== 'ARENA_INTRO') this.snaps.length = 0;
      this.emit('phase', p);
    });

    this.socket.on('snap', (s: Snap) => {
      this.snaps.push(s);
      if (this.snaps.length > 40) this.snaps.shift();
    });

    this.socket.on('event', (e: any) => this.emit('gameEvent', e));
    this.socket.on('err', (e: any) => this.emit('error', e));
    this.socket.on('puzzle:data', (d: any) => this.emit('puzzleData', d));
    this.socket.on('puzzle:flash', (d: any) => this.emit('puzzleFlash', d));
    this.socket.on('puzzle:flashEnd', () => this.emit('puzzleFlashEnd'));
    this.socket.on('puzzle:ack', (d: any) => this.emit('puzzleAck', d));
    this.socket.on('puzzle:result', (d: any) => this.emit('puzzleResult', d));
    this.socket.on('draft:demand', (d: any) => {
      if (this.state.draft) this.state.draft = { inventory: d.inventory, demand: d.demand };
      this.emit('draftDemand', d);
    });
    this.socket.on('draft:picked', (d: any) => this.emit('draftPicked', d));
    this.socket.on('round:result', (d: any) => this.emit('roundResult', d));
    this.socket.on('match:result', (d: any) => this.emit('matchResult', d));
    this.socket.on('predict:ack', (d: any) => this.emit('predictAck', d));
  }

  private applyRoomState(s: any) {
    if (!s) return;
    this.state.code = s.code;
    this.state.phase = s.phase;
    this.state.rounds = s.rounds;
    this.state.round = s.round;
    this.state.hostId = s.hostId;
    this.state.youId = s.youId ?? this.state.youId;
    this.state.players = s.players;
    this.state.canStart = s.canStart;
    this.emit('roomState', s);
  }

  private startPing() {
    if (this.pingTimer !== null) return;
    const ping = () => this.socket.emit('ping', { t: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  /** الوقت الحالي على الخادم بالمللي ثانية */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  create(name: string) {
    this.state.name = name;
    this.socket.emit('room:create', { name });
  }
  join(code: string, name: string) {
    this.state.name = name;
    const token = localStorage.getItem('koa_token_' + code) ?? '';
    this.socket.emit('room:join', { code, name, token });
  }
  rejoin(code: string) {
    const token = localStorage.getItem('koa_token_' + code) ?? '';
    if (!token) return false;
    this.socket.emit('room:join', { code, name: this.state.name, token });
    return true;
  }
  setRounds(r: number) {
    this.socket.emit('room:settings', { rounds: r });
  }
  startMatch() {
    this.socket.emit('room:start');
  }
  answer(payload: unknown) {
    this.socket.emit('puzzle:answer', { payload });
  }
  pick(item: ItemId) {
    this.socket.emit('draft:pick', { item });
  }
  predict(id: string) {
    this.socket.emit('predict', { playerId: id });
  }
  sendInput(x: number, z: number, dash: boolean, item: boolean) {
    // رسالة واحدة فقط كل 50ms — RTT يُرفَق بها بدل رسالة منفصلة
    // (رسالتان كانتا تضاعفان المعدل إلى 40/ث وتتجاوز حد الخادم 30/ث)
    this.socket.emit('input', { seq: 0, x, z, dash, item, rtt: Math.round(this.rtt) });
  }
  leave() {
    this.socket.emit('room:leave');
  }
}

/** استخراج كود الغرفة من رابط الدعوة */
export function roomFromUrl(): string | null {
  const p = new URLSearchParams(location.search);
  const r = p.get('room');
  return r ? r.toUpperCase().slice(0, 8) : null;
}
