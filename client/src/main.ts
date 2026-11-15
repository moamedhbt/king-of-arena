import { Net, roomFromUrl } from './net';
import { ArenaScene } from './scene';
import { Controls } from './input';
import { AudioEngine } from './audio';
import { UI } from './ui';
import { t } from './i18n';
import { config } from '@shared/index';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const canvas = $('#gl') as unknown as HTMLCanvasElement;
const net = new Net();
const scene = new ArenaScene(canvas);
const audio = new AudioEngine();
const ui = new UI(net, scene, audio);
const controls = new Controls($('#joystick'), $('#stick'), $('#dashBtn'), $('#itemBtn'));

const nameInput = $<HTMLInputElement>('#nameInput');
const codeInput = $<HTMLInputElement>('#codeInput');
nameInput.value = localStorage.getItem('koa_name') ?? '';
if (localStorage.getItem('koa_audio') === '0') {
  audio.enabled = false;
  audio.musicOn = false;
}

// ردّة فعل فورية للصوت والاهتزاز عند ضغط الاندفاع (بلا تنبؤ فيزيائي)
controls.onDash = () => {
  audio.init();
  audio.sfx('dash');
  audio.vibrate(18);
};
controls.onItem = () => {
  audio.init();
  audio.sfx('pick');
};

const currentName = () => (nameInput.value.trim() || 'لاعب').slice(0, config.room.nameMaxLen);

function firstGesture() {
  audio.init();
  window.removeEventListener('pointerdown', firstGesture);
  window.removeEventListener('keydown', firstGesture);
}
window.addEventListener('pointerdown', firstGesture);
window.addEventListener('keydown', firstGesture);

// ------------------------------------------------------------------ الرئيسية
$('#createBtn').addEventListener('click', () => {
  audio.init();
  net.create(currentName());
});
$('#joinBtn').addEventListener('click', () => {
  audio.init();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < config.room.codeLen) {
    ui.error('أدخل كود الغرفة (4 أحرف)');
    return;
  }
  net.join(code, currentName());
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#joinBtn').click();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') codeInput.focus();
});

// رابط دعوة
const urlRoom = roomFromUrl();
if (urlRoom) {
  codeInput.value = urlRoom;
  const saved = localStorage.getItem('koa_name');
  if (saved) net.join(urlRoom, saved);
  else {
    nameInput.focus();
    ui.toast('أدخل اسمك ثم اضغط «انضمام» — كود الغرفة جاهز', 5000);
  }
}

// ------------------------------------------------------------------ اللوبي
$('#copyLinkBtn').addEventListener('click', async () => {
  const code = net.state.code;
  if (!code) return;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  try {
    await navigator.clipboard.writeText(url);
    ui.toast(t('copied'));
  } catch {
    ui.toast(url, 4000);
  }
});
$('#copyCodeBtn').addEventListener('click', async () => {
  const code = net.state.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    ui.toast(t('copied'));
  } catch {
    ui.toast(code, 3000);
  }
});
document.querySelectorAll<HTMLButtonElement>('#roundsSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    audio.sfx('pick');
    net.setRounds(Number(b.dataset.rounds));
  });
});
$('#startBtn').addEventListener('click', () => {
  audio.init();
  net.startMatch();
});

// الصوت
const soundBtn = $('#soundBtn');
const SPEAKER_ON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#eaf2ff" stroke-width="2" stroke-linecap="round"><path d="M4 9.5h3.5L13 5v14L7.5 14.5H4z" fill="#eaf2ff" stroke="none"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#8ba0c4" stroke-width="2" stroke-linecap="round"><path d="M4 9.5h3.5L13 5v14L7.5 14.5H4z" fill="#8ba0c4" stroke="none"/><path d="M17 9.5l5 5M22 9.5l-5 5"/></svg>';
soundBtn.innerHTML = audio.enabled ? SPEAKER_ON : SPEAKER_OFF;
soundBtn.addEventListener('click', () => {
  audio.init();
  soundBtn.innerHTML = audio.toggle() ? SPEAKER_ON : SPEAKER_OFF;
});

