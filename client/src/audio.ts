import { config } from '@shared/index';

/**
 * صوت مُولَّد بالكامل عبر WebAudio — بلا ملفات خارجية (حجم الموقع < 3MB).
 * موسيقى خفيفة لكل مرحلة + مؤثرات + اهتزاز (iPhone لا يدعم الاهتزاز من المتصفح).
 */

type Sfx = 'countdown' | 'correct' | 'wrong' | 'pick' | 'dash' | 'hit' | 'ko' | 'collapse' | 'win' | 'join';

const SCALES: Record<string, number[]> = {
  // ترددات أساسية (Hz) — مقام صغير لكل مرحلة
  lobby: [220, 261.6, 293.7, 349.2],
  puzzle: [293.7, 349.2, 440, 523.3],
  arena: [174.6, 220, 261.6, 329.6],
  result: [261.6, 329.6, 392, 523.3],
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private beat = 0;
  private theme: keyof typeof SCALES = 'lobby';
  enabled = config.ui.audioDefault;
  musicOn = config.ui.musicDefault;
  vibration = config.ui.vibrationDefault;

  /** يجب أن يُستدعى بعد أول لمسة/نقرة (سياسة المتصفحات) */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicOn ? 0.14 : 0;
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.enabled ? 0.5 : 0;
    this.sfxGain.connect(this.master);
    this.startMusicLoop();
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.sfxGain) this.sfxGain.gain.value = this.enabled ? 0.5 : 0;
    this.musicOn = this.enabled;
    if (this.musicGain) this.musicGain.gain.value = this.musicOn ? 0.14 : 0;
    localStorage.setItem('koa_audio', this.enabled ? '1' : '0');
    return this.enabled;
  }

  setTheme(theme: keyof typeof SCALES) {
    this.theme = theme;
  }

  private startMusicLoop() {
    if (this.musicTimer !== null) return;
    this.musicTimer = window.setInterval(() => this.tick(), 260);
  }

  private tick() {
    if (!this.ctx || !this.musicGain || !this.musicOn) return;
    const scale = SCALES[this.theme] ?? SCALES.lobby;
    const b = this.beat++;
    // نبضة باص كل 4، ونغمة كل نبضة
    const t0 = this.ctx.currentTime + 0.02;
    const note = scale[b % scale.length] * (b % 8 >= 4 ? 2 : 1);
    this.blip(note, 0.22, 'triangle', this.musicGain, 0.5);
    if (b % 4 === 0) this.blip(scale[0] / 2, 0.5, 'sine', this.musicGain, 0.7);
    if (this.theme === 'arena' && b % 2 === 1) this.blip(scale[2] / 2, 0.12, 'square', this.musicGain, 0.18);
  }

  private blip(freq: number, dur: number, type: OscillatorType, dest: AudioNode, vol = 0.5, when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol = 0.4, hp = 400) {
    if (!this.ctx || !this.sfxGain) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start();
  }

  sfx(kind: Sfx, strength = 0.7) {
    if (!this.ctx || !this.enabled || !this.sfxGain) return;
    const L = this.sfxGain;
    switch (kind) {
      case 'countdown':
        this.blip(660, 0.12, 'square', L, 0.3);
        break;
      case 'correct':
        this.blip(880, 0.1, 'triangle', L, 0.35);
        this.blip(1320, 0.16, 'triangle', L, 0.3, 0.09);
        break;
      case 'wrong':
        this.blip(180, 0.2, 'sawtooth', L, 0.3);
        break;
      case 'pick':
        this.blip(520, 0.08, 'square', L, 0.22);
        break;
      case 'dash':
        this.noise(0.16, 0.22, 900);
        this.blip(240, 0.1, 'sawtooth', L, 0.12);
        break;
      case 'hit':
        this.blip(120 * (0.8 + strength * 0.6), 0.12, 'square', L, 0.25 + strength * 0.2);
        this.noise(0.1, 0.15 + strength * 0.2, 300);
        break;
      case 'ko':
        this.blip(320, 0.35, 'sawtooth', L, 0.35);
        this.blip(160, 0.45, 'sine', L, 0.3, 0.05);
        this.noise(0.3, 0.25, 200);
        break;
      case 'collapse':
        this.noise(0.35, 0.12, 120);
        break;
      case 'win':
        [523.3, 659.3, 784, 1046.5].forEach((f, i) => this.blip(f, 0.3, 'triangle', L, 0.3, i * 0.12));
        break;
      case 'join':
        this.blip(440, 0.08, 'triangle', L, 0.2);
        break;
    }
  }

  /** اهتزاز الجهاز — لا يعمل على iPhone (لا يوجد دعم في المتصفح) */
  vibrate(pattern: number | number[]) {
    if (!this.vibration) return;
    const nav = navigator as any;
    if (typeof nav.vibrate === 'function') {
      try {
        nav.vibrate(pattern);
      } catch {
        /* تجاهل */
      }
    }
  }
}
