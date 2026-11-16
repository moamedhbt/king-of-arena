import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { config, TILES, TILE_COUNT, PLAYER_COLORS } from '@shared/index';
import type { Snap, SnapPlayer } from '@shared/index';
import type { Net } from './net';
import { Character, createCharacter, preloadCharacter } from './character';

interface PlayerView {
  group: THREE.Group;
  body: THREE.Mesh; // عنصر نائب خفي بعد تحميل الشخصية
  eyes: THREE.Group;
  character: Character | null;
  loading: boolean;
  stunnedUntil: number;
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
  private clouds = new THREE.Group();
  // حقل الملوك: أرقام مشتركة + حفر + مناطق سيطرة
  private numberSprites: THREE.Sprite[] = [];
  private digitMats: Map<number, THREE.MeshBasicMaterial> = new Map();
  /** لون البلاطة المكشوفة حسب عدد الألغام المجاورة (0 = لم تُكشف) */
  private revealedTint = new Array<number>(TILE_COUNT).fill(0);
  private craters: THREE.Mesh[] = [];
  private zonePads: THREE.Mesh[] = [];
  private digitTex = new Map<number, THREE.Texture>();
  private digitsDrawn = -1;
  private craterDrawn = -1;
  private braziers: THREE.Mesh[] = [];
  private torchLight: THREE.PointLight | null = null;
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
  private pickupMeshes: THREE.Mesh[] = [];
  private static ITEM_COLORS: Record<string, number> = {
    charge: 0xffd23f,
    shield: 0x59c8ff,
    anchor: 0x8bf07a,
    jump: 0xb6f06a,
  };
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(0x3a2038, 60, 170);
    this.scene.add(this.containers);

