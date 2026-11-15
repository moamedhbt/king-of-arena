/**
 * نقطة الدخول: خدمة واحدة تقدّم الملفات الثابتة و WebSocket فوق HTTPS.
 * الخادم هو الحكم الوحيد — لا يُصدَّق أي رقم من العميل.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import { config } from '../../shared/src/index';
import { Room, sanitizeName } from './room';
import { telemetryPath } from './telemetry';

const PORT = Number(process.env.PORT ?? 3000);

// تسريع المراحل — للاختبار الآلي فقط (PHASE_SCALE=0.12)
const PHASE_SCALE = Number(process.env.PHASE_SCALE ?? 1);
if (Number.isFinite(PHASE_SCALE) && PHASE_SCALE > 0 && PHASE_SCALE !== 1) {
  for (const k of Object.keys(config.phase)) {
    const v = (config.phase as any)[k];
    if (typeof v === 'number') (config.phase as any)[k] = Math.max(0.15, v * PHASE_SCALE);
  }
  console.log(`[dev] تسريع المراحل ×${PHASE_SCALE}`);
}
const CLIENT_DIR = process.env.CLIENT_DIR ?? resolve(__dirname, '../../client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (url === '/health' || url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalPlayers(), uptime: process.uptime() }));
    return;
  }
  if (url === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(config));
    return;
  }
  serveStatic(url, res);
});

function serveStatic(url: string, res: ServerResponse) {
  let filePath = normalize(join(CLIENT_DIR, url));
  if (!filePath.startsWith(normalize(CLIENT_DIR))) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = join(CLIENT_DIR, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('لم يُبنَ العميل بعد. شغّل: npm run build');
      return;
    }
  }
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(filePath).pipe(res);
}

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e5,
  transports: ['polling', 'websocket'],
});

const rooms = new Map<string, Room>();
const socketIndex = new Map<string, { roomCode: string; playerId: string }>();

function totalPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  const bytes = randomBytes(config.room.codeLen);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const newId = () => randomBytes(8).toString('hex');
const newToken = () => randomBytes(24).toString('hex');

function sendTo(socketId: string, event: string, data: any) {
  io.to(socketId).emit(event, data);
}

function applyRtt(player: { rttMs: number }, raw: unknown) {
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0 && v < 5000) {
    // متوسط متحرك لتقليل الضجيج
    player.rttMs = player.rttMs ? player.rttMs * 0.7 + v * 0.3 : v;
  }
}

io.on('connection', (socket) => {
  // دلو رموز: سعة = rate + اندفاع، ويُعاد تعبئته بالمعدل المسموح كل ثانية.
  // تجاوز السعة يُسقِط الرسالة فقط (المدخلات تُعوَّض في الرسالة التالية)
  // ولا يُقطع الاتصال إلا بعد إساءة مستمرة.
  const rate = config.net.rateLimitPerSec;
  const burst = (config.net as any).rateLimitBurst ?? rate;
  let budget = rate + burst;
  let windowCount = 0;
  let abuseSeconds = 0;
  const refill = setInterval(() => {
    // إساءة مستمرة = تجاوز الحد المسموح في 3 ثوانٍ متتالية
    abuseSeconds = windowCount > rate + burst ? abuseSeconds + 1 : 0;
    if (abuseSeconds >= 3) socket.disconnect(true);
    windowCount = 0;
    budget = Math.min(rate + burst, budget + rate);
  }, 1000);

  const guard = (): boolean => {
    windowCount++;
    budget--;
    return budget >= 0;
  };

  const bound = () => {
    const ref = socketIndex.get(socket.id);
    if (!ref) return null;
    const room = rooms.get(ref.roomCode);
    if (!room) return null;
    return { room, player: room.players.get(ref.playerId) };
  };

  socket.emit('hello', { serverTime: Date.now(), config: { ...config, puzzle: config.puzzle } });

  socket.on('ping', (m: any) => {
    if (!guard()) return;
    socket.emit('pong', { c: Number(m?.t) || 0, s: Date.now() });
  });

  socket.on('room:create', (m: any) => {
    if (!guard()) return;
    const name = sanitizeName(m?.name);
    let code = newCode();
    let tries = 0;
    while (rooms.has(code) && tries++ < 50) code = newCode();
    const room = new Room(code, randomBytes(4).readUInt32LE(0), sendTo, (msg) =>
      console.log(`[${code}] ${msg}`)
    );
    rooms.set(code, room);
    const id = newId();
    const token = newToken();
    const p = room.addPlayer(id, token, name, socket.id);
    if (!p) {
      socket.emit('err', { code: 'ROOM_FULL', message: 'تعذّر إنشاء الغرفة' });
      return;
    }
    socketIndex.set(socket.id, { roomCode: code, playerId: id });
    socket.join(code);
    socket.emit('joined', { code, playerId: id, token, state: room.roomState(id) });
    console.log(`[${code}] أُنشئت غرفة — ${name}`);
  });

  socket.on('room:join', (m: any) => {
    if (!guard()) return;
    const code = String(m?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const token = typeof m?.token === 'string' ? m.token.slice(0, 64) : '';
    const room = rooms.get(code);
    if (!room) {
      socket.emit('err', { code: 'NO_ROOM', message: 'لا توجد غرفة بهذا الكود' });
      return;
    }
    // استئناف بمفتاح
    if (token) {
      const p = room.reconnect(token, socket.id);
      if (p) {
        socketIndex.set(socket.id, { roomCode: code, playerId: p.id });
        socket.join(code);
        socket.emit('joined', { code, playerId: p.id, token, state: room.roomState(p.id) });
        return;
      }
    }
    const name = sanitizeName(m?.name);
    const id = newId();
    const newTok = newToken();
    const p = room.addPlayer(id, newTok, name, socket.id);
    if (!p) {
      socket.emit('err', {
        code: room.players.size >= config.room.maxPlayers ? 'ROOM_FULL' : 'ALREADY_STARTED',
        message: room.players.size >= config.room.maxPlayers ? 'الغرفة ممتلئة' : 'المباراة بدأت بالفعل',
      });
      return;
    }
    socketIndex.set(socket.id, { roomCode: code, playerId: id });
    socket.join(code);
    socket.emit('joined', { code, playerId: id, token: newTok, state: room.roomState(id) });
  });

  socket.on('room:settings', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    b.room.setRounds(b.player!.id, Number(m?.rounds));
  });

  socket.on('room:start', () => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    if (!b.room.start(b.player!.id)) {
      socket.emit('err', { code: 'CANNOT_START', message: 'تحتاج لاعبين اثنين على الأقل' });
    } else {
      console.log(`[${b.room.code}] بدأت المباراة (${b.room.rounds} جولات)`);
    }
  });

  socket.on('room:leave', () => {
    const b = bound();
    if (!b) return;
    b.room.removePlayer(b.player!.id);
    socketIndex.delete(socket.id);
    socket.leave(b.room.code);
    if (b.room.players.size === 0) {
      b.room.destroy();
      rooms.delete(b.room.code);
    }
  });

  socket.on('input', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    applyRtt(b.player!, m?.rtt);
    b.room.feedInput(b.player!.id, m ?? {});
  });

  socket.on('puzzle:answer', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    b.room.answer(b.player!.id, m?.payload);
  });

  socket.on('draft:pick', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    b.room.pick(b.player!.id, m?.item);
  });

  socket.on('predict', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    b.room.predict(b.player!.id, String(m?.playerId ?? ''));
  });

  // توافق خلفي: بعض العملاء القدامى يرسلون rtt منفصلة (تُهمَل الزائدة عن الحد)
  socket.on('rtt', (m: any) => {
    if (!guard()) return;
    const b = bound();
    if (!b) return;
    applyRtt(b.player!, m?.rtt);
  });

  socket.on('disconnect', () => {
    clearInterval(refill);
    const ref = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!ref) return;
    const room = rooms.get(ref.roomCode);
    if (!room) return;
    room.markDisconnected(ref.playerId);
    // مهلة إعادة الاتصال
    setTimeout(() => {
      const r = rooms.get(ref.roomCode);
      if (!r) return;
      const p = r.players.get(ref.playerId);
      if (p && !p.connected) {
        r.removePlayer(ref.playerId);
        if (r.players.size === 0) {
          r.destroy();
          rooms.delete(ref.roomCode);
        }
      }
    }, config.net.reconnectSec * 1000);
  });
});

// تنظيف الغرف الفارغة والمهجورة (كل اللاعبين منقطعون بعد مهلة إعادة الاتصال)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const list = Array.from(room.players.values());
    const empty = list.length === 0;
    const abandoned =
      list.length > 0 &&
      list.every(
        (p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > config.net.reconnectSec * 1000
      );
    if (empty || abandoned) {
      room.destroy();
      rooms.delete(code);
      console.log(`[${code}] أُغلقت الغرفة (${empty ? 'فارغة' : 'مهجورة'})`);
    }
  }
}, 15000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`ملك الحلبة — الخادم يعمل على http://0.0.0.0:${PORT}`);
  console.log(`الملفات الثابتة: ${CLIENT_DIR}`);
  console.log(`سجل الجولات: ${telemetryPath()}`);
});