// ------------------------------------------------------------------ الشبكة
net.on('joined', (m: any) => {
  history.replaceState(null, '', `${location.pathname}?room=${m.code}`);
  ui.showScreen(net.state.phase === 'LOBBY' ? 'lobby' : 'game');
  ui.renderLobby();
  audio.sfx('join');
});
net.on('roomState', () => {
  if (net.state.phase === 'LOBBY') {
    ui.showScreen('lobby');
    ui.renderLobby();
  } else {
    ui.renderLobby();
  }
});
net.on('phase', (p: any) => {
  if (p.name === 'ARENA_INTRO') {
    scene.resetArena();
    // إعادة بناء المشهد للجولة الجديدة
    net.snaps.length = 0;
  }
  ui.enterPhase(p.name);
});
net.on('error', (e: any) => {
  ui.error(t('errors.' + e.code) || e.message || 'خطأ');
  // الغرفة لم تعد موجودة (انتهت مهلتها أو أُعيد تشغيل الخادم):
  // نخرج إلى الشاشة الرئيسية بدل إبقاء الواجهة تَعِد بغرفة غير قائمة
  if (e?.code === 'NO_ROOM' && net.state.code) {
    const lost = net.state.code;
    net.state.code = null;
    net.state.token = null;
    localStorage.removeItem('koa_token_' + lost);
    codeInput.value = lost; // نُبقي الكود مكتوبًا ليسهل إعادة المحاولة
    history.replaceState(null, '', location.pathname);
    ui.showScreen('home');
    ui.error('انتهت الغرفة أو أُعيد تشغيل الخادم — أنشئ غرفة جديدة');
  }
});
net.on('disconnected', () => ui.toast(t('conn.lost'), 3000));
net.on('connected', () => {
  const code = net.state.code;
  if (code) net.rejoin(code);
});
net.on('gameEvent', (e: any) => onGameEvent(e));
net.on('puzzleAck', (a: any) => ui.onPuzzleAck(a));
net.on('puzzleFlash', (d: any) => ui.onPuzzleFlash(d.cell));
net.on('puzzleFlashEnd', () => ui.onPuzzleFlashEnd());
net.on('draftDemand', (d: any) => ui.onDraftDemand(d));
net.on('draftPicked', (d: any) => ui.onDraftPicked(d));
net.on('roundResult', (r: any) => ui.showRoundResult(r));
net.on('matchResult', (r: any) => ui.showMatchResult(r));

function onGameEvent(e: any) {
  const me = net.state.youId;
  switch (e.type) {
    case 'hit': {
      const strength = e.s ?? 0.5;
      audio.sfx('hit', strength);
      if (strength > 0.55) {
        scene.shake(0.35 + strength * 0.5);
        scene.hitStop(70);
      }
      if (e.id === me || e.by === me) audio.vibrate(Math.round(12 + strength * 26));
      break;
    }
    case 'ko':
      audio.sfx('ko');
      scene.shake(0.9, 0.3);
      audio.vibrate([40, 30, 60]);
      break;
    case 'fall':
      audio.sfx('collapse');
      break;
    case 'dash':
      if (e.id !== me) audio.sfx('dash', 0.4);
      break;
    case 'item':
      audio.sfx('pick');
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ الحلقات
// المدخلات 20 مرة/ثانية (كل 50ms)
setInterval(() => {
  if (net.state.phase !== 'ARENA') {
    controls.reset();
    return;
  }
  controls.poll();
  net.sendInput(controls.x, controls.z, controls.consumeDash(), controls.consumeItem());
}, 1000 / config.net.inputHz);

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!document.getElementById('gl')) return;
  scene.update(net, dt);
  ui.frame(dt);
}
requestAnimationFrame(frame);

// إبقاء الشاشة مضاءة على الجوال حين يمكن
(navigator as any).wakeLock?.request?.('screen').catch?.(() => {});
