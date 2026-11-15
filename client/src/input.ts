/**
 * التحكم: لوحة المفاتيح (WASD/الأسهم، Space = اندفاع، E = أداة) + عصا وجوال.
 * العميل يرسل مدخلات فقط، ولا يتنبأ بالفيزياء.
 */

export class Controls {
  x = 0;
  z = 0;
  private keys = new Set<string>();
  private dashQueued = false;
  private itemQueued = -1; // فتحة الأداة المطلوبة (-1 = لا شيء)
  private joyActive = false;
  private joyId = -1;
  private joyVec = { x: 0, z: 0 };

  onDash?: () => void;
  onItem?: () => void;

  constructor(
    private joystick: HTMLElement,
    private stick: HTMLElement,
    private dashBtn: HTMLElement,
    private itemBtns: HTMLElement[]
  ) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === ' ') {
        this.queueDash();
        e.preventDefault();
      }
      if (k === 'e') this.queueItem(0);
      if (k === 'q') this.queueItem(1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    const start = (e: PointerEvent) => {
      this.joyActive = true;
      this.joyId = e.pointerId;
      this.updateJoy(e);
      this.joystick.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!this.joyActive || e.pointerId !== this.joyId) return;
      this.updateJoy(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      this.joyActive = false;
      this.joyId = -1;
      this.joyVec = { x: 0, z: 0 };
      this.stick.style.transform = 'translate(-50%, -50%)';
    };
    this.joystick.addEventListener('pointerdown', start);
    this.joystick.addEventListener('pointermove', move);
    this.joystick.addEventListener('pointerup', end);
    this.joystick.addEventListener('pointercancel', end);

    const tap = (fn: () => void) => (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    this.dashBtn.addEventListener('pointerdown', tap(() => this.queueDash()));
    this.itemBtns.forEach((btn, i) => {
      btn.addEventListener('pointerdown', tap(() => this.queueItem(i)));
    });
  }

  private updateJoy(e: PointerEvent) {
    const r = this.joystick.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const max = r.width / 2 - 12;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    this.stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = dx / max;
    const ny = dy / max;
    // الشاشة: أعلى = بعيد عن الكاميرا = ‎-z
    this.joyVec.x = Math.abs(nx) < 0.12 ? 0 : nx;
    this.joyVec.z = Math.abs(ny) < 0.12 ? 0 : ny;
  }

  private queueDash() {
    this.dashQueued = true;
    this.onDash?.();
  }
  private queueItem(slot: number) {
    this.itemQueued = slot;
    this.onItem?.();
  }

  /** يجمع حالة هذا الإطار */
  poll() {
    let x = this.joyVec.x;
    let z = this.joyVec.z;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) z -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) z += 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    this.x = x;
    this.z = z;
  }

  consumeDash(): boolean {
    const v = this.dashQueued;
    this.dashQueued = false;
    return v;
  }
  /** يعيد فتحة الأداة المطلوبة أو -1 */
  consumeItem(): number {
    const v = this.itemQueued;
    this.itemQueued = -1;
    return v;
  }
  reset() {
    this.dashQueued = false;
    this.itemQueued = -1;
    this.keys.clear();
    this.joyVec = { x: 0, z: 0 };
  }
}
