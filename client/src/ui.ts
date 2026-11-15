import type { Net } from './net';
import type { ArenaScene } from './scene';
import type { AudioEngine } from './audio';
import { t } from './i18n';
import { buildPuzzle, puzzleTitle, type PuzzleView } from './puzzles';
import { ITEM_IDS, type ItemId, type RoundResult, type MatchResult } from '@shared/index';

// أيقونات SVG مضمّنة — مضمونة على كل الأجهزة (بلا خطوط خارجية)
const ITEM_ICONS: Record<ItemId, string> = {
  charge:
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M13.5 2 4 14h6l-1 8 9.5-12h-6z" fill="#ffd23f"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 2 4 5v7c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V5z" fill="#31c3ff"/></svg>',
  anchor:
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#33e0c0" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="4.5" r="2"/><path d="M12 7v14M5 12h14M4 15c0 3.5 3.6 6 8 6s8-2.5 8-6"/></svg>',
  jump:
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 2.5 5 11h4.2v6h5.6v-6H19z" fill="#7bdc4a"/><rect x="5" y="19.2" width="14" height="2.2" rx="1.1" fill="#7bdc4a"/></svg>',
};
const itemIcon = (id: ItemId) => ITEM_ICONS[id] ?? '';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export class UI {
  private screens = {
    home: $('#screen-home'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
    result: $('#screen-result'),
  };
  private overlayHost = $('#overlayHost');
  private puzzleView: PuzzleView | null = null;
  private puzzleRound = -1;
  private currentOverlay: 'none' | 'puzzle' | 'draft' | 'result' | 'countdown' = 'none';
  private lastPhase = '';
  private lastBeep = 0;
  private draftPick: ItemId | null = null;
  private lastItems: Record<string, ItemId | null> = {};
  private prediction: string | null = null;

  constructor(private net: Net, private scene: ArenaScene, private audio: AudioEngine) {}

  // ---------------------------------------------------------------- الشاشات
  showScreen(name: 'home' | 'lobby' | 'game') {
    this.screens.home.classList.toggle('hidden', name !== 'home');
    this.screens.lobby.classList.toggle('hidden', name !== 'lobby');
    this.screens.game.classList.toggle('hidden', name !== 'game');
    this.screens.result.classList.add('hidden');
  }

  error(msg: string) {
    const el = $('#homeErr');
    if (el) {
      el.textContent = msg;
      setTimeout(() => {
        if (el.textContent === msg) el.textContent = '';
      }, 3200);
    }
  }

  toast(msg: string, ms = 2200) {
    const host = $('#toast');
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    host.appendChild(d);
    setTimeout(() => {
      d.style.opacity = '0';
      d.style.transition = 'opacity .3s';
      setTimeout(() => d.remove(), 320);
    }, ms);
  }

  // ---------------------------------------------------------------- اللوبي
  renderLobby() {
    const s = this.net.state;
    $('#lobbyCode').textContent = s.code ?? '----';
    const list = $('#lobbyPlayers');
    list.innerHTML = '';
    for (const p of s.players) {
      const row = document.createElement('div');
      row.className = 'prow';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      dot.style.color = p.color;
      const nm = document.createElement('span');
      nm.style.flex = '1';
      nm.textContent = p.name + (p.id === s.youId ? ' (أنت)' : '');
      row.append(dot, nm);
      if (p.isHost) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t('lobby.host');
        row.appendChild(tag);
      }
      if (!p.connected) {
        const tag = document.createElement('span');
        tag.className = 'tag off';
        tag.textContent = t('lobby.disconnected');
        row.appendChild(tag);
      }
      list.appendChild(row);
    }
    $('#playerCount').textContent = String(s.players.length);
    const isHost = s.hostId === s.youId;
    const startBtn = $<HTMLButtonElement>('#startBtn');
    startBtn.disabled = !(isHost && s.canStart);
    startBtn.textContent = t('lobby.start');
    $('#lobbyHint').textContent = isHost
      ? s.players.length < 2
        ? t('lobby.needPlayers')
        : 'اضغط ابدأ حين يكون الجميع جاهزًا'
      : t('lobby.waitingHost');
    document.querySelectorAll<HTMLButtonElement>('#roundsSeg button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.rounds) === s.rounds);
      b.disabled = !isHost;
    });
  }

  // ---------------------------------------------------------------- المراحل
  enterPhase(name: string) {
    const s = this.net.state;
    this.lastPhase = name;
    const phaseNames: Record<string, string> = {
      LOBBY: t('phase.LOBBY'),
      COUNTDOWN: t('phase.COUNTDOWN'),
      PUZZLE: t('phase.PUZZLE'),
      DRAFT: t('phase.DRAFT'),
      ARENA_INTRO: t('phase.ARENA_INTRO'),
      ARENA: t('phase.ARENA'),
      ROUND_RESULT: t('phase.ROUND_RESULT'),
      MATCH_RESULT: t('phase.MATCH_RESULT'),
    };
    $('#phaseName').textContent = phaseNames[name] ?? name;

    if (name === 'LOBBY') {
      this.clearOverlay();
      this.showScreen('lobby');
      this.renderLobby();
      this.audio.setTheme('lobby');
      return;
    }
    if (name === 'MATCH_RESULT' || name === 'ROUND_RESULT') {
      this.audio.setTheme('result');
    }
    this.showScreen('game');
    if (name === 'COUNTDOWN') {
      this.clearOverlay();
      this.audio.setTheme('puzzle');
      this.showCountdown();
    } else if (name === 'PUZZLE') {
      this.audio.setTheme('puzzle');
      this.showPuzzle();
    } else if (name === 'DRAFT') {
      this.audio.setTheme('lobby');
      this.showDraft();
    } else if (name === 'ARENA_INTRO') {
      this.clearOverlay();
      this.audio.setTheme('arena');
      this.lastItems = s.phaseData?.items ?? this.lastItems;
      const mine = this.lastItems[s.youId ?? ''] ?? null;
      this.toast(mine ? `${t('item.' + mine)} — ${t('item.' + mine + '.desc')}` : t('draft.none'), 3000);
    } else if (name === 'ARENA') {
      this.clearOverlay();
      this.audio.setTheme('arena');
      this.audio.sfx('countdown');
    }
  }

  private showCountdown() {
    this.overlayHost.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.textAlign = 'center';
    panel.innerHTML = `<h2 style="font-size:26px">${t('start.countdown')}</h2>
      <div id="cdNum" style="font-size:72px;font-weight:800;color:#16d3c4;line-height:1.1">3</div>`;
    this.overlayHost.appendChild(panel);
    this.currentOverlay = 'countdown';
    const tick = () => {
      const left = Math.max(0, (this.net.state.endsAt - this.net.serverNow()) / 1000);
      const n = Math.ceil(left);
      const el = document.getElementById('cdNum');
      if (el) el.textContent = String(n);
      if (n > 0 && n !== this.lastBeep) {
        this.lastBeep = n;
        this.audio.sfx('countdown');
      }
    };
    tick();
    const iv = setInterval(() => {
      if (this.currentOverlay !== 'countdown') return clearInterval(iv);
      tick();
    }, 100);
  }

  // ---------------------------------------------------------------- اللغز
  showPuzzle() {
    const data = this.net.state.puzzle;
    if (!data) return;
    this.clearOverlay();
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = puzzleTitle(data.type);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `جولة ${data.round} · صعوبة ${data.difficulty}/10`;
    panel.append(h, sub);
    this.overlayHost.appendChild(panel);
    this.currentOverlay = 'puzzle';
    this.puzzleRound = data.round;

    this.puzzleView = buildPuzzle(data, (payload) => {
      this.net.answer(payload);
    });
    panel.appendChild(this.puzzleView.el);
  }

  onPuzzleAck(a: any) {
    this.puzzleView?.ack?.(a);
    if (a.correct) {
      this.audio.sfx('correct');
      this.audio.vibrate(30);
      this.toast(t('puzzle.correctIn', { ms: Math.round(a.effectiveMs ?? 0) }), 1600);
    } else {
      this.audio.sfx('wrong');
      this.audio.vibrate([20, 40, 20]);
    }
  }
  onPuzzleFlash(cell: number) {
    this.puzzleView?.flash?.(cell);
    this.audio.sfx('pick', 0.4);
  }
  onPuzzleFlashEnd() {
    this.puzzleView?.flashEnd?.();
  }

  // ---------------------------------------------------------------- الاختيار
  showDraft() {
    this.clearOverlay();
    const s = this.net.state;
    const inv = s.phaseData?.inventory ?? { charge: 0, shield: 0, anchor: 0, jump: 0 };
    const demand = s.phaseData?.demand ?? { charge: 0, shield: 0, anchor: 0, jump: 0 };
    this.draftPick = null;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h2>${t('draft.title')}</h2><div class="sub">${t('draft.sub')}</div>`;
    const grid = document.createElement('div');
    grid.className = 'items';
    for (const id of ITEM_IDS) {
      const el = document.createElement('div');
      el.className = 'item';
      el.dataset.item = id;
      el.innerHTML = `
        <div class="ico">${itemIcon(id)}</div>
        <div class="nm">${t('item.' + id)}</div>
        <div class="st" data-stock>${t('draft.stock', { n: inv[id] })}</div>
        <div class="st" data-demand>${t('draft.demand', { n: demand[id] })}</div>
        <div class="dsc">${t('item.' + id + '.desc')}</div>`;
      el.addEventListener('click', () => {
        this.draftPick = id;
        this.net.pick(id);
        this.audio.sfx('pick');
        grid.querySelectorAll('.item').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      });
      grid.appendChild(el);
    }
    panel.appendChild(grid);

    const order = document.createElement('div');
    order.className = 'hint';
    order.style.marginTop = '10px';
    const names = (s.phaseData?.order ?? []).join(' ← ');
    order.textContent = `${t('draft.order')}: ${names}`;
    panel.appendChild(order);

    this.overlayHost.appendChild(panel);
    this.currentOverlay = 'draft';
    this.updateDraftCounts();
  }

  onDraftDemand(d: { demand: Record<ItemId, number>; inventory: Record<ItemId, number> }) {
    if (this.currentOverlay !== 'draft') return;
    this.updateDraftCounts();
  }

  private updateDraftCounts() {
    const d = this.net.state.draft;
    if (!d) return;
    document.querySelectorAll<HTMLElement>('.item').forEach((el) => {
      const id = el.dataset.item as ItemId;
      const stock = d.inventory[id] ?? 0;
      const dem = d.demand[id] ?? 0;
      const st = el.querySelector('[data-stock]') as HTMLElement;
      const dm = el.querySelector('[data-demand]') as HTMLElement;
      if (st) st.textContent = t('draft.stock', { n: stock });
      if (dm) {
        dm.textContent = t('draft.demand', { n: dem });
        dm.classList.toggle('hot', dem > stock);
      }
      el.classList.toggle('out', stock === 0);
    });
  }

  onDraftPicked(d: { picked: Record<string, ItemId | null>; remaining: Record<ItemId, number> }) {
    this.lastItems = d.picked;
    const s = this.net.state;
    const mine = d.picked[s.youId ?? ''];
    this.toast(mine ? `أداتك: ${t('item.' + mine)}` : 'لم تحصل على أداة', 2600);
  }

  // ---------------------------------------------------------------- الحلبة
  frame(dt: number) {
    const s = this.net.state;
    if (s.phase === 'LOBBY') return;
    const left = Math.max(0, (s.endsAt - this.net.serverNow()) / 1000);
    $('#timerVal').textContent = s.endsAt ? (left < 10 ? left.toFixed(1) : String(Math.ceil(left))) : '—';
    $('#roundLabel').textContent = `${t('round')} ${Math.max(1, s.round)}/${s.rounds}`;
    this.updateScoreboard();
    this.updateControls();
    this.updateSpectator();
  }

  private updateScoreboard() {
    const s = this.net.state;
    const host = $('#scoreboard');
    const snap = this.net.snaps[this.net.snaps.length - 1];
    const alive = new Map<string, boolean>();
    if (snap) for (const p of snap.players) alive.set(p.id, p.a === 1);
    const sorted = [...s.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    host.innerHTML = '';
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'srow' + (p.id === s.youId ? ' me' : '') + (alive.get(p.id) === false ? ' dead' : '');
      row.style.borderRightColor = p.color;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      dot.style.color = p.color;
      dot.style.width = '9px';
      dot.style.height = '9px';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      const sc = document.createElement('span');
      sc.className = 'sc';
      sc.textContent = String(Math.round(p.score * 10) / 10);
      row.append(dot, nm, sc);
      host.appendChild(row);
    }
  }

  private updateControls() {
    const s = this.net.state;
    const snap = this.net.snaps[this.net.snaps.length - 1];
    const me = snap?.players.find((p) => p.id === s.youId);
    const fill = $('#dashFill');
    const dc = me ? me.dc : 1;
    fill.style.transform = `scaleY(${Math.max(0, 1 - dc)})`;
    $('#dashBtn').classList.toggle('ready', dc >= 1);
    const item = me?.it ?? null;
    const active = me?.ia ?? null;
    const label = $('#itemLabel');
    const show = item ?? active;
    label.innerHTML = show
      ? `${itemIcon(show)}<div style="font-size:10px">${t('item.' + show)}${item ? '' : ' ✓'}</div>`
      : '—';
    $('#itemBtn').classList.toggle('empty', !item && !active);
  }

  private updateSpectator() {
    const s = this.net.state;
    const box = $('#spectator');
    const snap = this.net.snaps[this.net.snaps.length - 1];
    const me = snap?.players.find((p) => p.id === s.youId);
    const dead = s.phase === 'ARENA' && me && me.a === 0;
    if (!dead) {
      box.classList.add('hidden');
      return;
    }
    const alivePlayers = (snap?.players ?? []).filter((p) => p.a === 1);
    box.classList.remove('hidden');
    if (this.prediction) {
      const nm = s.players.find((p) => p.id === this.prediction)?.name ?? '';
      box.textContent = t('hud.predicted', { name: nm });
      return;
    }
    if (alivePlayers.length < 3) {
      box.textContent = `${t('hud.spectator')} · ${t('hud.predictionLocked')}`;
      return;
    }
    box.innerHTML = `<div>${t('hud.spectator')} · ${t('hud.predict')}</div>`;
    const list = document.createElement('div');
    list.className = 'plist';
    for (const p of alivePlayers) {
      const meta = s.players.find((x) => x.id === p.id);
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = meta?.name ?? '؟';
      b.style.background = meta?.color ?? '#16d3c4';
      b.addEventListener('click', () => {
        this.net.predict(p.id);
        this.prediction = p.id;
      });
      list.appendChild(b);
    }
    box.appendChild(list);
  }

  // ---------------------------------------------------------------- النتائج
  clearOverlay() {
    this.puzzleView?.destroy?.();
    this.puzzleView = null;
    this.overlayHost.innerHTML = '';
    this.currentOverlay = 'none';
  }

  showRoundResult(r: RoundResult) {
    this.clearOverlay();
    this.screens.result.classList.add('hidden');
    const panel = document.createElement('div');
    panel.className = 'panel';
    const rows = r.rows
      .map((row) => {
        const why =
          row.deathCause === 'pushed' && row.killedByName
            ? t('result.whyPushed', { name: row.killedByName })
            : row.deathCause === 'timeout'
            ? t('result.whyTimeout')
            : row.deathCause
            ? t('result.whyCollapse')
            : t('result.alive');
        const detail = [
          `${t('result.survival')} ${row.survival}`,
          row.kos ? `${t('result.kos')} +${row.kos}` : '',
          row.puzzleBonus ? `${t('result.puzzle')} +${row.puzzleBonus}` : '',
          row.predictBonus ? `${t('result.predict')} +${row.predictBonus}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `<div class="r ${row.rank === 1 ? 'top' : ''}">
          <div class="rank">${row.rank % 1 === 0 ? row.rank : row.rank.toFixed(1)}</div>
          <div class="who"><span style="color:${row.color};font-weight:700">${escapeHtml(row.name)}</span>
            <span class="why">${why}</span></div>
          <div class="pts" dir="ltr">+${row.roundPoints}<small dir="rtl">${detail}</small></div>
        </div>`;
      })
      .join('');
    panel.innerHTML = `<h2>${t('result.roundTitle', { round: r.round })}</h2>
      <div class="sub">مدة الحلبة ${r.arenaDurationSec}s</div>
      <div class="rtable">${rows}</div>
      <div class="hint" id="nextHint"></div>`;
    this.overlayHost.appendChild(panel);
    this.currentOverlay = 'result';
    this.prediction = null;
  }

  showMatchResult(r: MatchResult) {
    this.clearOverlay();
    this.screens.result.classList.add('hidden');
    const top = r.rows.slice(0, 3);
    const heights = [92, 68, 48];
    const medals = ['1', '2', '3'];
    const podium = top
      .map(
        (row, i) => `<div class="p">
          <div class="nm" style="color:${row.color};font-weight:700">${escapeHtml(row.name)}</div>
          <div class="bar" style="height:${heights[i]}px;background:linear-gradient(180deg,${row.color},#0b3d3a)">${medals[i]}</div>
          <div class="nm" style="color:#8ba0c4">${row.total}</div>
        </div>`
      )
      .join('');
    const table = r.rows
      .map(
        (row, i) => `<div class="r ${i === 0 ? 'top' : ''}">
          <div class="rank">${i + 1}</div>
          <div class="who"><span style="color:${row.color};font-weight:700">${escapeHtml(row.name)}</span>
            <span class="why">إسقاط ${row.kos} · فوز جولات ${row.roundWins} · متوسط لغز ${
          row.puzzleMsSum === Number.MAX_SAFE_INTEGER ? '—' : Math.round(row.puzzleMsSum) + 'ms'
        }</span></div>
          <div class="pts">${row.total}</div>
        </div>`
      )
      .join('');
    const winners = r.rows
      .filter((x) => r.winners.includes(x.playerId))
      .map((x) => escapeHtml(x.name))
      .join(' و ');
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h2>${r.winners.length > 1 ? t('result.tie') : t('result.winner')}: ${winners}</h2>
      <div class="podium">${podium}</div>
      <div class="rtable">${table}</div>
      <div style="height:12px"></div>
      <button id="againBtn">${t('result.playAgain')}</button>`;
    this.overlayHost.appendChild(panel);
    this.currentOverlay = 'result';
    this.audio.sfx('win');
    panel.querySelector('#againBtn')?.addEventListener('click', () => {
      this.clearOverlay();
    });
  }

  get phase() {
    return this.lastPhase;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
