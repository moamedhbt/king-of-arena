import * as THREE from 'three';
import { config, TILES, TILE_COUNT, PLAYER_COLORS } from '@shared/index';
import type { Snap, SnapPlayer } from '@shared/index';
import type { Net } from './net';

interface PlayerView {
  group: THREE.Group;
  body: THREE.Mesh;
  eyes: THREE.Group;
  label: THREE.Sprite;
  ring: THREE.Mesh;
  shadow: THREE.Mesh; // ظل ثابت على البلاطة
  aura: THREE.Mesh; // هالة الضربة
  bubble: THREE.Mesh; // فقاعة الدرع
  anchorRing: THREE.Mesh; // حلقة المرساة
  anchorLock: THREE.Sprite; // رمز قفل المرساة
  trailAcc: number;
  airborne: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  hasPos: boolean;
  color: string;
}

const TILE_TOP = 0; // سطح البلاطة
const FALL_DUR = 1.1;

export class ArenaScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private tileMesh!: THREE.InstancedMesh;
  private tileStates = new Array<number>(TILE_COUNT).fill(0);
  private warnAt = new Array<number>(TILE_COUNT).fill(-1);
  private fallAt = new Array<number>(TILE_COUNT).fill(-1);
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private players = new Map<string, PlayerView>();
  private dust!: THREE.Points;
  private dustVel: Float32Array = new Float32Array(0);
  private dustLife: Float32Array = new Float32Array(0);
  private dustPos: Float32Array = new Float32Array(0);
  private shakeUntil = 0;
  private shakeMag = 0;
  private hitStopUntil = 0;
  private renderTime = 0;
  private flashUntil = 0;
  private containers = new THREE.Group();
  private clock = new THREE.Clock();
  // تخفيض تلقائي للدقة إن تأخر الإطار (هدف 60 إطارًا على الهواتف المتوسطة)
  private frameAcc = 0;
  private frameCount = 0;
  private qualitySteps = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor(0x0a1226, 1);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(0x0a1730, 70, 165);
    this.scene.add(this.containers);

    this.buildLights();
    this.buildArena();
    this.buildDust();
    this.buildSparks();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private buildLights() {
    const hemi = new THREE.HemisphereLight(0xbfe9ff, 0x0a2030, 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(12, 30, 10);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0x16d3c4, 0.5);
    rim.position.set(-14, 12, -18);
    this.scene.add(rim);
  }

  private buildArena() {
    const geo = new THREE.BoxGeometry(config.arena.tileSize, config.arena.tileThickness, config.arena.tileSize);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.tileMesh = new THREE.InstancedMesh(geo, mat, TILE_COUNT);
    this.tileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tileMesh.frustumCulled = false;

    for (let i = 0; i < TILE_COUNT; i++) {
      const t = TILES[i];
      const dark = (t.gx + t.gz) % 2 === 0;
      this.color.setHex(dark ? 0x35618f : 0x2b527d);
      this.tileMesh.setColorAt(i, this.color);
      this.dummy.position.set(t.x, -config.arena.tileThickness / 2, t.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.tileMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.tileMesh.instanceMatrix.needsUpdate = true;
    if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;
    this.containers.add(this.tileMesh);

    // شبكة ضوء أسفل البلاطات: الفراغات بين البلاطات تتوهّج => يظهر شكل الثمانية
    const gridGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(
        (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2 + 0.2,
        (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2 + 0.2,
        0.08,
        8
      ),
      new THREE.MeshBasicMaterial({ color: 0x36e6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending })
    );
    gridGlow.rotation.y = Math.PI / 8;
    gridGlow.position.y = -0.16;
    this.containers.add(gridGlow);

    // ---------------- منصة ثمانية الأضلاع ----------------
    const extent = (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2;
    const slabR = extent + 1.6;

    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(slabR, slabR * 0.94, 1.6, 8),
      new THREE.MeshLambertMaterial({ color: 0x0d1526 })
    );
    slab.rotation.y = Math.PI / 8;
    slab.position.y = -config.arena.tileThickness / 2 - 0.85;
    this.containers.add(slab);

    // حافة نيون على المنصة
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(slabR - 0.25, slabR + 0.12, 8, 1),
      new THREE.MeshBasicMaterial({
        color: 0x2de1ff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.rotation.z = Math.PI / 8;
    edge.position.y = 0.02;
    this.containers.add(edge);

    // بركة ضوء تحت الحلبة (توهج نيون)
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(slabR * 1.5, 48),
      new THREE.MeshBasicMaterial({
        color: 0x1b6fa8,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -2.2;
    this.containers.add(glow);
  }

  private sparkPos: Float32Array = new Float32Array(0);
  private sparkVel: Float32Array = new Float32Array(0);
  private sparkLife: Float32Array = new Float32Array(0);
  private sparks!: THREE.Points;

  /** شرر أصفر: أثر الضربة المشحونة، انفجار الإصابة، وأثر التفعيل */
  private buildSparks() {
    const N = 260;
    this.sparkPos = new Float32Array(N * 3).fill(-999);
    this.sparkVel = new Float32Array(N * 3);
    this.sparkLife = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffd23f,
      size: 0.5,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparks = new THREE.Points(geo, mat);
    this.sparks.frustumCulled = false;
    this.containers.add(this.sparks);
  }

  private emitSparks(x: number, y: number, z: number, n: number, speed: number, up = 1) {
    let spawned = 0;
    for (let i = 0; i < this.sparkLife.length && spawned < n; i++) {
      if (this.sparkLife[i] > 0) continue;
      this.sparkLife[i] = 0.35 + Math.random() * 0.45;
      this.sparkPos[i * 3] = x + (Math.random() - 0.5) * 0.9;
      this.sparkPos[i * 3 + 1] = y + Math.random() * 0.6;
      this.sparkPos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.9;
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.sparkVel[i * 3] = Math.cos(a) * sp;
      this.sparkVel[i * 3 + 1] = (0.5 + Math.random()) * up * 4;
      this.sparkVel[i * 3 + 2] = Math.sin(a) * sp;
      spawned++;
    }
  }

  private updateSparks(dt: number) {
    const pos = this.sparkPos;
    for (let i = 0; i < this.sparkLife.length; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      if (this.sparkLife[i] <= 0) {
        pos[i * 3 + 1] = -999;
        continue;
      }
      pos[i * 3] += this.sparkVel[i * 3] * dt;
      pos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
      this.sparkVel[i * 3 + 1] -= 14 * dt;
    }
    (this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** انفجار أثر عند الإصابة أو التفعيل */
  burst(x: number, z: number, n = 16) {
    this.emitSparks(x, 0.9, z, n, 6);
  }

  private buildDust() {
    const N = 220;
    this.dustPos = new Float32Array(N * 3).fill(-999);
    this.dustVel = new Float32Array(N * 3);
    this.dustLife = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xbfe9e0,
      size: 0.6,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.containers.add(this.dust);
  }

  private spawnDust(x: number, z: number, n = 8) {
    let spawned = 0;
    for (let i = 0; i < this.dustLife.length && spawned < n; i++) {
      if (this.dustLife[i] > 0) continue;
      this.dustLife[i] = 0.6 + Math.random() * 0.5;
      this.dustPos[i * 3] = x + (Math.random() - 0.5) * 3;
      this.dustPos[i * 3 + 1] = 0.2;
      this.dustPos[i * 3 + 2] = z + (Math.random() - 0.5) * 3;
      this.dustVel[i * 3] = (Math.random() - 0.5) * 3;
      this.dustVel[i * 3 + 1] = -1 - Math.random() * 3;
      this.dustVel[i * 3 + 2] = (Math.random() - 0.5) * 3;
      spawned++;
    }
  }

  /** موضع الكاميرا الأساسي: زاوية الوثيقة (0,34,26) أو (0,50,38) مع توسيعها حتى تظهر الحلبة كاملة */
  private basePos = new THREE.Vector3(0, 34, 26);

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const portrait = h > w;
    const vFov = (55 * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    // نصف عرض الحلبة + الفجوة + هامش أمان
    const halfW = (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2 + 1.2;
    const needed = (halfW * 1.06) / Math.tan(hFov / 2);
    const dir = new THREE.Vector3(0, portrait ? 50 : 34, portrait ? 38 : 26).normalize();
    const len = Math.max(portrait ? 62.8 : 42.8, needed);
    this.basePos.copy(dir).multiplyScalar(len);
    this.camera.position.copy(this.basePos);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  private ensurePlayer(id: string, color: string, name: string): PlayerView {
    let v = this.players.get(id);
    if (v) {
      if (v.color !== color) this.recolor(v, color);
      return v;
    }
    const group = new THREE.Group();
    const r = config.physics.radius;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 14),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(color) })
    );
    body.position.y = r;
    group.add(body);

    // عيون تتجه نحو الحركة
    const eyes = new THREE.Group();
    const eyeGeo = new THREE.SphereGeometry(r * 0.2, 10, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const pupilGeo = new THREE.SphereGeometry(r * 0.1, 8, 6);
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x101820 });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * r * 0.33, r * 1.28, r * 0.72);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(0, 0, r * 0.16);
      eye.add(pupil);
      eyes.add(eye);
    }
    eyes.position.y = 0;
    group.add(eyes);

    // حلقة تمييز
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.05, r * 1.3, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);

    const label = makeLabel(name, color);
    label.position.y = r * 2.6;
    group.add(label);

    // ظل يبقى على البلاطة (لا يرتفع مع القفز)
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.95, 20),
      new THREE.MeshBasicMaterial({ color: 0x03080f, transparent: true, opacity: 0.32, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    group.add(shadow);

    // هالة الضربة (صفراء مضيئة)
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.32, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd23f,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    aura.position.y = r;
    aura.visible = false;
    group.add(aura);

    // فقاعة الدرع (زرقاء شفافة)
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.55, 18, 14),
      new THREE.MeshBasicMaterial({
        color: 0x59c8ff,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    bubble.position.y = r;
    bubble.visible = false;
    group.add(bubble);

    // حلقة المرساة على البلاطة
    const anchorRing = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.45, r * 1.95, 28),
      new THREE.MeshBasicMaterial({ color: 0x8bf07a, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    anchorRing.rotation.x = -Math.PI / 2;
    anchorRing.visible = false;
    group.add(anchorRing);

    const anchorLock = makeLockSprite();
    anchorLock.visible = false;
    group.add(anchorLock);

    this.containers.add(group);
    const view: PlayerView = {
      group,
      body,
      eyes,
      label,
      ring,
      shadow,
      aura,
      bubble,
      anchorRing,
      anchorLock,
      trailAcc: 0,
      airborne: false,
      lastX: 0,
      lastY: 0,
      lastZ: 0,
      hasPos: false,
      color,
    };
    this.players.set(id, view);
    return view;
  }

  private recolor(v: PlayerView, color: string) {
    (v.body.material as THREE.MeshLambertMaterial).color.set(color);
    (v.ring.material as THREE.MeshBasicMaterial).color.set(color);
    v.color = color;
  }

  shake(mag = 0.6, sec = config.ui.shakeSec) {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeUntil = performance.now() + sec * 1000;
  }

  hitStop(ms = config.ui.hitStopMs) {
    this.hitStopUntil = performance.now() + ms;
  }

  flashScreen() {
    this.flashUntil = performance.now() + 180;
  }

  /** يُستدعى كل إطار */
  update(net: Net, dt: number) {
    const now = performance.now();
    const serverNow = net.serverNow() - config.net.interpDelayMs;

    if (now < this.hitStopUntil) {
      // إبطاء لحظي: لا نُقدّم الزمن
    } else {
      this.renderTime = serverNow;
    }

    const interp = this.interpolate(net.snaps, this.renderTime);
    this.syncPlayers(net, interp, dt);
    this.syncTiles(net.snaps, now);
    this.updateDust(dt);
    this.updateSparks(dt);
    this.applyShake(now);

    this.renderer.render(this.scene, this.camera);
    this.adaptQuality(dt);
  }

  private adaptQuality(dt: number) {
    this.frameAcc += dt;
    this.frameCount++;
    if (this.frameCount < 90) return;
    const avg = this.frameAcc / this.frameCount;
    this.frameAcc = 0;
    this.frameCount = 0;
    if (avg > 0.022 && this.qualitySteps < 2) {
      this.qualitySteps++;
      const next = Math.max(1, (this.renderer.getPixelRatio() || 1) * 0.75);
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  private interpolate(snaps: Snap[], t: number): Map<string, { x: number; y: number; z: number; a: number; fx: number; fz: number }> {
    const out = new Map<string, { x: number; y: number; z: number; a: number; fx: number; fz: number }>();
    if (!snaps.length) return out;
    let a: Snap | null = null;
    let b: Snap | null = null;
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t <= t && snaps[i + 1].t >= t) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
    }
    if (!a) {
      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      if (t < first.t) {
        a = first;
        b = snaps[1] ?? first;
      } else {
        a = last;
        b = last;
      }
    }
    const alpha = a === b || !b || b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    const mapB = new Map<string, SnapPlayer>();
    for (const p of b!.players) mapB.set(p.id, p);
    for (const p of a!.players) {
      const q = mapB.get(p.id) ?? p;
      out.set(p.id, {
        x: p.x + (q.x - p.x) * alpha,
        y: p.y + (q.y - p.y) * alpha,
        z: p.z + (q.z - p.z) * alpha,
        a: q.a,
        fx: q.fx ?? p.fx,
        fz: q.fz ?? p.fz,
      });
    }
    return out;
  }

  private syncPlayers(
    net: Net,
    interp: Map<string, { x: number; y: number; z: number; a: number; fx: number; fz: number }>,
    dt: number
  ) {
    const seen = new Set<string>();
    const meta = new Map(net.state.players.map((p) => [p.id, p]));
    const latest = net.snaps.length ? net.snaps[net.snaps.length - 1] : null;
    const states = new Map<string, SnapPlayer>();
    for (const sp of latest?.players ?? []) states.set(sp.id, sp);
    let idx = 0;
    for (const [id, pos] of interp) {
      seen.add(id);
      const m = meta.get(id);
      const color = m?.color ?? PLAYER_COLORS[idx % PLAYER_COLORS.length];
      const view = this.ensurePlayer(id, color, m?.name ?? '');
      const target = view.group.position;
      if (!view.hasPos) {
        target.set(pos.x, pos.y, pos.z);
        view.hasPos = true;
      } else {
        // تنعيم إضافي لامتصاص تقطّع اللقطات
        const k = 1 - Math.exp(-18 * dt);
        target.x += (pos.x - target.x) * k;
        target.y += (pos.y - target.y) * k;
        target.z += (pos.z - target.z) * k;
      }
      if (pos.a === 0) {
        // سقوط اللاعب
        view.group.position.y -= dt * 26;
        view.body.scale.setScalar(Math.max(0.01, view.body.scale.x - dt * 0.5));
        view.ring.visible = false;
        view.eyes.visible = false;
      } else {
        view.ring.visible = true;
        view.eyes.visible = true;
        view.body.scale.setScalar(1);
        // العيون نحو الحركة
        const ang = Math.atan2(pos.fx || 0, pos.fz || 1);
        view.eyes.rotation.y += (ang - view.eyes.rotation.y) * Math.min(1, dt * 12);
        const bob = Math.sin(performance.now() * 0.004 + idx) * 0.05;
        view.body.position.y = config.physics.radius + bob;
      }
      const me = net.state.youId === id;
      (view.ring.material as THREE.MeshBasicMaterial).opacity = me ? 0.85 : 0.35;

      // ---------------- أدوات ----------------
      const st = states.get(id);
      const ia = st?.ia ?? null;
      const at = st?.at ?? -1;
      const alive = pos.a !== 0;
      const height = Math.max(0, target.y);

      // الظل: يبقى على مستوى البلاطة ويضعف مع الارتفاع
      view.shadow.visible = alive;
      view.shadow.position.y = 0.025 - height;
      view.shadow.scale.setScalar(Math.max(0.5, 1 + height * 0.13));
      (view.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.06, 0.32 - height * 0.05);

      // هالة الضربة + أثر خلف الكرة
      const auraOn = alive && ia === 'charge';
      view.aura.visible = auraOn;
      if (auraOn) {
        view.aura.scale.setScalar(1 + Math.sin(performance.now() * 0.009) * 0.07);
        view.trailAcc += dt;
        if (view.trailAcc > 0.045) {
          view.trailAcc = 0;
          this.emitSparks(target.x, height + config.physics.radius * 0.7, target.z, 2, 1.8, 0.25);
        }
      } else {
        view.trailAcc = 0;
      }

      // فقاعة الدرع
      view.bubble.visible = alive && ia === 'shield';
      if (view.bubble.visible) {
        view.bubble.scale.setScalar(1 + Math.sin(performance.now() * 0.006) * 0.05);
      }

      // مرساة: حلقة وقفل على البلاطة + علامة تحت الكرة
      const anchored = alive && at >= 0;
      view.anchorRing.visible = anchored;
      view.anchorLock.visible = anchored;
      if (anchored) {
        view.anchorRing.position.y = 0.03 - height;
        view.anchorRing.scale.setScalar(1 + Math.sin(performance.now() * 0.005) * 0.06);
        view.anchorLock.position.y = config.physics.radius * 2.75;
      }

      // غبار عند الهبوط
      const air = height > 0.35;
      if (alive && view.airborne && !air) {
        this.spawnDust(target.x, target.z, 7);
        this.emitSparks(target.x, 0.25, target.z, 5, 2.2, 0.5);
      }
      view.airborne = air;
      idx++;
    }
    for (const [id, v] of this.players) {
      if (!seen.has(id)) {
        v.group.position.y -= dt * 26;
        if (v.group.position.y < -30) v.group.visible = false;
      } else {
        v.group.visible = true;
      }
    }
  }

  /** حالة كل بلاطة كما رُسمت آخر مرة، لتفادي إعادة بناء المصفوفات كل إطار */
  private renderedState = new Array<number>(TILE_COUNT).fill(-1);

  private syncTiles(snaps: Snap[], now: number) {
    if (!snaps.length) return;
    const latest = snaps[snaps.length - 1];
    const str = latest.tiles;
    let matricesDirty = false;

    for (let i = 0; i < TILE_COUNT && i < str.length; i++) {
      const st = Number(str[i]);
      const prev = this.tileStates[i];
      if (st !== prev) {
        if (st === 1 && this.warnAt[i] < 0) this.warnAt[i] = now;
        if (st === 2 && this.fallAt[i] < 0) {
          this.fallAt[i] = now;
          this.spawnDust(TILES[i].x, TILES[i].z, 6);
        }
        if (st === 0) {
          this.warnAt[i] = -1;
          this.fallAt[i] = -1;
          this.renderedState[i] = -1;
        }
        this.tileStates[i] = st;
      }
    }

    for (let i = 0; i < TILE_COUNT; i++) {
      const st = this.tileStates[i];
      const animating = st === 1 || (st === 2 && this.fallAt[i] > 0);
      // البلاطة الثابتة تُرسم مرة واحدة فقط
      if (!animating && this.renderedState[i] === st) continue;
      const t = TILES[i];
      let y = -config.arena.tileThickness / 2;
      let rot = 0;
      let scale = 1;

      if (st === 2) {
        const p = (now - this.fallAt[i]) / (FALL_DUR * 1000);
        if (p > 1.2) {
          if (this.renderedState[i] !== -2) {
            this.dummy.position.set(t.x, -999, t.z);
            this.dummy.rotation.set(0, 0, 0);
            this.dummy.scale.set(0.001, 0.001, 0.001);
            this.dummy.updateMatrix();
            this.tileMesh.setMatrixAt(i, this.dummy.matrix);
            this.renderedState[i] = -2;
            matricesDirty = true;
          }
          continue;
        }
        y = -config.arena.tileThickness / 2 - p * p * 26;
        rot = p * 1.2;
        scale = Math.max(0.001, 1 - p * 0.35);
      } else if (st === 1) {
        const p = Math.min(1, (now - this.warnAt[i]) / (config.collapse.warnTime * 1000));
        const blink = 0.5 + 0.5 * Math.sin(now * 0.03);
        // أصفر (255,210,63) -> أحمر (255,59,48) مع نبض
        const g = (210 + (59 - 210) * p) / 255;
        const bl = (63 + (48 - 63) * p) / 255;
        this.color.setRGB(0.75 + 0.25 * blink, g * (0.7 + 0.3 * blink), bl * (0.7 + 0.3 * blink));
        this.tileMesh.setColorAt(i, this.color);
        if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;
        const amp = 0.02 + p * 0.06;
        this.dummy.position.set(t.x + (Math.random() - 0.5) * amp, y, t.z + (Math.random() - 0.5) * amp);
        this.dummy.rotation.set((Math.random() - 0.5) * amp, 0, (Math.random() - 0.5) * amp);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.tileMesh.setMatrixAt(i, this.dummy.matrix);
        this.renderedState[i] = st;
        matricesDirty = true;
        continue;
      }

      this.dummy.position.set(t.x, y, t.z);
      this.dummy.rotation.set(rot, 0, rot * 0.6);
      this.dummy.scale.set(scale, scale, scale);
      this.dummy.updateMatrix();
      this.tileMesh.setMatrixAt(i, this.dummy.matrix);
      this.renderedState[i] = st;
      matricesDirty = true;

      if (st === 0) {
        const dark = (t.gx + t.gz) % 2 === 0;
        this.color.setHex(dark ? 0x35618f : 0x2b527d);
        this.tileMesh.setColorAt(i, this.color);
        if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;
      }
    }
    if (matricesDirty) this.tileMesh.instanceMatrix.needsUpdate = true;
  }

  private updateDust(dt: number) {
    const pos = this.dustPos;
    for (let i = 0; i < this.dustLife.length; i++) {
      if (this.dustLife[i] <= 0) continue;
      this.dustLife[i] -= dt;
      if (this.dustLife[i] <= 0) {
        pos[i * 3 + 1] = -999;
        continue;
      }
      pos[i * 3] += this.dustVel[i * 3] * dt;
      pos[i * 3 + 1] += this.dustVel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.dustVel[i * 3 + 2] * dt;
      this.dustVel[i * 3 + 1] -= 9 * dt;
    }
    (this.dust.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private applyShake(now: number) {
    const base = this.camera.position;
    const bx = this.basePos.x;
    const by = this.basePos.y;
    const bz = this.basePos.z;
    if (now < this.shakeUntil) {
      const k = this.shakeMag;
      base.set(bx + (Math.random() - 0.5) * k, by + (Math.random() - 0.5) * k, bz + (Math.random() - 0.5) * k * 0.5);
    } else {
      base.set(bx, by, bz);
      this.shakeMag = 0;
    }
    this.camera.lookAt(0, 0, 0);
  }

  resetArena() {
    this.tileStates.fill(0);
    this.warnAt.fill(-1);
    this.fallAt.fill(-1);
    this.renderedState.fill(-1);
    this.players.forEach((p) => p.group.visible = true);
  }
}

/** سماء متدرّجة مولّدة بالكامل (بلا صور خارجية) */
function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#05070f');
  g.addColorStop(0.45, '#0a1730');
  g.addColorStop(0.75, '#123055');
  g.addColorStop(1, '#0a1730');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** رمز قفل صغير يُرسم كصورة نقطية فوق الكرة المثبّتة */
function makeLockSprite(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#8bf07a';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  // قوس القفل
  ctx.beginPath();
  ctx.arc(48, 40, 17, Math.PI, 0);
  ctx.stroke();
  // جسم القفل
  ctx.fillStyle = '#8bf07a';
  ctx.beginPath();
  ctx.roundRect(23, 40, 50, 38, 8);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(1.5, 1.5, 1);
  return sprite;
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(4, 12, 24, 0.75)';
  const w = Math.min(248, ctx.measureText(text).width + 26);
  ctx.beginPath();
  ctx.roundRect((256 - w) / 2, 12, w, 40, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.6, 1.15, 1);
  return sprite;
}