    this.buildLights();
    this.buildArena();
    this.buildScenery();
    this.buildDust();
    this.buildSparks();
    this.buildPickups();
    this.buildField();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private buildLights() {
    // إضاءة سماء/أرض ناعمة
    const hemi = new THREE.HemisphereLight(0xa8d8ff, 0x3a2418, 0.42);
    this.scene.add(hemi);

    // ضوء رئيسي دافئ (غروب) مع ظلال ناعمة
    const key = new THREE.DirectionalLight(0xffe4bb, 3.1);
    key.position.set(26, 20, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const d = 28;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 90;
    key.shadow.bias = -0.0007;
    key.shadow.normalBias = 0.035;
    key.shadow.radius = 2.2;
    key.shadow.camera.updateProjectionMatrix();
    this.scene.add(key);
    this.scene.add(key.target);

    // ضوء حافة بارد من الخلف
    const rim = new THREE.DirectionalLight(0x6ab6ff, 0.8);
    rim.position.set(-18, 12, -16);
    this.scene.add(rim);

    // إضاءة أرضية بنفسجية خفيفة تعطي عمقًا
    const fill = new THREE.PointLight(0x7a5cff, 16, 60, 2);
    fill.position.set(0, -6, 0);
    this.scene.add(fill);
  }

  private buildArena() {
    const geo = new RoundedBoxGeometry(
      config.arena.tileSize,
      config.arena.tileThickness,
      config.arena.tileSize,
      2,
      0.16
    );
    const stone = makeStone();
    const mat = new THREE.MeshStandardMaterial({
      map: stone.map,
      roughness: 0.78,
      metalness: 0.05,
      color: 0xffffff,
    });
    this.tileMesh = new THREE.InstancedMesh(geo, mat, TILE_COUNT);
    this.tileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tileMesh.frustumCulled = false;
    this.tileMesh.receiveShadow = true;
    this.tileMesh.castShadow = true;

    for (let i = 0; i < TILE_COUNT; i++) {
      const t = TILES[i];
      const dark = (t.gx + t.gz) % 2 === 0;
      const v = 0.9 + ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.2;
      this.color.setHex(dark ? 0xf2ece0 : 0xdfd7c8).multiplyScalar(v);
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
      new THREE.MeshBasicMaterial({ color: 0xff8f4a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending })
    );
    gridGlow.rotation.y = Math.PI / 8;
    gridGlow.position.y = -0.16;
    this.containers.add(gridGlow);

    // ---------------- منصة ثمانية الأضلاع ----------------
    const extent = (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2;
    const slabR = extent + 1.6;

    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(slabR, slabR * 0.94, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x323a4d, roughness: 0.92, metalness: 0.06 })
    );
    slab.rotation.y = Math.PI / 8;
    slab.position.y = -config.arena.tileThickness / 2 - 0.85;
    this.containers.add(slab);

    // حافة نيون على المنصة
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(slabR - 0.25, slabR + 0.12, 8, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffb168,
        transparent: true,
        opacity: 0.7,
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
        color: 0xff7a3c,
        transparent: true,
        opacity: 0.13,
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

  /** بيكابات الأدوات: جواهر متوهحة تدور وتطفو */
  /** جزر السحب أسفل الحلبة + أعمدة حجرية ومشاعل حولها */
  private buildScenery() {
    const cloud = makeCloud();
    const cloudMat = new THREE.MeshBasicMaterial({
      map: cloud,
      transparent: true,
      opacity: 0.45,
      color: 0xffd8bd,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const layers = [
      { y: -14, r: 52, size: 110, op: 0.34 },
      { y: -22, r: 80, size: 150, op: 0.4 },
      { y: -32, r: 120, size: 210, op: 0.46 },
    ];
    for (const L of layers) {
      const g = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(L.size, L.size * 0.7), cloudMat.clone());
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = L.op * (0.55 + Math.random() * 0.45);
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = Math.random() * Math.PI;
        const a = (i / 5) * Math.PI * 2;
        m.position.set(Math.cos(a) * L.r * 0.5, L.y + (Math.random() - 0.5) * 3, Math.sin(a) * L.r * 0.5);
        g.add(m);
      }
      this.clouds.add(g);
    }
    this.containers.add(this.clouds);

    // أعمدة ومشاعل حول الحلبة
    const extent = (config.arena.gridSize * (config.arena.tileSize + config.arena.tileGap)) / 2;
    const R = extent + 3.2;
    const colMat = new THREE.MeshStandardMaterial({ color: 0xcbbfae, roughness: 0.9, metalness: 0.02 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xa89a88, roughness: 0.85 });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb057, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 6.2, 12), colMat);
      col.position.set(x, -0.4, z);
      col.castShadow = true;
      col.receiveShadow = true;
      this.containers.add(col);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 1.7), capMat);
      cap.position.set(x, 2.95, z);
      cap.castShadow = true;
      this.containers.add(cap);
      const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.32, 0.55, 10), capMat);
      brazier.position.set(x, 3.45, z);
      this.containers.add(brazier);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.5, 8), flameMat);
      flame.position.set(x, 4.35, z);
      this.braziers.push(flame);
      this.containers.add(flame);
    }
    // شمس الغروب: هالة متوهجة في الأفق
    const sunC = document.createElement('canvas');
    sunC.width = sunC.height = 128;
    const sg = sunC.getContext('2d')!;
    const sgGrad = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
    sgGrad.addColorStop(0, 'rgba(255,236,190,0.95)');
    sgGrad.addColorStop(0.25, 'rgba(255,180,110,0.55)');
    sgGrad.addColorStop(1, 'rgba(255,120,60,0)');
    sg.fillStyle = sgGrad;
    sg.fillRect(0, 0, 128, 128);
    const sunTex = new THREE.CanvasTexture(sunC);
    sunTex.colorSpace = THREE.SRGBColorSpace;
    const sun = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: sunTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 })
    );
    sun.scale.set(60, 60, 1);
    sun.position.set(-46, 26, -78);
    this.containers.add(sun);

    // جمر خفيف من الأسفل فقط (لا يغسل الإضاءة)
    const torch = new THREE.PointLight(0xff9a45, 7, 26, 2);
    torch.position.set(0, -2.4, 0);
    this.containers.add(torch);
    this.torchLight = torch;
  }

  /** أرقام الألغام (كريم على أسود) + حفر الانفجار + حلقات مناطق السيطرة */
  private buildField() {
    const planeGeo = new THREE.PlaneGeometry(2.9, 2.9);
    this.digitMats = new Map<number, THREE.MeshBasicMaterial>();
    for (let i = 0; i < TILE_COUNT; i++) {
      const m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.containers.add(m);
      this.numberSprites.push(m as unknown as THREE.Sprite);
    }
    const craterGeo = new THREE.CircleGeometry(1.7, 20);
    for (let i = 0; i < TILE_COUNT; i++) {
      const m = new THREE.Mesh(
        craterGeo,
        new THREE.MeshBasicMaterial({ color: 0x4a2114, transparent: true, opacity: 0.9, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      // حلقة جمر متوهجة حول الحفرة (بدل الفراغ الأسود)
      const ember = new THREE.Mesh(
        new THREE.RingGeometry(1.25, 1.75, 22),
        new THREE.MeshBasicMaterial({
          color: 0xff7a2a,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ember.position.y = 0.012;
      m.add(ember);
      this.containers.add(m);
      this.craters.push(m);
    }
    // مناطق السيطرة من نفس إعدادات الخادم
    const half = (config.arena.gridSize - 1) / 2;
    for (const pair of (config as any).mines.zones as number[][]) {
      const t = TILES.find((q) => q.gx === pair[0] + half && q.gz === pair[1] + half);
      if (!t) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(config.arena.tileSize * 0.28, config.arena.tileSize * 0.46, 28),
        new THREE.MeshBasicMaterial({
          color: 0xffc46a,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(t.x, 0.06, t.z);
      this.containers.add(ring);
      this.zonePads.push(ring);
    }
  }

  /** نسيج رقم (يُبنى مرة واحدة لكل رقم) */
  private digitTexture(n: number): THREE.Texture {
    const cached = this.digitTex.get(n);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 96, 96);
    g.font = 'bold 74px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(10,10,14,0.95)';
    g.strokeText(String(n), 48, 52);
    g.fillStyle = n === 0 ? '#9fe8ff' : n <= 2 ? '#ffe9a8' : '#ff9d6b';
    g.fillText(String(n), 48, 52);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.digitTex.set(n, tex);
    return tex;
  }

  /** مزامنة كشف الألغام (تلوين البلاط + حفر) ومناطق السيطرة مع اللقطة */
  private syncField(snap: Snap | null, now: number) {
    const mn = snap?.mn ?? [];
    let dirty = false;
    for (const cell of mn) {
      const t = TILES[cell.i];
      if (!t) continue;
      // ألوان الكشف: 0 آمن (فيروزي) ← 1 أصفر ← 2 كهرماني ← 3+ أحمر
      const desired =
        cell.n === 9 ? 0x7a4a33 : cell.n === 0 ? 0x9ff0d8 : cell.n === 1 ? 0xffe9a3 : cell.n === 2 ? 0xffb478 : 0xff7a5c;
      if (this.revealedTint[cell.i] !== desired) {
        this.revealedTint[cell.i] = desired;
        this.renderedState[cell.i] = -9; // أجبر إعادة تلوين البلاطة
        dirty = true;
      }
      // الرقم نفسه فوق البلاطة (مع التلوين)
      const sp = this.numberSprites[cell.i] as unknown as THREE.Mesh;
      if (sp) {
        if (cell.n === 9) sp.visible = false;
        else {
          let mat = this.digitMats.get(cell.n);
          if (!mat) {
            mat = new THREE.MeshBasicMaterial({
              map: this.digitTexture(cell.n),
              transparent: true,
              depthWrite: false,
              depthTest: false,
              toneMapped: false,
            });
            this.digitMats.set(cell.n, mat);
          }
          if (sp.material !== mat) sp.material = mat;
          sp.position.set(t.x, 0.14, t.z);
          sp.renderOrder = 7;
          sp.visible = true;
        }
      }
      const cr = this.craters[cell.i];
      if (cr) {
        if (cell.n === 9 && !cr.visible) {
          cr.visible = true;
          cr.position.set(t.x, 0.05, t.z);
        } else if (cell.n !== 9 && cr.visible) cr.visible = false;
      }
    }
    void dirty;

    // مناطق السيطرة: لون صاحبها أو كهرماني محايد
    const zn = snap?.zn ?? [];
    if (zn.length && !(this as any)._zoneOwner) (this as any)._zoneOwner = new Map<string, string>();
    const ownerColor: Map<string, string> = (this as any)._zoneOwner ?? new Map();
    if (this.net0) for (const p of this.net0.state.players) ownerColor.set(p.id, p.color);
    for (const z of zn) {
      const pad = this.zonePads[z.i];
      if (!pad) continue;
      const m = pad.material as THREE.MeshBasicMaterial;
      const c = z.o ? ownerColor.get(z.o) : null;
      m.color.set(c ?? 0xffc46a);
      m.opacity = (c ? 0.85 : 0.4) + Math.sin(now * 0.004) * 0.12;
    }
  }

  private buildPickups() {
    const geo = new THREE.OctahedronGeometry(0.8, 0);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      m.visible = false;
      m.frustumCulled = false;
      this.containers.add(m);
      this.pickupMeshes.push(m);
    }
  }

  private syncPickups(snaps: Snap[], now: number) {
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    const list = latest?.pk ?? [];
    for (let i = 0; i < this.pickupMeshes.length; i++) {
      const m = this.pickupMeshes[i];
      const d = list[i];
      if (!d) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(d.x, 1.5 + Math.sin(now * 0.003 + i * 1.7) * 0.28, d.z);
      m.rotation.y = now * 0.002 + i;
      m.rotation.x = Math.sin(now * 0.0015 + i) * 0.4;
      (m.material as THREE.MeshBasicMaterial).color.setHex(ArenaScene.ITEM_COLORS[d.i] ?? 0xffffff);
    }
  }

  private buildDust() {
    const N = 220;
    this.dustPos = new Float32Array(N * 3).fill(-999);
    this.dustVel = new Float32Array(N * 3);
    this.dustLife = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xe0cbb4,
      size: 0.75,
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
    const dir = new THREE.Vector3(0, portrait ? 30 : 28, portrait ? 44 : 34).normalize();
    const len = portrait ? Math.max(46, needed * 0.72) : Math.max(40, needed * 0.92);
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
      character: null,
      loading: false,
      stunnedUntil: 0,
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
    // تحميل الشخصية المجسّمة (مرة واحدة للجميع) ثم إخفاء العنصر النائب
    if (!view.loading) {
      view.loading = true;
      createCharacter(color)
        .then((ch) => {
          if (!this.players.has(id)) return;
          view.character = ch;
          view.group.add(ch.root);
          body.visible = false;
          eyes.visible = false;
        })
        .catch(() => {
          /* يبقى العنصر النائب إن فشل التحميل */
        });
    }
    return view;
  }

  private recolor(v: PlayerView, color: string) {
    (v.body.material as THREE.MeshLambertMaterial).color.set(color);
    (v.ring.material as THREE.MeshBasicMaterial).color.set(color);
    v.color = color;
  }

  /** إصابة: توقّف مؤقت وحركة تلقّي الضربة */
  onHit(id?: string) {
    if (!id) return;
    const v = this.players.get(id);
    if (!v) return;
    v.stunnedUntil = performance.now() + 480;
    v.character?.play('hit', 0.08);
  }

  /** اندفاع: حركة لكمة + ركلة في زاوية الرؤية */
  onDash(id?: string) {
    if (!id) return;
    this.players.get(id)?.character?.play('dash', 0.08);
    if (this.net0?.state.youId === id) this.fovKick = 1;
  }

  private net0: Net | null = null;
  private fovKick = 0;

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
    this.net0 = net;
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
    this.syncPickups(net.snaps, now);
    this.syncField(net.snaps.length ? net.snaps[net.snaps.length - 1] : null, now);
    this.updateDust(dt);
    this.updateSparks(dt);
    this.applyShake(now);

    // سحب تنجرف + لهب يرتجف
    this.clouds.rotation.y += dt * 0.012;
    const tsec = now * 0.001;
    for (let i = 0; i < this.braziers.length; i++) {
      const f = this.braziers[i];
      const k = 1 + Math.sin(tsec * 9 + i * 1.7) * 0.14;
      f.scale.set(k, 1 + Math.sin(tsec * 13 + i) * 0.22, k);
      (f.material as THREE.MeshBasicMaterial).opacity = 0.7 + Math.sin(tsec * 11 + i) * 0.15;
    }
    if (this.torchLight) this.torchLight.intensity = 6 + Math.sin(tsec * 8) * 1.5;


    this.updateCamera(net, dt);
    this.renderer.render(this.scene, this.camera);
    this.adaptQuality(dt);
  }

  /** كاميرا مخمّدة تتبع مركز اللاعبين، وتزيد زاوية الرؤية عند الاندفاع */
  private updateCamera(net: Net, dt: number) {
    const latest = net.snaps.length ? net.snaps[net.snaps.length - 1] : null;
    let cx = 0;
    let cz = 0;
    let n = 0;
    for (const p of latest?.players ?? []) {
      if (p.a !== 1) continue;
      cx += p.x;
      cz += p.z;
      n++;
    }
    if (n) {
      cx /= n;
      cz /= n;
    }
    const target = this.basePos.clone().add(new THREE.Vector3(cx * 0.18, 0, cz * 0.14));
    const k = 1 - Math.exp(-dt * 3.2);
    this.camera.position.lerp(target, k);
    this.camera.lookAt(cx * 0.22, 0.6, cz * 0.18);

    this.fovKick = Math.max(0, this.fovKick - dt * 2.6);
    const fov = 55 + this.fovKick * 9;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private adaptQuality(dt: number) {
    if (typeof location !== 'undefined' && /q=(high|1)/.test(location.search)) return;
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
      // اتجاه الشخصية نحو حركتها
      if (pos.a !== 0) {
        const ang = Math.atan2(pos.fx || 0, pos.fz || 1);
        let cur = view.group.rotation.y;
        let diff = ang - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        view.group.rotation.y = cur + diff * Math.min(1, dt * 10);
      }

      // الشخصية المجسّمة
      const moved = Math.hypot(pos.x - view.lastX, pos.z - view.lastZ);
      const speed = moved / Math.max(0.0016, dt);
      view.lastX = pos.x;
      view.lastZ = pos.z;
      if (view.character) {
        view.character.update(dt, {
          speed,
          y: pos.y,
          alive: pos.a !== 0,
          stunnedUntil: view.stunnedUntil,
          now: performance.now(),
        });
      }

      if (pos.a === 0) {
        view.group.position.y -= dt * 6;
        view.ring.visible = false;
        view.body.visible = false;
        view.eyes.visible = false;
      } else {
        view.ring.visible = true;
        if (!view.character) {
          view.eyes.visible = true;
          const ang2 = Math.atan2(pos.fx || 0, pos.fz || 1);
          view.eyes.rotation.y += (ang2 - view.eyes.rotation.y) * Math.min(1, dt * 12);
        }
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
          this.spawnDust(TILES[i].x, TILES[i].z, 12);
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
      if (!animating && this.renderedState[i] === st && st !== 0) continue;
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
        const vv = 0.9 + ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.2;
        const tint = this.revealedTint[i];
        this.color.setHex(tint || (dark ? 0xf2ece0 : 0xdfd7c8)).multiplyScalar(vv);
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
/** حجر منقوش: نسيج رمادي مبقّع + خطوط نقش مضيئة */
function makeStone(): { map: THREE.Texture; emissive: THREE.Texture } {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9b2a6';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = Math.random() * 7 + 1;
    const v = 150 + Math.random() * 85;
    g.fillStyle = `rgba(${v},${v - 6},${v - 18},${0.05 + Math.random() * 0.12})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // حدّ مشطوف (إضاءة من الأعلى، ظل من الأسفل)
  const bev = 16;
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.32)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(40,32,24,0.55)';
  g.lineWidth = bev;
  g.strokeRect(bev / 2, bev / 2, S - bev, S - bev);

  // خريطة النقش المضيء (خطوط ذهبية)
  const e = document.createElement('canvas');
  e.width = e.height = S;
  const eg = e.getContext('2d')!;
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, S, S);
  eg.strokeStyle = 'rgba(255,190,90,0.95)';
  eg.lineWidth = 3;
  eg.strokeRect(28, 28, S - 56, S - 56);
  eg.strokeStyle = 'rgba(255,170,70,0.6)';
  eg.lineWidth = 2;
  eg.beginPath();
  eg.moveTo(S / 2, 40);
  eg.lineTo(S - 40, S / 2);
  eg.lineTo(S / 2, S - 40);
  eg.lineTo(40, S / 2);
  eg.closePath();
  eg.stroke();
  eg.fillStyle = 'rgba(255,200,110,0.8)';
  eg.beginPath();
  eg.arc(S / 2, S / 2, 6, 0, Math.PI * 2);
  eg.fill();

  // نقش النقش على الخريطة الأساسية (يتأثر بالإضاءة والظل)
  const g2 = g;
  g2.strokeStyle = 'rgba(255,196,110,0.9)';
  g2.lineWidth = 3;
  g2.strokeRect(28, 28, S - 56, S - 56);
  g2.strokeStyle = 'rgba(255,175,80,0.55)';
  g2.lineWidth = 2;
  g2.beginPath();
  g2.moveTo(S / 2, 40);
  g2.lineTo(S - 40, S / 2);
  g2.lineTo(S / 2, S - 40);
  g2.lineTo(40, S / 2);
  g2.closePath();
  g2.stroke();
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const emissive = new THREE.CanvasTexture(e);
  emissive.colorSpace = THREE.SRGBColorSpace;
  return { map, emissive };
}

/** نسيج سحابة ناعم */
function makeCloud(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 26; i++) {
    const x = 40 + Math.random() * (S - 80);
    const y = 60 + Math.random() * (S - 120);
    const r = 22 + Math.random() * 48;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,247,238,0.55)');
    rg.addColorStop(1, 'rgba(255,240,230,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#0b0d24');
  g.addColorStop(0.28, '#2c1a4e');
  g.addColorStop(0.44, '#6d3a63');
  g.addColorStop(0.52, '#c2554f');
  g.addColorStop(0.58, '#f2925a');
  g.addColorStop(0.63, '#7a3a3c');
  g.addColorStop(1, '#150b16');
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
