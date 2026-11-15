/**
 * عرض الألغاز كصور (Canvas) لا كنص قابل للنسخ + واجهات التفاعل.
 * الجواب لا يصل للعميل إلا عبر واجهة الإدخال.
 */
import type { PuzzleDataMsg } from '@shared/index';
import { t } from './i18n';

export interface PuzzleView {
  el: HTMLElement;
  flash?: (cell: number) => void;
  flashEnd?: () => void;
  ack?: (a: { correct: boolean; lockedMs?: number; effectiveMs?: number }) => void;
  destroy: () => void;
}

const FONT = "'SF Arabic','Geeza Pro','Noto Kufi Arabic',system-ui,sans-serif";

function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  c.className = 'puzzle';
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { c, ctx };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function optionsGrid(
  labels: string[],
  onPick: (i: number) => void
): { el: HTMLElement; btns: HTMLButtonElement[] } {
  const wrap = document.createElement('div');
  wrap.className = 'opts';
  const btns: HTMLButtonElement[] = [];
  labels.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = label;
    b.addEventListener('click', () => onPick(i));
    wrap.appendChild(b);
    btns.push(b);
  });
  return { el: wrap, btns };
}

// ------------------------------------------------------------ المتتاليات
function buildSequence(data: PuzzleDataMsg, answer: (v: unknown) => void): PuzzleView {
  const p = data.payload as any;
  const terms: number[] = p.terms;
  const opts: number[] = p.options;
  const n = terms.length + 1;
  const W = 720;
  const H = 168;
  const { c, ctx } = makeCanvas(W, H);
  const gap = 8;
  const pad = 12;
  const bw = (W - pad * 2 - gap * (n - 1)) / n;
  terms.forEach((v, i) => {
    const x = pad + i * (bw + gap);
    ctx.fillStyle = '#0d1a34';
    roundRect(ctx, x, 24, bw, H - 48, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,200,220,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#eaf2ff';
    ctx.font = `800 ${Math.min(34, bw * 0.42)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), x + bw / 2, H / 2);
  });
  // خانة المجهول
  const x = pad + terms.length * (bw + gap);
  ctx.fillStyle = '#122d4d';
  roundRect(ctx, x, 24, bw, H - 48, 12);
  ctx.fill();
  ctx.strokeStyle = '#16d3c4';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#16d3c4';
  ctx.font = `800 ${Math.min(38, bw * 0.5)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', x + bw / 2, H / 2);

  const wrap = document.createElement('div');
  wrap.appendChild(c);
  let chosen: HTMLButtonElement | null = null;
  const { el, btns } = optionsGrid(opts.map(String), (i) => {
    btns.forEach((b) => (b.disabled = true));
    btns[i].classList.add('sel');
    chosen = btns[i];
    answer(opts[i]);
  });
  wrap.appendChild(el);
  const locked = document.createElement('div');
  locked.className = 'locked';
  wrap.appendChild(locked);

  return {
    el: wrap,
    ack(a) {
      if (a.correct) {
        btns.forEach((b) => (b.disabled = true));
        chosen?.classList.remove('sel');
        chosen?.classList.add('correct');
      } else {
        chosen?.classList.remove('sel');
        chosen?.classList.add('wrong');
        locked.textContent = `${t('puzzle.locked')} ${(a.lockedMs ?? 2000) / 1000}s`;
        setTimeout(() => {
          locked.textContent = '';
          btns.forEach((b) => (b.disabled = false));
        }, a.lockedMs ?? 2000);
      }
    },
    destroy() {
      wrap.remove();
    },
  };
}

// ------------------------------------------------------------ الحساب السريع
function buildArithmetic(data: PuzzleDataMsg, answer: (v: unknown) => void): PuzzleView {
  const p = data.payload as any;
  const opts: number[] = p.options;
  const W = 720;
  const H = 160;
  const { c, ctx } = makeCanvas(W, H);
  let size = 58;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  do {
    ctx.font = `800 ${size}px ${FONT}`;
    size -= 2;
  } while (ctx.measureText(p.expr).width > W - 40 && size > 20);
  ctx.fillStyle = '#eaf2ff';
  ctx.fillText(p.expr, W / 2, H / 2);
  // اتجاه LTR ضروري للتعبير
  c.style.direction = 'ltr';

  const wrap = document.createElement('div');
  wrap.appendChild(c);
  let chosen: HTMLButtonElement | null = null;
  const { el, btns } = optionsGrid(opts.map(String), (i) => {
    btns.forEach((b) => (b.disabled = true));
    chosen = btns[i];
    answer(opts[i]);
  });
  wrap.appendChild(el);
  const locked = document.createElement('div');
  locked.className = 'locked';
  wrap.appendChild(locked);

  return {
    el: wrap,
    ack(a) {
      if (a.correct) {
        btns.forEach((b) => (b.disabled = true));
        chosen?.classList.add('correct');
      } else {
        chosen?.classList.add('wrong');
        locked.textContent = `${t('puzzle.locked')} ${(a.lockedMs ?? 2000) / 1000}s`;
        setTimeout(() => {
          locked.textContent = '';
          btns.forEach((b) => (b.disabled = false));
        }, a.lockedMs ?? 2000);
      }
    },
    destroy() {
      wrap.remove();
    },
  };
}

// ------------------------------------------------------------ الذاكرة
function buildMemory(data: PuzzleDataMsg, answer: (v: unknown) => void): PuzzleView {
  const p = data.payload as any;
  const cols: number = p.cols;
  const rows: number = p.rows;
  const count: number = p.count;

  const wrap = document.createElement('div');
  const hint = document.createElement('div');
  hint.className = 'sub';
  hint.textContent = t('puzzle.watch');
  wrap.appendChild(hint);

  const grid = document.createElement('div');
  grid.className = 'memgrid';
  grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
  const cells: HTMLDivElement[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const d = document.createElement('div');
    d.className = 'memcell';
    grid.appendChild(d);
    cells.push(d);
  }
  wrap.appendChild(grid);

  let picking = false;
  let locked = false;
  const picks: number[] = [];

  const resetPicks = () => {
    picks.length = 0;
    cells.forEach((c) => {
      c.classList.remove('picked');
      c.textContent = '';
    });
  };

  cells.forEach((c, i) => {
    c.addEventListener('click', () => {
      if (!picking || locked || picks.includes(i)) return;
      picks.push(i);
      c.classList.add('picked');
      c.textContent = String(picks.length);
      if (picks.length === count) {
        answer(picks.slice());
      }
    });
  });

  const flashTimers: number[] = [];
  return {
    el: wrap,
    flash(cell: number) {
      const c = cells[cell];
      if (!c) return;
      c.classList.add('flash');
      const ms = Math.max(180, p.flashSec * 1000 - 120);
      flashTimers.push(
        window.setTimeout(() => {
          c.classList.remove('flash');
        }, ms)
      );
    },
    flashEnd() {
      picking = true;
      hint.textContent = t('puzzle.yourTurn');
    },
    ack(a) {
      if (a.correct) {
        picking = false;
        cells.forEach((c) => c.classList.add('picked'));
      } else {
        locked = true;
        hint.textContent = `${t('puzzle.locked')}…`;
        setTimeout(() => {
          resetPicks();
          locked = false;
          hint.textContent = t('puzzle.yourTurn');
        }, a.lockedMs ?? 2000);
      }
    },
    destroy() {
      flashTimers.forEach((x) => clearTimeout(x));
      wrap.remove();
    },
  };
}

// ------------------------------------------------------------ الدخيل
function shapeSvg(s: { sides: number; dots: number; spin: 1 | -1; sym: boolean }): string {
  const R = 42;
  const cx = 50;
  const cy = 46;
  const pts: string[] = [];
  for (let i = 0; i < s.sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / s.sides;
    pts.push(`${(cx + Math.cos(a) * R).toFixed(1)},${(cy + Math.sin(a) * R).toFixed(1)}`);
  }
  let dots = '';
  for (let i = 0; i < s.dots; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, s.dots);
    const r = s.dots === 1 ? 0 : 15;
    dots += `<circle cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}" r="4.2" fill="#0b1730"/>`;
  }
  const sym = s.sym
    ? `<line x1="${cx}" y1="2" x2="${cx}" y2="90" stroke="#16d3c4" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.8"/>`
    : '';
  const spin = s.spin === 1
    ? `<path d="M84 84 a9 9 0 1 0 -4 6" fill="none" stroke="#ffd23f" stroke-width="2"/><path d="M86 92 l-1 -8 l-7 3 z" fill="#ffd23f"/>`
    : `<path d="M84 84 a9 9 0 1 1 -4 -6" fill="none" stroke="#ffd23f" stroke-width="2"/><path d="M86 76 l-1 8 l-7 -3 z" fill="#ffd23f"/>`;
  return `<svg viewBox="0 0 100 100">
    <polygon points="${pts.join(' ')}" fill="#1e9d94" stroke="#5ff0e2" stroke-width="2"/>
    ${dots}${sym}${spin}
  </svg>`;
}

function buildOdd(data: PuzzleDataMsg, answer: (v: unknown) => void): PuzzleView {
  const p = data.payload as any;
  const shapes = p.shapes as Array<{ sides: number; dots: number; spin: 1 | -1; sym: boolean }>;
  const wrap = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'oddwrap';
  const cells: HTMLDivElement[] = [];
  shapes.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'oddcell';
    d.innerHTML = shapeSvg(s);
    d.addEventListener('click', () => {
      if (d.dataset.locked === '1') return;
      cells.forEach((c) => c.classList.remove('sel'));
      d.classList.add('sel');
      cells.forEach((c) => (c.dataset.locked = '1'));
      answer(i);
    });
    grid.appendChild(d);
    cells.push(d);
  });
  wrap.appendChild(grid);
  const locked = document.createElement('div');
  locked.className = 'locked';
  wrap.appendChild(locked);
  return {
    el: wrap,
    ack(a?: { correct: boolean; lockedMs?: number }) {
      if (!a || a.correct) {
        cells.forEach((c, i) => {
          if (c.classList.contains('sel')) c.style.outline = '3px solid #2ee6d6';
        });
        return;
      }
      locked.textContent = `${t('puzzle.locked')} ${(a.lockedMs ?? 2000) / 1000}s`;
      setTimeout(() => {
        locked.textContent = '';
        cells.forEach((c) => {
          c.dataset.locked = '0';
          c.classList.remove('sel');
        });
      }, a.lockedMs ?? 2000);
    },
    destroy() {
      wrap.remove();
    },
  };
}

export function buildPuzzle(data: PuzzleDataMsg, answer: (v: unknown) => void): PuzzleView {
  switch (data.payload.type) {
    case 'sequence':
      return buildSequence(data, answer);
    case 'arithmetic':
      return buildArithmetic(data, answer);
    case 'memory':
      return buildMemory(data, answer);
    case 'odd':
      return buildOdd(data, answer);
    default:
      return { el: document.createElement('div'), destroy() {} };
  }
}

export function puzzleTitle(type: string): string {
  return t('puzzle.' + type);
}
