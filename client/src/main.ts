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

addEventListener('pointerdown', () => sound.unlock(), { once: true });
addEventListener('keydown', () => sound.unlock(), { once: true });

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
  const el = h('div', { class: 'modal' }, h('div', { class: 'panel howto' },
    h('h2', {}, 'How to play'),
    h('ol', {},
      h('li', {}, 'Put the laptop at chest height and stand 1.5 to 2 m away.'),
      h('li', {}, 'Use good light in front of you, not behind you.'),
      h('li', {}, 'Make sure your head, shoulders, elbows and hands are in frame.'),
      h('li', {}, 'Hold your guard for 2 seconds to calibrate, then press Ready.'),
    ),
    h('h3', {}, 'Attacks'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Jab / cross: '), 'punch straight at the camera with your lead / rear hand.'),
      h('li', {}, h('b', {}, 'Hook: '), 'elbow bent, hand at shoulder height, swing across.'),
      h('li', {}, h('b', {}, 'Uppercut: '), 'start below your chin and drive the fist up.'),
      h('li', {}, 'Punch high for the head, low for the body. Return your hand to guard before throwing it again.'),
    ),
    h('h3', {}, 'Defense'),
    h('ul', {},
      h('li', {}, h('b', {}, 'High guard: '), 'both gloves up by your face. Blocks with a little chip damage.'),
      h('li', {}, h('b', {}, 'Duck: '), 'drop your head well down. Dodges head shots.'),
      h('li', {}, h('b', {}, 'Slip: '), 'move your head to the side. Slip away from a straight to dodge it.'),
    ),
    h('h3', {}, 'Rules'),
    h('p', {}, 'Three 60 s rounds, 100 HP. Punching costs stamina; below 30 you are gassed and hit softer. At 0 HP you go down: hold a steady guard to beat the count. Three knockdowns is a TKO.'),
    h('h3', {}, 'Keyboard mode (?keys=1)'),
    h('div', { class: 'keyhelp' }, ...KEY_HELP.map(([k, v]) => h('div', {}, h('kbd', {}, k), ' ', v))),
    h('div', { class: 'row' }, close),
  ));
  return el;
}

function title(): void {
  startSpectator(app, new DemoLink(), { demo: true });
  const code = h('input', { placeholder: 'CODE', maxlength: '4', class: 'codein', autocomplete: 'off', spellcheck: 'false' });
  const join = () => {
    const c = code.value.trim().toUpperCase();
    if (/^[A-Z]{4}$/.test(c)) go(`/play/${c}`);
  };
  code.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  app.append(h('div', { class: 'title' },
    h('h1', {}, 'Shadow', h('span', {}, 'Box')),
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

const m = path.match(/^\/(play|watch)\/([A-Za-z]{4})$/);
if (path === '' || path === '/') title();
else if (path === '/practice') startPlayer(app, new PracticeLink(), makeInput(), { practice: true });
else if (path === '/create') online({ create: true });
else if (m?.[1] === 'play') online({ join: m[2].toUpperCase() });
else if (m?.[1] === 'watch') {
  const link = new OnlineLink({ watch: m[2].toUpperCase() });
  link.onError = showError;
  startSpectator(app, link, { code: m[2].toUpperCase() });
} else go('/');
