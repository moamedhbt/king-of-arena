/**
 * شخصيات ثلاثية الأبعاد مجسّمة (GLB بهيكل عظمي) مع مزج حركات ناعم.
 *
 * النموذج: RobotExpressive.glb — CC0 (Tomás Laulhé، تعديل Don McCurdy)، 454 كيلوبايت،
 * 14 حركة. يُحلَّل الملف مرة لكل لاعب (بدل النسخ بالهيكل) لضمان سلامة الربط العظمي.
 *
 * الحالات: idle · run · dash · jump · fall · hit · win · lose
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type CharState = 'idle' | 'run' | 'dash' | 'jump' | 'fall' | 'hit' | 'win' | 'lose';

const URL_GLB = '/models/RobotExpressive.glb';

/** ربط حالتنا بأسماء الحركات في الملف */
const CLIP: Record<CharState, string> = {
  idle: 'Idle',
  run: 'Running',
  dash: 'Punch',
  jump: 'Jump',
  fall: 'Death',
  hit: 'No',
  win: 'ThumbsUp',
  lose: 'Sitting',
};

let buffer: ArrayBuffer | null = null;
let fetching: Promise<ArrayBuffer> | null = null;
const loader = new GLTFLoader();

/** تنزيل الملف مرة واحدة مع نسبة تقدّم (0..1) */
export function preloadCharacter(onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  if (buffer) return Promise.resolve(buffer);
  if (fetching) return fetching;
  fetching = (async () => {
    const res = await fetch(URL_GLB);
    if (!res.ok) throw new Error(`GLB ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    const reader = res.body?.getReader();
    if (!reader) {
      const b = await res.arrayBuffer();
      buffer = b;
      onProgress?.(1);
      return b;
    }
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) onProgress?.(Math.min(1, got / total));
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    buffer = out.buffer;
    onProgress?.(1);
    return buffer;
  })();
  return fetching;
}

export class Character {
  root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: CharState = 'idle';
  private currentAction: THREE.AnimationAction | null = null;
  private squash = 1;
  private wasAir = false;

  constructor(model: THREE.Group, clips: THREE.AnimationClip[], color: string) {
    // تلوين لكل لاعب: نسخة مادة لكل لاعب، والهيكل الأساسي هوية اللون
    model.traverse((o: any) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;
      const src = o.material as THREE.MeshStandardMaterial;
      const mat = src.clone();
      if (mat.name === 'Main' || mat.name === 'Grey') mat.color = new THREE.Color(color);
      mat.roughness = 0.62;
      mat.metalness = 0.08;
      o.material = mat;
    });

    // توحيد الطول: الشخصية بطول ~3 وحدات مهما كان حجم الملف
    const box = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.001, box.max.y - box.min.y);
    const k = 3.0 / h;
    model.scale.setScalar(k);
    model.position.y = -box.min.y * k;
    // توسيط أفقيًا
    model.position.x = -((box.max.x + box.min.x) / 2) * k;
    model.position.z = -((box.max.z + box.min.z) / 2) * k;
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      this.actions.set(clip.name, a);
    }
    this.play('idle', 0);
  }

  /** تبديل الحالة بمزج ناعم 0.15 ثانية */
  play(state: CharState, fade = 0.15) {
    if (this.current === state && this.currentAction?.isRunning()) return;
    const next = this.actions.get(CLIP[state]);
    if (!next) return;
    const once = state === 'dash' || state === 'jump' || state === 'hit' || state === 'win';
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.timeScale = state === 'run' ? 1.15 : 1;
    if (this.currentAction && this.currentAction !== next) next.crossFadeFrom(this.currentAction, fade, false);
    next.play();
    this.currentAction = next;
    this.current = state;
  }

  /** حالة الحركة: جوي/مصاب/راكض/واقف + انضغاط وتمدد عند الهبوط */
  update(dt: number, opts: { speed: number; y: number; alive: boolean; stunnedUntil: number; now: number }) {
    if (!opts.alive) this.play('fall');
    else if (opts.now < opts.stunnedUntil) this.play('hit');
    else if (opts.y > 0.35) this.play('jump');
    else if (opts.speed > 1.2) this.play('run');
    else this.play('idle');

    const air = opts.y > 0.35;
    if (this.wasAir && !air) this.squash = 0.78;
    if (!this.wasAir && air) this.squash = 1.18;
    this.wasAir = air;
    this.squash += (1 - this.squash) * Math.min(1, dt * 9);
    this.root.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));

    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.clear();
  }
}

/** ينشئ شخصية مستقلة (تحليل كامل للملف لكل لاعب) */
export async function createCharacter(color: string): Promise<Character> {
  const buf = await preloadCharacter();
  const gltf = await loader.parseAsync(buf.slice(0), '');
  return new Character(gltf.scene as unknown as THREE.Group, gltf.animations, color);
}
