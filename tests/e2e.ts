/**
 * اختبار شامل عبر WebSocket حقيقي: 3 لاعبين يكملون مباراة كاملة.
 * يشغّل الخادم بنفسه مع تسريع المراحل (PHASE_SCALE) للتحقق من:
 * الترتيب الصحيح للمراحل، عدم وجود مرحلة عالقة، إعادة الاتصال، وسجل الجولات.
 */
import { io, type Socket } from 'socket.io-client';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 3311;
const SCALE = 0.12;
const DATA_DIR = resolve(process.cwd(), 'data', 'e2e');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error('  ✗', msg);
  } else console.log('  ✓', msg);
};

async function main() {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
  const server: ChildProcess = spawn('node', ['server/dist/index.cjs'], {
    env: { ...process.env, PORT: String(PORT), PHASE_SCALE: String(SCALE), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => console.log('[srv]', String(d).trim()));
  server.stderr!.on('data', (d) => console.error('[srv:err]', String(d).trim()));
  await sleep(1000);

  const phasesSeen: string[] = [];
  const results: any[] = [];
  let matchResult: any = null;
  const clients: Socket[] = [];

  interface Bot {
    socket: Socket;
    joined: Promise<any>;
    id: string;
    token: string;
  }

  const makeBot = (): Bot => {
    const s = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
    clients.push(s);
    const bot: Bot = { socket: s, joined: null as any, id: '', token: '' };
    bot.joined = new Promise((res) => {
      s.on('joined', (m: any) => {
        bot.id = m.playerId;
        bot.token = m.token;
        res(m);
      });
      setTimeout(() => res(null), 5000);
    });
    s.on('phase', (p: any) => {
      phasesSeen.push(p.name);
      if (p.name === 'PUZZLE') {
        const payload = p.data?.payload;
        setTimeout(() => {
          // إجابة (خاطئة غالبًا) لاختبار مسار القفل والتحقق من الخادم
          if (payload?.type === 'memory') s.emit('puzzle:answer', { payload: [0, 1, 2] });
          else s.emit('puzzle:answer', { payload: -999 });
        }, 80);
      }
      if (p.name === 'DRAFT') {
        const order = ['charge', 'shield', 'anchor', 'jump'];
        setTimeout(() => s.emit('draft:pick', { item: order[Math.floor(Math.random() * 4)] }), 60);
      }
      if (p.name === 'ARENA') {
        const iv = setInterval(() => {
          s.emit('input', {
            seq: 1,
            x: Math.random() * 2 - 1,
            z: Math.random() * 2 - 1,
            dash: Math.random() < 0.2,
            item: Math.random() < 0.05,
          });
        }, 50);
        s.once('phase', (q: any) => {
          if (q.name !== 'ARENA') clearInterval(iv);
        });
      }
    });
    s.on('round:result', (r: any) => results.push(r));
    s.on('match:result', (r: any) => (matchResult = r));
    s.on('err', (e: any) => console.error('  [err]', e.code));
    return bot;
  };

  console.log('— اختبار الشبكة الشامل —');
  const a = makeBot();
  a.socket.emit('room:create', { name: 'أحمد' });
  const aJoined = await a.joined;
  const code = aJoined?.code;
  check(!!code, `غرفة أُنشئت: ${code}`);

  const b = makeBot();
  b.socket.emit('room:join', { code, name: 'سارة' });
  await b.joined;
  const c = makeBot();
  c.socket.emit('room:join', { code, name: 'ياسين' });
  await c.joined;
  await sleep(300);
  check(!!(b.id && c.id), '3 لاعبين متصلون');

  a.socket.emit('room:settings', { rounds: 3 });
  await sleep(150);
  a.socket.emit('room:start');
  await sleep(400);

  // انقطاع وإعادة اتصال أثناء المباراة
  await sleep(2500);
  b.socket.disconnect();
  await sleep(500);
  const b2 = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  clients.push(b2);
  const resumedPromise = new Promise<any>((res) => {
    b2.on('joined', (m: any) => res(m));
    setTimeout(() => res(null), 5000);
  });
  b2.emit('room:join', { code, name: 'سارة', token: b.token });
  const resumed = await resumedPromise;
  await sleep(400);
  check(!!resumed && resumed.playerId === b.id, 'إعادة الاتصال بنفس المعرّف (token)');
  b2.on('phase', (p: any) => {
    if (p.name === 'ARENA') {
      const iv = setInterval(() => b2.emit('input', { x: 0.2, z: 0.2, dash: false, item: false }), 50);
      b2.once('phase', (q: any) => {
        if (q.name !== 'ARENA') clearInterval(iv);
      });
    }
  });

  // انتظار انتهاء المباراة
  const deadline = Date.now() + 100_000;
  while (!matchResult && Date.now() < deadline) await sleep(250);
  check(!!matchResult, 'وصلت نتيجة المباراة');
  const uniqueRounds = new Set(results.map((r) => r.round));
  check(uniqueRounds.size >= 3, `نتائج الجولات: ${uniqueRounds.size} جولة مختلفة`);
  check(phasesSeen.includes('COUNTDOWN'), 'مرحلة الاستعداد');
  check(phasesSeen.filter((p) => p === 'PUZZLE').length >= 3, 'ثلاث مراحل لغز');
  check(phasesSeen.includes('DRAFT'), 'مرحلة الاختيار');
  check(phasesSeen.includes('ARENA'), 'مرحلة الحلبة');
  check(phasesSeen.includes('MATCH_RESULT'), 'مرحلة النتيجة النهائية');

  if (matchResult) {
    const totals = matchResult.rows.map((r: any) => r.total);
    check(matchResult.rows.length === 3, 'ترتيب نهائي لثلاثة لاعبين');
    check(totals.every((t: number) => Number.isFinite(t)), 'مجاميع نقاط صالحة');
    check(matchResult.winners.length >= 1, `فائز: ${matchResult.winners.join(',')}`);
    const sorted = [...totals].sort((x, y) => y - x);
    check(JSON.stringify(totals) === JSON.stringify(sorted), 'الترتيب النهائي تنازلي');
  }

  // سجل الجولات
  await sleep(400);
  const logPath = resolve(DATA_DIR, 'rounds.jsonl');
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    check(lines.length >= 3, `سجل الجولات JSONL: ${lines.length} سطر`);
    const first = JSON.parse(lines[0]);
    const keys = ['puzzleType', 'difficulty', 'players', 'arenaDurationSec', 'fallOrder', 'rows'];
    check(keys.every((k) => k in first), 'حقول السجل مكتملة');
    const row = first.rows[0];
    check(
      ['id', 'correct', 'effectiveMs', 'item', 'rank', 'kos', 'points'].every((k) => k in row),
      'حقول اللاعب في السجل'
    );
  } else {
    check(false, 'ملف السجل غير موجود');
  }

  await sleep(2600);
  check(phasesSeen.includes('LOBBY'), 'العودة إلى اللوبي بعد المباراة');

  clients.forEach((s) => s.disconnect());
  server.kill('SIGTERM');
  await sleep(300);

  if (failures) {
    console.error(`\nفشل الاختبار الشامل: ${failures}`);
    process.exit(1);
  }
  console.log('\n✓ نجح الاختبار الشامل');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
