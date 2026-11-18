import type { PoseFrame } from '../tracking/frame.ts';
import { h } from './dom.ts';

const BONES: [number, number][] = [
  [0, 7], [0, 8], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24], [23, 24],
];
const DISMISS_KEY = 'shadowbox:cameraNotice:dismissed';

/** Mirrored webcam preview with the tracked skeleton drawn over it. */
export class WebcamBox {
  readonly root = h('div', { class: 'webcam' });
  private canvas = h('canvas');
  private ctx = this.canvas.getContext('2d')!;

  /** Camera quality notice over the preview; shrinks to a chip during a match. */
  private noticeEl = h('div', { class: 'cam-notice', role: 'status' });
  private noticeKey = '';
  private dismissed = sessionStorage.getItem(DISMISS_KEY) === '1';

  constructor(video: HTMLVideoElement | null, placeholder?: HTMLElement) {
    if (video) this.root.append(video, this.canvas, this.noticeEl);
    else if (placeholder) this.root.append(placeholder);
  }

  notice(copy: { title: string; line: string; chip: string } | null): void {
    const show = !!copy && !this.dismissed;
    this.noticeEl.classList.toggle('on', show);
    const key = show ? JSON.stringify(copy) : '';
    if (key === this.noticeKey) return;
    this.noticeKey = key;
    if (!show) return void this.noticeEl.replaceChildren();
    const close = h('button', { class: 'cam-notice-x', type: 'button', 'aria-label': 'Dismiss' }, 'x');
    close.addEventListener('click', () => {
      this.dismissed = true;
      sessionStorage.setItem(DISMISS_KEY, '1');
      this.notice(null);
    });
    this.noticeEl.title = copy.line;
    this.noticeEl.replaceChildren(h('b', {}, copy.title), h('span', { class: 'cam-notice-chip' }, copy.chip), h('p', {}, copy.line), close);
  }

  draw(f: PoseFrame | null, video: HTMLVideoElement | null, good: boolean): void {
    if (!video) return;
    const w = video.videoWidth || 640, hgt = video.videoHeight || 480;
    if (this.canvas.width !== w) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    const c = this.ctx;
    c.clearRect(0, 0, w, hgt);
    if (!f) return;
    const aspect = w / hgt;
    const px = (i: number) => [(f.img[i].x / aspect) * w, f.img[i].y * hgt] as const;
    c.lineWidth = 4;
    c.strokeStyle = good ? 'rgba(120, 255, 170, 0.9)' : 'rgba(255, 200, 80, 0.9)';
    c.lineCap = 'round';
    for (const [a, b] of BONES) {
      if (f.img[a].v < 0.4 || f.img[b].v < 0.4) continue;
      const [x1, y1] = px(a), [x2, y2] = px(b);
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    }
    c.fillStyle = '#fff';
    for (const i of [0, 11, 12, 13, 14, 15, 16]) {
      if (f.img[i].v < 0.4) continue;
      const [x, y] = px(i);
      c.beginPath();
      c.arc(x, y, i >= 15 ? 9 : 5, 0, Math.PI * 2);
      c.fill();
    }
  }
}
