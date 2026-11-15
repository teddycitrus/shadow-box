import './styles.css';
import { sound } from './audio/sound.ts';
import { OnlineLink } from './net/online.ts';
import { DemoLink, PracticeLink } from './practice/bot.ts';
import { CameraInput, KEY_HELP, KeyInput, type InputSource } from './tracking/input.ts';
import { button, flag, go, h } from './ui/dom.ts';
import { startPlayer } from './views/player.ts';
import { startSpectator } from './views/spectator.ts';

const app = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '');

/**
 * Sound is on by default. Browsers only allow audio after a user gesture, so the first click or
 * key press anywhere starts it (unless the player has muted with the toggle first).
 */
let started = false;
async function startSound(): Promise<void> {
  if (started || sound.muted) return;
  started = true;
  await sound.unlock();
  sound.startCrowd();
  if (location.pathname.startsWith('/watch/')) sound.announce('welcome');
}
const firstGesture = (e: Event) => {
  if ((e.target as Element | null)?.closest?.('.soundbtn')) return;
  removeEventListener('pointerdown', firstGesture);
  removeEventListener('keydown', firstGesture);
  void startSound();
};
addEventListener('pointerdown', firstGesture);
addEventListener('keydown', firstGesture);

/** Always-visible sound toggle. */
function soundToggle(): HTMLButtonElement {
  const b = h('button', { class: 'soundbtn', type: 'button' });
  const render = () => {
    b.textContent = sound.muted ? 'Sound off' : 'Sound on';
    b.classList.toggle('on', !sound.muted);
    b.setAttribute('aria-pressed', String(!sound.muted));
  };
  b.addEventListener('click', () => {
    if (!sound.muted) return sound.setMuted(true);
    sound.setMuted(false);
    if (started) void sound.unlock();
    else void startSound();
  });
  sound.onChange(render);
  render();
  return b;
}
document.body.append(soundToggle());

function makeInput(): InputSource {
  const input: InputSource = flag('keys') ? new KeyInput() : new CameraInput();
  input.start().catch((err: unknown) => {
    console.error(err);
    showError(`Could not start the camera (${err instanceof Error ? err.message : String(err)}). Allow camera access over HTTPS, or add ?keys=1 to play with the keyboard.`);
  });
  return input;
}

function showError(msg: string): void {
  app.append(h('div', { class: 'panel error' }, h('p', {}, msg), button('Back to title', () => go('/'), 'ghost')));
}

function howTo(): HTMLElement {
  const close = button('Close', () => el.remove(), 'primary');
  const section = (name: string, ...kids: (HTMLElement | string)[]) => h('section', { class: 'howto-sec' }, h('h3', {}, name), ...kids);
  const el = h('div', { class: 'modal' }, h('div', { class: 'panel howto', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to play' },
    h('h2', {}, 'How to play'),
    h('div', { class: 'howto-grid' },
      section('Setup',
        h('ol', { class: 'steps' },
          h('li', {}, 'Put the laptop at chest height and stand 1.5 to 2 m away.'),
          h('li', {}, 'Use good light in front of you, not behind you.'),
          h('li', {}, 'Make sure your head, shoulders, elbows and hands are in frame.'),
          h('li', {}, 'Hold your guard for 2 seconds to calibrate, then press Ready.'),
        ),
      ),
      section('Attacks',
        h('ul', { class: 'moves' },
          h('li', {}, h('b', {}, 'Jab / cross'), 'Punch straight at the camera with your lead / rear hand.'),
          h('li', {}, h('b', {}, 'Hook'), 'Elbow bent, hand at shoulder height, swing across.'),
          h('li', {}, h('b', {}, 'Uppercut'), 'Start below your chin and drive the fist up.'),
        ),
        h('p', { class: 'note' }, 'Every punch is a body shot unless you aim it clearly high: fist at your eye level for the head (uppercuts up to your chin). Return your hand to guard before throwing it again.'),
      ),
      section('Defense',
        h('ul', { class: 'moves' },
          h('li', {}, h('b', {}, 'High guard'), 'Both gloves up by your face. Blocks most of the damage, but absorbing hits costs stamina, and stamina comes back slower while you hold it.'),
          h('li', {}, h('b', {}, 'Duck'), 'Drop your head well down. Dodges head shots.'),
          h('li', {}, h('b', {}, 'Slip'), 'Move your head to the side. Slip away from a straight to dodge it.'),
        ),
      ),
      section('Rules',
        h('p', {}, 'Three 60 s rounds, 100 HP. Punching costs stamina; below 30 you are gassed and hit softer. At 0 HP you go down: hold a steady guard to beat the count. Three knockdowns is a TKO.'),
      ),
      section('Keyboard mode (?keys=1)',
        h('div', { class: 'keyhelp' }, ...KEY_HELP.map(([k, v]) => h('div', {}, h('kbd', {}, k), ' ', v))),
      ),
    ),
    h('div', { class: 'row' }, close),
  ));
  el.addEventListener('click', (e) => e.target === el && el.remove());
  el.addEventListener('keydown', (e) => e.key === 'Escape' && el.remove());
  queueMicrotask(() => close.focus());
  return el;
}

function title(): void {
  document.body.classList.add('title-screen');
  startSpectator(app, new DemoLink(), { demo: true });
  const code = h('input', { placeholder: 'CODE', maxlength: '4', class: 'codein', 'aria-label': 'Match code', autocomplete: 'off', spellcheck: 'false' });
  const join = () => {
    const c = code.value.trim().toUpperCase();
    if (/^[A-Z]{4}$/.test(c)) go(`/play/${c}`);
  };
  code.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  app.append(h('div', { class: 'scrim' }, h('i', { class: 'slash red' }), h('i', { class: 'slash blue' }), h('i', { class: 'speed' })), h('div', { class: 'title' },
    h('h1', { 'aria-label': 'Keyboard Warrior' },
      h('span', { class: 't1', 'data-text': 'Keyboard', 'aria-hidden': 'true' }, 'Keyboard'),
      h('span', { class: 't2', 'data-text': 'Warrior', 'aria-hidden': 'true' }, 'Warrior'),
    ),
    h('div', { class: 'menu' },
      button('Create match', () => go('/create'), 'primary'),
      h('div', { class: 'joinrow' }, code, button('Join', join)),
      button('Practice', () => go('/practice')),
      button('How to play', () => app.append(howTo()), 'ghost'),
    ),
  ));
}

function online(mode: { create: true } | { join: string }): void {
  const input = makeInput();
  const link = new OnlineLink(mode);
  let view: ReturnType<typeof startPlayer> | null = null;
  link.onJoined = (code, slot) => {
    if (location.pathname !== `/play/${code}`) history.replaceState(null, '', `/play/${code}${location.search}`);
    if (!view) view = startPlayer(app, link, input, { practice: false, code });
    view.setSlot(slot);
  };
  link.onError = (msg) => {
    if (msg.includes('full')) go(`/watch/${(mode as { join: string }).join}`);
    else showError(msg);
  };
}

const m = path.match(/^\/(play|join|watch)\/([A-Za-z]{4})$/);
if (path === '' || path === '/') title();
else if (path === '/practice') startPlayer(app, new PracticeLink(), makeInput(), { practice: true });
else if (path === '/create') online({ create: true });
else if (m?.[1] === 'play' || m?.[1] === 'join') online({ join: m[2].toUpperCase() });
else if (m?.[1] === 'watch') {
  const link = new OnlineLink({ watch: m[2].toUpperCase() });
  link.onError = showError;
  startSpectator(app, link, { code: m[2].toUpperCase() });
} else go('/');
