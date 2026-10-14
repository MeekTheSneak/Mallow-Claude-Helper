/* Mallow: behavior, live updates and the report. */
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const fmtU = (u) => u >= 1e6 ? (u / 1e6).toFixed(1) + 'M' : u >= 1e3 ? Math.round(u / 1e3) + 'k' : String(Math.round(u));
const kTok = (t) => t >= 1000 ? Math.round(t / 1000) + 'k' : String(t);
const pct = (x) => Math.round(x * 100) + '%';
const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
const store = {
  get(k, d) { try { const v = localStorage.getItem('mallow.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('mallow.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

const OUTFITS = ['none', 'party', 'flowers', 'bow', 'beanie', 'chef', 'crown'];
const OUTFIT_NAMES = { none: 'No hat', party: 'Party hat', flowers: 'Flower crown', bow: 'Bow', beanie: 'Beanie', chef: 'Chef hat', crown: 'Crown' };
const ROLE_NAMES = { explore: 'Explorer', plan: 'Planner', test: 'Tester', review: 'Reviewer', docs: 'Librarian', dev: 'Coder', security: 'Guard', thread: 'Thread', worker: 'Helper' };
const FUR_LIST = ['ginger', 'cream', 'cocoa', 'smoke'];

const settings = {
  theme: store.get('theme', 'auto'),
  hat: store.get('hat', 'none'),
  sound: store.get('sound', false),
  seeds: store.get('seeds', 0),
  notifyCache: store.get('notifyCache', true),
  tips: store.get('tips', true),
  focus: '',
};

let theme = 'day';
let FLOOR = 372;
let live = null;              // last snapshot from the server
let liveSeq = null;
let serverOffset = 0;
let connected = false;
let lastPoke = Date.now();

/* ================================================================ theme */
function effectiveTheme() {
  if (settings.theme !== 'auto') return settings.theme;
  const h = new Date().getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

function applyTheme(force) {
  const t = effectiveTheme();
  if (t === theme && !force) return;
  theme = t;
  FLOOR = L().floor;
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('#themes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme)));
  $('#room').innerHTML = roomMarkup(t);
  $('#wheelLayer').innerHTML = wheelMarkup(t);
  updateClock();
  buildDragon();
  // reset positions so nobody is stuck inside a wheel that isn't there
  M.inWheel = false;
  M.actor.size = 1;
  M.actor.hop = null;
  M.mode = 'idle';
  M.until = 0;
  M.actor.x = t === 'knight' ? 300 : 520;
  M.actor.y = FLOOR;
  M.actor.rot = 0;
  for (const b of babies.values()) { b.inWheel = false; b.state = 'enter'; b.actor.y = FLOOR; b.actor.rot = 0; b.actor.hop = null; b.actor.x = doorX(); }
  refreshMallowLook();
  babies.forEach((b) => b.actor.setLook(babyLook(b)));
  removeBug();
  seeds.splice(0).forEach((s) => s.el.remove());
}

function doorX() { return L().door; }

function updateClock() {
  const d = new Date(), h = d.getHours() % 12, m = d.getMinutes();
  const hh = document.querySelector('.clock-h'), mm = document.querySelector('.clock-m');
  if (hh) hh.setAttribute('transform', `rotate(${h * 30 + m / 2})`);
  if (mm) mm.setAttribute('transform', `rotate(${m * 6})`);
}

/* ================================================================ actors */
/* Each pose is built once and kept; switching poses only shows one and hides the last.
   Rebuilding the picture on every frame made characters blink out while it reloaded. */
class PoseStack {
  constructor(el) { this.el = el; this.map = new Map(); this.cur = null; this.curKey = null; }
  show(key, build) {
    if (key === this.curKey) return;
    let g = this.map.get(key);
    if (!g) {
      g = document.createElementNS(SVGNS, 'g');
      g.innerHTML = build();
      this.el.appendChild(g);
      this.map.set(key, g);
    }
    if (this.cur) this.cur.setAttribute('display', 'none');
    g.removeAttribute('display');
    this.cur = g; this.curKey = key;
  }
}

const FRAME_TIMES = { run: [95, 95, 95, 95], walk: [150, 150, 150, 150], fight: [520, 150, 130, 300] };

class Actor {
  constructor(kind, look, id) {
    this.kind = kind;
    this.look = { face: 'normal', item: null, hat: null, gear: null, fur: 'ginger', ...look };
    this.size = 1;
    this.x = 0; this.y = FLOOR; this.rot = 0; this.flip = -1;
    this.cls = 'idle';
    this.frame = 0; this.frameAt = 0;
    this.blinkUntil = 0; this.nextBlink = performance.now() + rand(2500, 5000);
    this.shadow = true;
    this.el = document.createElementNS(SVGNS, 'g');
    if (id) this.el.dataset.id = id;
    this.el.setAttribute('class', `actor ${kind} idle`);
    this.poses = new PoseStack(this.el);
    // babies go in behind Mallow, so he stays in front when they share the wheel
    const layer = $('#actors');
    if (kind === 'baby' && layer.firstChild) layer.insertBefore(this.el, layer.firstChild); else layer.appendChild(this.el);
  }
  setLook(part) { Object.assign(this.look, part); }
  setCls(c) {
    if (c === this.cls) return;
    this.cls = c;
    this.frame = 0;
    this.el.setAttribute('class', `actor ${this.kind} ${c}`);
  }
  pose(now) {
    const knight = theme === 'knight';
    if (this.kind === 'mallow') return mallowPose(this.look, this.cls, this.frame, now < this.blinkUntil, knight);
    return babyPose(this.look, this.cls, this.frame);
  }
  wear(pose) {
    const out = [];
    if (hasOwnHelmet(pose)) return out;
    if (this.kind === 'mallow') {
      if (pose !== 'm-sleep' && this.look.hat && HAT_SPRITE[this.look.hat]) out.push(HAT_SPRITE[this.look.hat]);
    } else if (this.look.gear && GEAR_SPRITE[this.look.gear]) out.push(GEAR_SPRITE[this.look.gear]);
    return out;
  }
  tick(now) {
    // how long each frame of the cycle shows; a swing holds its ready pose, then strikes quickly
    const times = FRAME_TIMES[this.cls];
    if (times && now - this.frameAt > times[this.frame % times.length]) { this.frame = (this.frame + 1) % 4; this.frameAt = now; }
    if (this.cls === 'idle' && now > this.nextBlink) { this.blinkUntil = now + 150; this.nextBlink = now + rand(2800, 5600); }
    const pose = this.pose(now), wear = this.wear(pose);
    const key = [pose, this.flip, this.size, wear.join(','), this.shadow].join('|');
    this.poses.show(key, () => characterMarkup(pose, {
      k: kFor(this.kind) * this.size, faceRight: this.flip === 1, wear, shadow: this.shadow,
      ref: this.kind === 'mallow' ? 'm-idle' : 'b-ginger-idle',
    }));
  }
  place() {
    this.el.setAttribute('transform', `translate(${this.x.toFixed(1)} ${this.y.toFixed(1)}) rotate(${this.rot.toFixed(1)})`);
  }
  height() { return WORLD[this.kind] * this.size; }
  headY() {                                   // top of the sprite actually shown, so bubbles sit above hats and raised paws
    const spr = SPR[this.poses.curKey ? this.poses.curKey.split('|')[0] : ''];
    const h = spr ? spr.h * kFor(this.kind) * this.size : this.height();
    const hat = this.look.hat || this.look.gear === 'knight' ? 0.22 : 0;
    return this.y - h * (1 + hat);
  }
  remove() { this.el.remove(); }
}

/* walking helper: returns true on arrival */
function stepTo(a, tx, dt, speed) {
  const d = tx - a.x;
  if (Math.abs(d) < 2) { a.x = tx; return true; }
  a.flip = d > 0 ? 1 : -1;
  a.x += Math.sign(d) * Math.min(Math.abs(d), speed * dt);
  return Math.abs(tx - a.x) < 2;
}

function hop(a, x1, y1, ms, then) {
  a.hop = { x0: a.x, y0: a.y, x1, y1, t0: performance.now(), ms, then };
}
function runHop(a, now) {
  if (!a.hop) return false;
  const h = a.hop, t = clamp((now - h.t0) / h.ms, 0, 1);
  a.x = h.x0 + (h.x1 - h.x0) * t;
  a.y = h.y0 + (h.y1 - h.y0) * t - Math.sin(Math.PI * t) * a.height() * 0.4;
  if (t >= 1) { const cb = h.then; a.hop = null; if (cb) cb(); }
  return true;
}

/* ================================================================ Mallow */
const M = {
  actor: null, mode: 'idle', until: 0, target: 0, onArrive: null, inWheel: false,
  wave: null, routine: null, lastZ: 0, lastPow: 0, lastTip: 0,
};

function mallowHat() {
  if (theme === 'knight') return 'helmet';
  return settings.hat === 'none' ? null : settings.hat;
}
function refreshMallowLook(part = {}) {
  M.actor.setLook({ hat: mallowHat(), ...part });
}

function busy() {
  const st = live && live.focus && live.focus.status;
  return st === 'working' || st === 'thinking';
}
function hasAlerts() { return !!(live && live.incidents && live.incidents.length); }

function workSpot() { return L().work; }
function wheelFeet() { const g = wheelGeom(); return { x: g.cx, y: g.cy + g.rin }; }

function goWalk(x, then) {
  M.mode = 'walk';
  M.target = clamp(x, 60, 950);
  M.onArrive = then || null;
}

function setIdle(ms) {
  M.mode = 'idle';
  M.until = performance.now() + (ms ?? rand(2500, 6000));
  M.routine = null;
}

function mallowTick(now, dt) {
  const a = M.actor;
  if (runHop(a, now)) { a.tick(now); a.place(); return; }

  // Claude started working: everything else waits
  if (busy() && !['toWork', 'work', 'hopIn'].includes(M.mode)) {
    M.wave = null;
    a.setLook({ face: 'normal', item: null });
    refreshMallowLook();
    if (Math.abs(a.x - workSpot()) < 4) startWork(); else { M.mode = 'toWork'; M.target = workSpot(); }
  }

  switch (M.mode) {
    case 'toWork':
      a.setCls('walk');
      if (stepTo(a, M.target, dt, 230)) startWork();
      break;
    case 'work':
      if (!busy()) { stopWork(); break; }
      if (theme === 'knight') {
        a.flip = 1; a.setCls('fight');
        if (now - M.lastPow > 1400) { M.lastPow = now; fxPow(a.x + 70, a.y - 70); sfx('hit'); }
      } else {
        a.setCls('run'); a.flip = -1;
        a.setLook({ item: null, face: 'normal' });
      }
      break;
    case 'walk':
      a.setCls('walk');
      if (stepTo(a, M.target, dt, 150)) { const cb = M.onArrive; M.onArrive = null; if (cb) cb(); else setIdle(); }
      break;
    case 'wave':
      if (now > M.until) { M.wave = null; refreshMallowLook({ face: 'normal', item: null }); if (theme === 'knight') dragonState('sleep'); setIdle(); }
      break;
    case 'eat':
      if (now > M.until) {
        settings.seeds++; store.set('seeds', settings.seeds); updateSeedNote();
        refreshMallowLook({ face: 'happy', item: null });
        a.setCls('idle');
        hearts(a.x, a.headY()); sfx('chirp');
        say(pick(['Crunchy, thanks!', 'Mm, sunflower.', 'Saving half for later.', 'Best seed yet.']), 2200);
        setIdle(2200);
      }
      break;
    case 'dance':
      if (now > M.until) { refreshMallowLook({ face: 'normal' }); setIdle(); }
      break;
    case 'routine':
      if (now > M.until) { refreshMallowLook({ item: null, face: 'normal' }); setIdle(); }
      break;
    case 'sleep':
      a.setCls('sleep');
      if (hasAlerts() || busy()) { M.mode = 'idle'; refreshMallowLook({ face: 'normal' }); break; }
      if (now - M.lastZ > 1500) { M.lastZ = now; fxText('z', a.x + 34, a.headY() + 12, INK); }
      if (Date.now() - lastPoke < 1000) { refreshMallowLook({ face: 'normal' }); say('Oh! I was just resting my eyes.', 2400); setIdle(2000); }
      break;
    case 'alert':
      a.setCls('alertpose');
      if (!hasAlerts()) { refreshMallowLook({ face: 'happy', item: null }); setIdle(1500); }
      break;
    default: // idle
      if (hasAlerts()) { M.mode = 'alert'; refreshMallowLook({ face: 'alert', item: 'sign' }); sfx('ding'); break; }
      a.setCls('idle');
      if (now > M.until) chooseRoutine();
  }

  // seeds on the floor pull him over when he's free
  if (['idle', 'routine'].includes(M.mode) && seeds.length) {
    const s = seeds[0];
    goWalk(s.x - 38 * Math.sign(s.x - a.x || 1), () => {
      const sd = seeds.shift(); if (sd) sd.el.remove();
      M.mode = 'eat'; M.until = performance.now() + 2200;
      a.setCls('chew'); refreshMallowLook({ face: 'chew', item: 'seed' });
    });
  }
  a.tick(now);
  a.place();
}

function startWork() {
  const a = M.actor;
  if (theme === 'knight') {
    M.mode = 'work'; a.flip = 1; dragonState('fight');
    return;
  }
  const f = wheelFeet();
  M.mode = 'hopIn';
  a.setCls('idle'); a.flip = -1;
  hop(a, f.x, f.y, 450, () => { M.mode = 'work'; M.inWheel = true; a.size = 0.88; a.shadow = false; a.flip = -1; });
}

function stopWork() {
  const a = M.actor;
  if (theme === 'knight') {
    if (M.wave) { M.mode = 'wave'; M.until = performance.now() + 9000; a.setCls('cheer'); refreshMallowLook({ face: 'cheer' }); dragonState('dizzy'); sayTurn(); }
    else { dragonState('sleep'); refreshMallowLook({ item: null }); setIdle(1500); }
    return;
  }
  M.mode = 'hopIn';
  a.size = 1; a.shadow = true;
  hop(a, workSpot(), FLOOR, 420, () => {
    M.inWheel = false;
    if (M.wave) { M.mode = 'wave'; M.until = performance.now() + 9000; a.flip = 1; a.setCls('wave'); refreshMallowLook({ face: 'happy' }); sayTurn(); }
    else setIdle(1200);
  });
}

function sayTurn() {
  const s = M.wave ? M.wave.secs : 0;
  const took = s >= 90 ? `${Math.round(s / 60)} min` : `${s}s`;
  say(`<span class="b-title">Your turn!</span><div class="b-detail">That took ${took}.</div>`, 8000, true);
  sfx('tada');
}

function chooseRoutine() {
  const a = M.actor, now = performance.now();
  if (Date.now() - lastPoke > 75000 && !busy()) {
    M.mode = 'sleep'; refreshMallowLook({ face: 'sleep', item: null }); return;
  }
  const knight = theme === 'knight';
  const options = knight ? ['stroll', 'stroll', 'look', 'polish', 'stretch', 'dance'] : ['stroll', 'stroll', 'look', 'drink', 'mug', 'book', 'stretch'];
  const r = pick(options);
  const [lo, hi] = L().stroll;
  const doRoutine = (cls, look, ms) => { M.mode = 'routine'; M.until = performance.now() + ms; a.setCls(cls); refreshMallowLook(look); };
  switch (r) {
    case 'stroll': goWalk(rand(lo, hi)); break;
    case 'look': doRoutine('look', { face: 'normal' }, 2600); break;
    case 'drink': goWalk(L().drink, () => { a.flip = 1; doRoutine('idle', { face: 'happy' }, 2600); }); break;
    case 'mug': doRoutine('idle', { item: 'mug', face: 'happy' }, 4200); break;
    case 'book': doRoutine('idle', { item: 'book', face: 'normal' }, 5200); break;
    case 'polish': doRoutine('groom', { item: 'sword', face: 'happy' }, 3600); break;
    case 'stretch': doRoutine('stretch', { face: 'happy' }, 2000); break;
    case 'dance': doRoutine('dance', { face: 'happy' }, 2400); break;
  }
  if (now - M.lastTip > 60000 && Math.random() < .2) { M.lastTip = now; idleChatter(); }
}

function idleChatter() {
  if (!live || !live.focus) return;
  const f = live.focus, left = cacheRemaining();
  if (left !== null && left > 0 && left < 300 && f.status !== 'working') say(`The cache is still warm for ${Math.ceil(left / 60)} more min.`, 3500);
}

/* ================================================================ babies */
const babies = new Map();

function hashNum(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function babyLook(b) {
  return { fur: FUR_LIST[hashNum(b.id) % FUR_LIST.length], gear: theme === 'knight' ? 'knight' : b.role, face: 'normal' };
}

function syncBabies(agents) {
  const seen = new Set();
  let order = babies.size;
  for (const ag of agents) {
    seen.add(ag.id);
    let b = babies.get(ag.id);
    if (!b) {
      b = { id: ag.id, role: ag.role, label: ag.label, kind: ag.kind, state: 'enter', inWheel: false, order: order++, joined: performance.now() };
      b.actor = new Actor('baby', babyLook(b), ag.id);
      // helpers that arrive together come out of the door in a little line instead of stacked
      const queued = [...babies.values()].filter((o) => o.state === 'enter').length;
      b.actor.x = doorX() + (theme === 'knight' ? -1 : 1) * queued * 34; b.actor.y = FLOOR;
      b.actor.el.addEventListener('click', (e) => { e.stopPropagation(); poke(); hearts(b.actor.x, b.actor.headY()); showTag(b, 3000); sfx('chirp'); });
      babies.set(ag.id, b);
      showTag(b, 3500);
      sfx('chirp');
    }
    b.label = ag.label;
    if (b.role !== ag.role) { b.role = ag.role; b.actor.setLook(babyLook(b)); }
  }
  for (const b of babies.values()) {
    if (!seen.has(b.id) && b.state !== 'leave' && b.state !== 'gone') {
      b.state = 'leave';
      if (b.inWheel) { b.inWheel = false; b.actor.rot = 0; b.actor.shadow = true; hop(b.actor, L().work, FLOOR, 380); }
    }
  }
}

function babySlots() {
  const active = [...babies.values()].filter((b) => b.state !== 'leave' && b.state !== 'gone').sort((a, b) => a.order - b.order);
  active.forEach((b, i) => { b.slot = i; });
}

const WHEEL_SLOTS = [58, -58, 80, -80];
function babyTick(now, dt) {
  babySlots();
  const knight = theme === 'knight';
  for (const b of babies.values()) {
    const a = b.actor;
    if (runHop(a, now)) { a.tick(now); a.place(); continue; }
    if (b.state === 'gone') continue;
    if (b.state === 'leave') {
      a.setCls('walk'); a.rot = 0;
      if (stepTo(a, doorX(), dt, 170)) {
        b.state = 'gone'; a.setCls('wave fade');
        setTimeout(() => { a.remove(); babies.delete(b.id); }, 600);
      }
    } else if (knight) {
      const spots = L().fightSpots, tx = spots[b.slot % spots.length];
      if (b.state !== 'work') { a.setCls('walk'); if (stepTo(a, tx, dt, 190)) b.state = 'work'; }
      else { a.x = tx; a.flip = 1; a.setCls('fight'); }
    } else if (b.slot < WHEEL_SLOTS.length) {
      const g = wheelGeom(), deg = WHEEL_SLOTS[b.slot], ang = deg * Math.PI / 180;
      const fx = g.cx + Math.sin(ang) * g.rin, fy = g.cy + Math.cos(ang) * g.rin;
      if (!b.inWheel) {
        a.setCls('walk');
        if (stepTo(a, L().work, dt, 190)) {
          b.inWheel = true; a.shadow = false;
          hop(a, fx, fy, 420, () => { a.rot = -deg; });
        }
      } else { a.x = fx; a.y = fy; a.rot = -deg; a.flip = -1; a.setCls('run'); }
    } else {
      const tx = L().work + 30 + (b.slot - WHEEL_SLOTS.length) * 40;
      if (b.inWheel) { b.inWheel = false; a.rot = 0; a.y = FLOOR; a.shadow = true; }
      if (Math.abs(a.x - tx) > 3) { a.setCls('walk'); stepTo(a, tx, dt, 190); } else { a.flip = -1; a.setCls('run'); }
    }
    a.tick(now);
    a.place();
  }
}

/* ================================================================ dragon, bug, sign, seeds */
let dragonEl = null, dragonPoses = null, dragonCur = '', dragonFrame = 0, dragonAt = 0;
function buildDragon() {
  if (dragonEl) { dragonEl.remove(); dragonEl = null; dragonCur = ''; }
  if (theme !== 'knight') return;
  const d = L().dragon;
  dragonEl = document.createElementNS(SVGNS, 'g');
  dragonEl.setAttribute('transform', `translate(${d.x} ${d.y})`);
  dragonEl.addEventListener('click', (e) => { e.stopPropagation(); poke(); hearts(d.x - 40, d.y - 160); sayAt(pick(['Rawr! (a friendly one)', 'The dragon just wants a nap.', 'Grr. Okay, fine, one pat.']), 2400, d.x - 60, d.y - 190); sfx('chirp'); });
  $('#floorLayer').appendChild(dragonEl);
  dragonPoses = new PoseStack(dragonEl);
  dragonState('sleep');
}
function dragonPose() {
  if (dragonCur === 'fight') return SPR['d-battle1'] ? 'd-battle' + (dragonFrame + 1) : (dragonFrame % 2 ? 'd-fire' : 'd-awake');
  if (dragonCur === 'awake' && SPR['d-battle1']) return 'd-battle1';
  return { sleep: 'd-sleep', dizzy: 'd-dizzy', awake: 'd-awake' }[dragonCur] || 'd-sleep';
}
const DRAGON_TIMES = [700, 420, 260, 520];       // ready, breathe in, small flame, big flame
function renderDragon() {
  if (!dragonEl) return;
  const pose = dragonPose(), k = kFor('dragon');
  dragonEl.setAttribute('class', 'actor dragon ' + dragonCur);
  dragonPoses.show(pose, () => characterMarkup(pose, { k, faceRight: false }));
}
function dragonState(s) {
  if (!dragonEl || s === dragonCur) return;
  dragonCur = s;
  renderDragon();
  if (s === 'dizzy') setTimeout(() => { if (dragonCur === 'dizzy' && !busy()) dragonState('sleep'); }, 7000);
}
function dragonTick(now) {
  if (!dragonEl) return;
  if (dragonCur === 'fight' && now - dragonAt > DRAGON_TIMES[dragonFrame]) { dragonFrame = (dragonFrame + 1) % 4; dragonAt = now; renderDragon(); }
}

let bugObj = null, bugDismissed = false;
function ensureBug() {
  if (bugObj || bugDismissed) return;
  const el = document.createElementNS(SVGNS, 'g');
  el.setAttribute('class', 'actor bug');
  const name = theme === 'knight' ? 'p-slime' : 'p-beetle';
  el.innerHTML = `<g class="bug-body">${floorShadow(propWidth(name, 30) * .7)}${propMarkup(name, theme === 'knight' ? 30 : 34)}</g>`;
  el.addEventListener('click', (e) => { e.stopPropagation(); squashBug(true); });
  $('#floorLayer').appendChild(el);
  const [lo, hi] = L().bugRange;
  bugObj = theme === 'knight' ? { el, x: doorX(), dir: 1, target: rand(lo, hi) } : { el, x: 1020, dir: -1, target: rand(lo, hi) };
  if (!busy()) say('Uh oh, a bug got in. The last command failed.', 3500);
}
function removeBug() { if (bugObj) { bugObj.el.remove(); bugObj = null; } }
function squashBug(byClick) {
  if (!bugObj) return;
  fxPoof(bugObj.x, FLOOR + 6);
  fxText(byClick ? 'squish!' : 'fixed!', bugObj.x, FLOOR - 30, '#3F8A5A', 18);
  sfx('pop');
  removeBug();
  if (byClick) bugDismissed = true;
}
function bugTick(dt) {
  const want = live && live.focus && live.focus.bug;
  if (!want) { bugDismissed = false; if (bugObj) squashBug(false); return; }
  ensureBug();
  if (!bugObj) return;
  const d = bugObj.target - bugObj.x;
  if (Math.abs(d) < 3) { const [lo, hi] = L().bugRange; bugObj.target = rand(lo, hi); }
  bugObj.dir = Math.sign(d) || -1;
  bugObj.x += bugObj.dir * Math.min(Math.abs(d), 55 * dt);
  // the beetle art faces left, so mirror it when walking right
  bugObj.el.setAttribute('transform', `translate(${bugObj.x.toFixed(1)} ${FLOOR + 10}) scale(${bugObj.dir > 0 && theme !== 'knight' ? -1 : 1} 1)`);
}

let signEl = null;
function signTick() {
  const show = hasAlerts() && (M.mode === 'work' || M.mode === 'toWork' || M.mode === 'hopIn');
  if (show && !signEl) {
    signEl = document.createElementNS(SVGNS, 'g');
    signEl.setAttribute('class', 'actor');
    signEl.innerHTML = `<g transform="translate(${L().sign} ${FLOOR})">${floorShadow(26)}<g class="sign-planted">${propMarkup('p-sign', 66)}</g></g>`;
    signEl.addEventListener('click', (e) => { e.stopPropagation(); showAlert(); });
    $('#floorLayer').appendChild(signEl);
  } else if (!show && signEl) { signEl.remove(); signEl = null; }
}

const seeds = [];
function dropSeed(x) {
  if (seeds.length >= 5) return;
  const el = document.createElementNS(SVGNS, 'g');
  el.innerHTML = `<g class="seed-drop">${propMarkup('p-seed', 20)}</g>`;
  el.setAttribute('transform', `translate(${x.toFixed(0)} ${FLOOR + 4})`);
  $('#floorLayer').appendChild(el);
  seeds.push({ x, el });
  sfx('pop');
}

/* ================================================================ effects */
function fxAdd(markup, x, y, cls, vars, life = 1400) {
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  const inner = document.createElementNS(SVGNS, 'g');
  inner.setAttribute('class', cls);
  if (vars) inner.setAttribute('style', vars);
  inner.innerHTML = markup;
  g.appendChild(inner);
  $('#fx').appendChild(g);
  setTimeout(() => g.remove(), life);
}
function hearts(x, y) {
  for (let i = 0; i < 3; i++) setTimeout(() => fxAdd(`<path d="M0 -6 C-6 -14 -16 -6 -10 2 L0 12 L10 2 C16 -6 6 -14 0 -6Z" fill="#FF8FA3" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`, x + rand(-22, 22), y, 'fx-float', `--dx:${rand(-16, 16).toFixed(0)}px`), i * 130);
}
function fxText(t, x, y, color, size = 22) {
  fxAdd(`<text text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="600" font-size="${size}" fill="${color}" stroke="#FFFDF8" stroke-width="4" paint-order="stroke">${esc(t)}</text>`, x, y, 'fx-float', `--dx:${rand(-10, 10).toFixed(0)}px`);
}
function confetti(x, y) {
  const cols = ['#FF9DB2', '#FFD45E', '#8FE3C8', '#8FD0EE', '#B9A6FF'];
  for (let i = 0; i < 14; i++) {
    const a = rand(-Math.PI, 0), d = rand(40, 90);
    fxAdd(`<rect x="-4" y="-3" width="8" height="6" rx="2" fill="${pick(cols)}"/>`, x, y, 'fx-burst', `--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;--r:${rand(-200, 200).toFixed(0)}deg`, 1000);
  }
}
function fxPow(x, y) {
  fxAdd(`<path d="M0 -22 L6 -8 L22 -10 L10 2 L18 16 L2 8 L-8 20 L-8 4 L-22 0 L-8 -8 Z" fill="#FFD45E" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`, x + rand(-8, 8), y + rand(-10, 10), 'fx-pop', '', 600);
}
function fxPoof(x, y) {
  for (let i = 0; i < 5; i++) fxAdd(`<circle r="${rand(8, 14).toFixed(0)}" fill="#FFFFFF" stroke="${INK}" stroke-width="2.5"/>`, x + rand(-18, 18), y + rand(-16, 2), 'fx-pop', '', 600);
}

/* ================================================================ bubble, badge, tags */
const bubble = { el: $('#bubble'), until: 0, sticky: false, anchor: null, ax: 0, ay: 0 };
function say(html, ms = 3000, sticky = false) {
  bubble.el.innerHTML = html;
  bubble.alert = null;
  bubble.until = performance.now() + ms;
  bubble.sticky = sticky;
  bubble.anchor = 'mallow';
  bubble.el.classList.add('show');
}
function sayAt(html, ms, x, y) { say(html, ms); bubble.anchor = null; bubble.ax = x; bubble.ay = y; }
function hideBubble() { bubble.el.classList.remove('show'); bubble.sticky = false; }
function bubbleTick(now) {
  if (!bubble.el.classList.contains('show')) return;
  if (now > bubble.until && !bubble.alert) { hideBubble(); return; }
  const a = M.actor;
  const x = bubble.anchor === 'mallow' ? a.x : bubble.ax;
  const y = bubble.anchor === 'mallow' ? a.headY() - 6 : bubble.ay;
  placeOverlay(bubble.el, x, y, 6);
}

/* position an HTML overlay over a point in the scene, kept inside the visible room */
function placeOverlay(el, x, y, pad) {
  const scene = $('#scene'), wrap = $('#sceneWrap');
  const ctm = scene.getScreenCTM();
  if (!ctm) return;
  const pt = scene.createSVGPoint(); pt.x = x; pt.y = y;
  const p = pt.matrixTransform(ctm), r = wrap.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = clamp(p.x - r.left, w / 2 + pad, r.width - w / 2 - pad) + 'px';
  el.style.top = clamp(p.y - r.top, h + pad, r.height - pad) + 'px';
}

function showAlert() {
  if (!hasAlerts()) return;
  const inc = live.incidents[0];
  say(`<span class="b-title">${esc(inc.title)}</span><div class="b-detail">${esc(inc.detail)}</div><button type="button" data-ack="${esc(inc.id)}">Got it</button>`, 600000, true);
  bubble.alert = inc.id;
  sfx('ding');
}

function badgeTick() {
  const el = $('#badge');
  const f = live && live.focus;
  if (!f || !busy()) { el.classList.remove('show'); return; }
  const act = f.activity;
  const kind = act ? act.kind : 'think';
  const label = act ? act.label : 'thinking';
  if (el.dataset.k !== kind + label) {
    el.dataset.k = kind + label;
    $('#badgeIcon').innerHTML = icon(kind, 16);
    $('#badgeText').textContent = label;
  }
  el.classList.add('show');
  const [bx, by] = L().badge;
  placeOverlay(el, bx, by, 6);
}

function showTag(b, ms) {
  let t = document.getElementById('tag-' + b.id);
  if (!t) { t = document.createElement('div'); t.className = 'tag'; t.id = 'tag-' + b.id; $('#tags').appendChild(t); }
  t.textContent = `${ROLE_NAMES[b.role] || 'Helper'}: ${b.label}`;
  t.classList.add('show');
  b.tagUntil = performance.now() + ms;
}
function tagsTick(now) {
  for (const b of babies.values()) {
    const t = document.getElementById('tag-' + b.id);
    if (!t) continue;
    if (b.state === 'gone' || now > (b.tagUntil || 0)) { t.classList.remove('show'); if (b.state === 'gone') setTimeout(() => t.remove(), 400); continue; }
    placeOverlay(t, b.actor.x, b.actor.headY() - 6, 4);
  }
}

/* ================================================================ interactions */
function poke() { lastPoke = Date.now(); }

function pet() {
  poke();
  const a = M.actor;
  hearts(a.x, a.headY()); sfx('chirp');
  if (hasAlerts()) { showAlert(); return; }
  if (M.mode === 'idle' || M.mode === 'routine') {
    a.setCls('cheer'); refreshMallowLook({ face: 'happy' });
    M.mode = 'routine'; M.until = performance.now() + 1300;
  }
  const lines = ['Hehe, that tickles.', 'Thank you!', 'More pats, please.', 'I like you too.'];
  if (live && live.focus) {
    const left = cacheRemaining();
    if (left !== null && left > 0 && !busy()) lines.push(`Reply in the next ${Math.max(1, Math.floor(left / 60))} min and the cache stays warm.`);
    if (live.agents && live.agents.length) lines.push(`${live.agents.length} little helper${live.agents.length > 1 ? 's are' : ' is'} working with me.`);
  }
  say(pick(lines), 2600);
}
function feed() {
  poke();
  const a = M.actor, [lo, hi] = L().stroll;
  dropSeed(clamp(a.x + rand(70, 120) * (Math.random() < .5 ? -1 : 1), lo, hi));
}
function dance() {
  poke();
  if (busy()) { say("Can't dance now, I'm working!", 2000); return; }
  const a = M.actor; M.mode = 'dance'; M.until = performance.now() + 3200;
  a.setCls('dance'); refreshMallowLook({ face: 'happy' }); sfx('tada');
}
function outfit() {
  poke();
  const i = (OUTFITS.indexOf(settings.hat) + 1) % OUTFITS.length;
  settings.hat = OUTFITS[i]; store.set('hat', settings.hat);
  refreshMallowLook();
  hearts(M.actor.x, M.actor.headY());
  say(theme === 'knight' ? `${OUTFIT_NAMES[settings.hat]} saved for after the battle.` : `${OUTFIT_NAMES[settings.hat]}!`, 1800);
}
function toggleSound() {
  settings.sound = !settings.sound; store.set('sound', settings.sound);
  const b = $('#bSound'); b.setAttribute('aria-pressed', String(settings.sound)); b.firstChild.textContent = settings.sound ? 'Sound on ' : 'Sound off ';
  if (settings.sound) sfx('chirp');
}
function updateSeedNote() { $('#seedNote').textContent = settings.seeds ? `Click the floor to drop a seed · ${settings.seeds} eaten` : 'Click the floor to drop a seed'; }

$('#scene').addEventListener('click', (e) => {
  const pt = $('#scene').createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform($('#scene').getScreenCTM().inverse());
  if (M.actor.el.contains(e.target)) { pet(); return; }
  poke();
  if (p.y > L().back - 10) { const [lo, hi] = L().stroll; dropSeed(clamp(p.x, lo - 40, hi + 60)); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ack]');
  if (b) { ack(b.dataset.ack); return; }
});
$('#bPet').addEventListener('click', pet);
$('#bFeed').addEventListener('click', feed);
$('#bDance').addEventListener('click', dance);
$('#bOutfit').addEventListener('click', outfit);
$('#bSound').addEventListener('click', toggleSound);
document.querySelectorAll('#themes button').forEach((b) => b.addEventListener('click', () => {
  settings.theme = b.dataset.theme; store.set('theme', settings.theme); applyTheme(true);
}));
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, select, textarea') || $('#exp').open) return;
  const k = e.key.toLowerCase();
  if (k === 'p') pet(); else if (k === 'f') feed(); else if (k === 'd') dance(); else if (k === 'o') outfit(); else if (k === 's') toggleSound();
  else if (k === 't') { const order = ['auto', 'day', 'night', 'knight']; settings.theme = order[(order.indexOf(settings.theme) + 1) % 4]; store.set('theme', settings.theme); applyTheme(true); }
});

async function ack(id) {
  try {
    await fetch('/api/ack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mallow': '1' }, body: JSON.stringify({ id }) });
  } catch (e) { /* offline */ }
  if (live) live.incidents = live.incidents.filter((i) => i.id !== id && id !== '*');
  if (bubble.alert === id || id === '*') { bubble.alert = null; hideBubble(); }
  renderAlerts();
  hearts(M.actor.x, M.actor.headY());
  if (!hasAlerts()) say('Thanks for checking!', 1800);
}

/* ================================================================ sound */
let actx = null;
function tone(f, t0, dur, type = 'sine', vol = .07) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, actx.currentTime + t0);
  g.gain.setValueAtTime(0, actx.currentTime + t0);
  g.gain.linearRampToValueAtTime(vol, actx.currentTime + t0 + .01);
  g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + t0 + dur);
  o.connect(g).connect(actx.destination); o.start(actx.currentTime + t0); o.stop(actx.currentTime + t0 + dur + .02);
}
function sfx(name) {
  if (!settings.sound) return;
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  if (name === 'chirp') { tone(880, 0, .08); tone(1320, .08, .1); }
  else if (name === 'pop') { tone(620, 0, .06, 'triangle'); tone(310, .05, .08, 'triangle'); }
  else if (name === 'ding') { tone(1046, 0, .25, 'triangle', .08); tone(784, .18, .35, 'triangle', .08); }
  else if (name === 'tada') { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .08, .14, 'square', .035)); }
  else if (name === 'hit') { tone(180, 0, .08, 'square', .03); }
  else if (name === 'oops') { tone(392, 0, .12, 'sawtooth', .03); tone(330, .1, .16, 'sawtooth', .03); }
}

/* ================================================================ live updates */
function cacheRemaining() {
  const f = live && live.focus;
  if (!f || !f.cacheExpires) return null;
  return f.cacheExpires - (Date.now() / 1000 + serverOffset);
}

async function poll() {
  try {
    const r = await fetch('/api/live?since=' + (liveSeq ?? 0) + (settings.focus ? '&focus=' + encodeURIComponent(settings.focus) : ''), { cache: 'no-store' });
    if (!r.ok) throw new Error('bad');
    const data = await r.json();
    serverOffset = data.now - Date.now() / 1000;
    // a restarted (or newer) Mallow counts events from zero again; don't replay or skip them
    const first = liveSeq === null || data.seq < liveSeq;
    live = data;
    if (!first) for (const ev of data.events) handleEvent(ev);
    liveSeq = data.seq;
    connected = true;
    syncBabies(data.agents || []);
    renderLive();
  } catch (e) {
    connected = false;
    renderLive();
  }
}

function handleEvent(ev) {
  if (ev.sub) return;
  const a = M.actor;
  switch (ev.type) {
    case 'prompt': if (!busy()) say(pick(['On it!', 'Ooh, a new task.', "Let's go!"]), 1600); break;
    case 'edit_ok': {
      const g = theme === 'knight' ? null : wheelGeom();
      confetti(g ? g.cx : a.x + 40, g ? g.cy - g.r * .4 : a.headY());
      break;
    }
    case 'edit_fail': fxText('oops', a.x, a.headY(), '#C2412A'); sfx('oops'); break;
    case 'bug': bugDismissed = false; sfx('oops'); break;
    case 'squash': break;
    case 'turn_end':
      M.wave = { secs: ev.secs || 0 };
      if (!['work', 'toWork', 'hopIn'].includes(M.mode)) {
        M.mode = 'wave'; M.until = performance.now() + 9000;
        a.setCls(theme === 'knight' ? 'cheer' : 'wave'); refreshMallowLook({ face: theme === 'knight' ? 'cheer' : 'happy' }); sayTurn();
      }
      break;
    case 'incident': poke(); sfx('ding'); if (!busy()) showAlert(); break;
  }
}

const STATUS_TEXT = { working: 'Working', thinking: 'Thinking', your_turn: 'Your turn', idle: 'Idle' };
function babyThumb(fur, gear) {
  const g = gear && GEAR_SPRITE[gear] && WEAR[GEAR_SPRITE[gear]] && !WEAR[GEAR_SPRITE[gear]].neck && !WEAR[GEAR_SPRITE[gear]].eyes ? GEAR_SPRITE[gear] : null;
  return `<span class="thumb"><img src="sprites/b-${fur}-idle.png" alt="">${g ? `<img class="thumb-gear" src="sprites/${g}.png" alt="">` : ''}</span>`;
}
function renderLive() {
  const st = $('#status');
  if (!connected) {
    st.dataset.s = 'offline';
    st.lastChild.textContent = location.protocol === 'file:' ? 'Open Mallow with its launcher' : 'Not connected';
    return;
  }
  const f = live.focus;
  const where = f && f.project ? ` in ${base(f.project)}` : '';
  $('#subline').textContent = !f ? 'Watching your Claude Code sessions'
    : f.quiet ? `Claude is working${where}, or waiting for your OK`
    : f.status === 'working' || f.status === 'thinking' ? `Claude is working${where}`
    : f.status === 'your_turn' ? `Waiting for you${where}` : `Watching your Claude Code sessions`;
  st.dataset.s = f ? f.status : 'idle';
  st.lastChild.textContent = f ? STATUS_TEXT[f.status] || 'Idle' : 'No session yet';
  if (f) {
    $('#sessTitle').textContent = f.title;
    $('#sessMeta').textContent = [base(f.project), f.branch, f.model].filter(Boolean).join(' · ');
    const p = f.ctxWindow ? f.ctx / f.ctxWindow : 0;
    $('#ctxV').textContent = f.ctx ? pct(p) : '-';
    $('#ctxBar').style.width = Math.min(100, p * 100) + '%';
    $('#ctxBar').classList.toggle('hot', p > .8);
    $('#ctxN').textContent = f.ctx ? `${kTok(f.ctx)} of about ${kTok(f.ctxWindow)} tokens` : 'How full the conversation is';
    const j = f.journal;
    $('#journal').innerHTML = [`${j.turns} turn${j.turns === 1 ? '' : 's'}`, `${j.edits} edit${j.edits === 1 ? '' : 's'}`, `${j.commands} command${j.commands === 1 ? '' : 's'}`, j.fixes ? `${j.fixes} bug${j.fixes === 1 ? '' : 's'} squashed` : '', j.files ? `${j.files} file${j.files === 1 ? '' : 's'} touched` : '']
      .filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('') + '<span class="note" style="background:none;padding:3px 0">this session</span>';
  } else {
    $('#sessTitle').textContent = 'No session right now';
    $('#sessMeta').textContent = 'Start Claude Code in any project and Mallow will notice.';
    $('#ctxV').textContent = '-'; $('#ctxBar').style.width = '0'; $('#ctxBar').classList.remove('hot');
    $('#ctxN').textContent = 'How full the conversation is';
    $('#journal').innerHTML = '';
  }
  renderPicker();
  const crew = live.agents || [];
  $('#crew').innerHTML = crew.map((ag) => `<li>${babyThumb(FUR_LIST[hashNum(ag.id) % FUR_LIST.length], ag.role)}<b>${esc(ROLE_NAMES[ag.role] || 'Helper')}</b><span>${esc(ag.label)}</span></li>`).join('');
  $('#crewEmpty').hidden = crew.length > 0;
  renderAlerts();
  renderTip();
}

/* ================================================================ /clear and cold-cache tips */
const TIP_CLEAR = 100_000;   // a session this big makes every later message expensive
const TIP_COLD = 40_000;     // below this a cold cache costs little
let tipKey = null;
function notifyDesktop(title, body) {
  if (!settings.notifyCache || document.hasFocus()) return;
  fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mallow': '1' },
    body: JSON.stringify({ title, body }) }).catch(() => {});
}
function currentTip() {
  const f = live && live.focus;
  if (!f || !settings.tips || !f.ctx) return null;
  const left = cacheRemaining(), size = kTok(f.ctx);
  if (f.status !== 'working' && f.status !== 'thinking' && left !== null && left <= 0 && f.ctx >= TIP_COLD) {
    return { key: `cold:${f.id}:${Math.round(f.cacheExpires || 0)}`,
      text: `The cache expired, so your next message here re-sends about ${size} tokens at full price. Starting something new? /clear or a new session costs nothing. Coming back to this work? Claude Code may offer to pick up from a summary instead of the full history.` };
  }
  if (f.status === 'your_turn' && f.ctx >= TIP_CLEAR) {
    return { key: `clear:${f.id}:${Math.floor(f.ctx / 75_000)}`, nudge: true,
      text: `Claude's done. This session sends about ${size} tokens with every message. If your next task is unrelated, type /clear first. It's free, and Claude does better without old context in the way.` };
  }
  return null;
}
function renderTip() {
  const t = currentTip(), box = $('#tip');
  if (!t || store.get('tipsSeen', []).includes(t.key)) { box.hidden = true; tipKey = null; return; }
  box.hidden = false;
  if (t.key === tipKey) return;
  tipKey = t.key;
  $('#tipText').textContent = t.text;
  if (t.nudge) {
    if (!busy()) say('Good moment for a /clear if the next task is something new.', 4500);
    notifyDesktop('Mallow: a good time to /clear?', `${base(live.focus.project) || 'Your session'} is carrying ${kTok(live.focus.ctx)} tokens. If your next task is unrelated, /clear first.`);
  }
}
$('#tipOk').addEventListener('click', () => {
  if (!tipKey) return;
  store.set('tipsSeen', [...store.get('tipsSeen', []), tipKey].slice(-100));
  $('#tip').hidden = true;
});

function renderAlerts() {
  const list = (live && live.incidents) || [];
  $('#alertCard').hidden = !list.length;
  $('#alerts').innerHTML = list.map((i) => `<div class="alert"><b>${esc(i.title)}</b><p>${esc(i.detail)}</p><button class="btn small" data-ack="${esc(i.id)}">Got it</button></div>`).join('')
    + (list.length > 1 ? `<button class="btn small ghost" data-ack="*">Clear all</button>` : '');
}

function cacheTick() {
  const left = cacheRemaining(), box = $('#cacheBox');
  if (left === null || !live || !live.focus) { $('#cacheV').textContent = '-'; box.classList.remove('cold'); return; }
  const ttl = live.focus.cacheTtl || 300;
  if (left > 0) {
    const hh = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = Math.floor(left % 60);
    $('#cacheV').textContent = (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
    $('#cacheBar').style.width = clamp(left / ttl * 100, 0, 100) + '%';
    $('#cacheN').textContent = busy() ? 'Staying warm while Claude works.' : 'Still warm. Reply before it runs out to keep things cheap.';
    box.classList.remove('cold');
    cacheWarning(left, ttl);
  } else {
    const m = -left / 60, h = m / 60, d = h / 24;
    const ago = m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} ago`;
    $('#cacheV').textContent = 'Cold';
    $('#cacheBar').style.width = '0%';
    $('#cacheN').textContent = `Expired ${ago}. The next message re-sends the conversation at full price.`;
    box.classList.add('cold');
  }
}

/* ================================================================ session picker */
function renderPicker() {
  const sel = $('#sessPick'), list = (live && live.sessions) || [];
  const key = list.map((x) => x.id + x.status + x.title).join('|') + settings.focus;
  if (sel.dataset.k === key) return;
  sel.dataset.k = key;
  const label = { working: 'working', thinking: 'thinking', your_turn: 'your turn', idle: 'idle' };
  sel.innerHTML = '<option value="">Follow the active session</option>' + list.map((x) =>
    `<option value="${esc(x.id)}">${esc(base(x.project) || 'session')}: ${esc(x.title.slice(0, 40))} (${label[x.status] || 'idle'})</option>`).join('');
  sel.value = list.some((x) => x.id === settings.focus) ? settings.focus : '';
}
$('#sessPick').addEventListener('change', (e) => { settings.focus = e.target.value; liveSeq = null; poll(); });

/* ================================================================ cache warning */
let warnedFor = null;
function cacheWarning(left, ttl) {
  const f = live && live.focus;
  if (!f || busy() || f.status === 'idle') return;
  const lead = ttl > 600 ? 300 : 60;                 // 5 min warning for the 1 hour cache, 1 min for the 5 minute one
  const key = f.id + ':' + Math.round(f.cacheExpires);
  if (left > lead || left < 5 || warnedFor === key) return;
  warnedFor = key;
  const mins = Math.max(1, Math.round(left / 60));
  say(`The cache cools in about ${mins} min. Reply now to keep it cheap.`, 6000);
  notifyDesktop('Mallow: cache cooling soon', `${base(f.project) || 'Your session'} goes cold in about ${mins} min. Reply now, or let it go and start fresh later.`);
}

/* ================================================================ harness panel */
let hState = null;
async function harnessCall(body) {
  try {
    const r = body ? await fetch('/api/harness', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mallow': '1' }, body: JSON.stringify(body) })
                   : await fetch('/api/harness', { cache: 'no-store' });
    hState = await r.json();
    renderHarness();
    return hState;
  } catch (e) { return null; }
}
function sw(attrs, on, label) {
  return `<label class="switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''} aria-label="${esc(label)}"><i></i></label>`;
}
function renderHarness() {
  if (!hState) return;
  const h = hState, r = h.rules, on = h.installed && r.enabled;
  $('#harness').classList.toggle('off', !on);
  $('#hInstall').textContent = h.installed ? 'Turn off' : 'Turn on';
  $('#hInstall').classList.toggle('ghost', h.installed);
  const st = h.stats;
  if (h.installed && !r.enabled) $('#hSaved').innerHTML = `Paused <button class="btn ghost small" id="hResume">Resume</button>`;
  else $('#hSaved').textContent = st.savedWeek ? `Saved about ${fmtU(st.savedWeek)} tokens this week` : (h.installed ? 'On and watching' : '');
  let rows = `<li><div class="what"><b>Big files are read in parts</b><span>Files over ${Math.round(r.read.min_bytes / 1000)} KB get their first ${r.read.lines} lines, plus a note on how to read more.</span></div>${sw('data-rule="read"', r.read.enabled, 'Big files rule')}</li>`;
  for (const c of r.bash.commands) {
    rows += `<li><div class="what"><b>${esc(c.key)}</b><span>Printed about ${kTok(c.avg_tokens)} tokens${c.times > 1 ? `, ${c.times} times` : ''}. Shows the error lines and the last ${c.tail}, and saves the full log.</span></div>${sw(`data-rule="bash" data-key="${esc(c.key)}"`, c.enabled, c.key)}</li>`;
  }
  if (!r.bash.commands.length) rows += `<li><div class="what"><span>No long build or test logs in your history yet. Mallow adds them here if he spots any.</span></div></li>`;
  $('#hRules').innerHTML = rows;
  $('#hTune').innerHTML = (h.tuneups || []).map((t) => `<li><div class="what"><b>${esc(t.title)}${t.recommended ? '<span class="rec">recommended</span>' : ''}</b><span>${esc(t.desc)}</span></div>${sw(`data-tune="${esc(t.id)}"`, t.on, t.title)}</li>`).join('');
  $('#hRecent').innerHTML = st.recent.length ? st.recent.map((e) => {
    const when = new Date(e.ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const what = e.kind === 'read' ? `read ${base(e.target)} (${e.kept} of ${e.lines.toLocaleString()} lines)` : `${e.target} (errors and last ${e.kept} lines)`;
    return `<li><b>${esc(what)}</b><br>${when}${e.saved ? ` · about ${fmtU(e.saved)} tokens saved` : ''}</li>`;
  }).join('') : `<li>${h.installed ? 'Nothing trimmed yet.' : 'Turn trims on and they show up here.'}</li>`;
  const m = h.measure, v = h.verify;
  let mh = '';
  if (m && m.sessions) {
    const share = (x) => m.total ? ` (${Math.abs(Math.round(x / m.total * 1000) / 10)}% of all your usage)` : '';
    mh += `<b>Tested on your last ${m.sessions} sessions</b><div class="range">
      <div><span>If Claude never needed the trimmed part</span><b class="good">saves ${fmtU(m.best)}</b>${share(m.best)}</div>
      <div><span>If every trim sent Claude back for the rest</span><b class="${m.worst < 0 ? 'bad' : 'good'}">${m.worst < 0 ? 'costs' : 'saves'} ${fmtU(Math.abs(m.worst))}</b>${share(m.worst)}</div></div>
      ${m.read + m.bash ? `${m.read} big file read${m.read === 1 ? '' : 's'} and ${m.bash} noisy command${m.bash === 1 ? '' : 's'} would have been trimmed. This replays your saved sessions, with no model calls.` : 'None of your past sessions had anything these rules would trim.'}`;
  }
  if (v && v.checked) {
    const net = v.delivered - v.followedUp;
    mh += `<div style="margin-top:8px"><b>Since the harness went on</b><br>${v.delivered} of ${v.checked} trims reached Claude as intended. Claude went back for the trimmed part ${v.followedUp} time${v.followedUp === 1 ? '' : 's'}${net > 0 ? `, so ${net} trim${net === 1 ? '' : 's'} saved usage outright` : ''}.${v.notDelivered ? ` ${v.notDelivered} weren't applied by Claude Code.` : ''}</div>`;
  }
  $('#hMeasure').innerHTML = mh;
  $('#hMeasure').hidden = !mh;
  $('#hStartup').checked = !!h.startup;
  $('#hStartup').closest('.h-app').hidden = !String(h.platform).startsWith('win');
  $('#hNotify').checked = settings.notifyCache;
  $('#hNotify').closest('label').hidden = !String(h.platform).startsWith('win');
  $('#hTips').checked = settings.tips;
}
$('#hInstall').addEventListener('click', async () => {
  const was = hState && hState.installed;
  const r = await harnessCall({ action: was ? 'uninstall' : 'install' });
  const msg = $('#hMsg');
  if (!r || !r.ok) { msg.hidden = false; msg.textContent = r ? r.message : "Couldn't reach Mallow. Is his window still open?"; return; }
  msg.hidden = false;
  msg.textContent = was ? 'Harness is off. Your Claude Code settings are back to how they were.'
    : 'Harness is on. It takes effect in Claude Code sessions you start from now on. A backup of your settings is in your .mallow folder.';
  if (!was) { hearts(M.actor.x, M.actor.headY()); say('Harness is on. I\'ll trim the noisy stuff.', 3000); }
});
$('#hSaved').addEventListener('click', (e) => {
  if (e.target.id === 'hResume') harnessCall({ action: 'rule', rule: 'all', enabled: true });
});
$('#hRules').addEventListener('change', (e) => {
  const t = e.target; if (!t.dataset.rule) return;
  harnessCall({ action: 'rule', rule: t.dataset.rule, key: t.dataset.key, enabled: t.checked });
});
$('#hStartup').addEventListener('change', (e) => harnessCall({ action: 'startup', enabled: e.target.checked }));
$('#hTune').addEventListener('change', async (e) => {
  const t = e.target; if (!t.dataset.tune) return;
  const r = await harnessCall({ action: 'tuneup', id: t.dataset.tune, enabled: t.checked });
  const msg = $('#tMsg'); msg.hidden = false;
  msg.textContent = r && !r.ok ? r.message : 'Saved. It applies to Claude Code sessions you start from now on, and your old setting is kept so switching it off puts it back.';
});
$('#hTips').addEventListener('change', (e) => { settings.tips = e.target.checked; store.set('tips', settings.tips); renderTip(); });
$('#hNotify').addEventListener('change', (e) => { settings.notifyCache = e.target.checked; store.set('notifyCache', settings.notifyCache); });

/* ================================================================ report */
let report = null;
const F = { range: '30', project: 'all', sort: 'new', q: '' };
const MOOD_SPRITE = { happy: 'm-blink', okay: 'm-idle', worried: 'm-worried', stuffed: 'm-eat' };

async function loadReport() {
  try {
    const r = await fetch('/api/report', { cache: 'no-store' });
    report = await r.json();
    const projects = [...new Set(report.sessions.map((s) => s.project))].sort((a, b) => base(a).localeCompare(base(b)));
    const sel = $('#fProject'), cur = F.project;
    sel.innerHTML = '<option value="all">All projects</option>' + projects.map((p) => `<option value="${esc(p)}">${esc(base(p))}</option>`).join('');
    sel.value = projects.includes(cur) ? cur : 'all';
    const now = Date.parse(report.generated);
    if (F.range === '30' && !report.sessions.some((s) => now - Date.parse(s.end) <= 30 * 864e5)) setRange('all');
    renderReport();
  } catch (e) {
    $('#repLead').textContent = 'Session history shows up here when Mallow is opened with its launcher.';
  }
}

function filtered() {
  if (!report) return [];
  const now = Date.parse(report.generated);
  return report.sessions.filter((s) => {
    if (F.range !== 'all' && now - Date.parse(s.end) > (+F.range) * 864e5) return false;
    if (F.project !== 'all' && s.project !== F.project) return false;
    if (F.q && !(s.title + ' ' + s.project + ' ' + s.branch).toLowerCase().includes(F.q)) return false;
    return true;
  });
}

function thrift(hit, wr) { return Math.max(0, Math.min(100, Math.round(100 * (.7 * Math.min(hit / .9, 1) + .3 * Math.max(0, 1 - wr * 3))))); }
const fmtDate = (s) => s ? new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const fmtDay = (s) => s ? new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
const fmtDur = (m) => m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
const KIND_ICON = { 'Cold cache': 'other', 'Big tool result': 'read', 'Re-read file': 'read', 'Heavy start': 'plan', 'Long session': 'think', 'Subagent heavy': 'agent' };

const showAll = new Set();     // projects whose full session list is expanded
function renderReport() {
  const ss = filtered();
  let cost = 0, waste = 0, cr = 0, den = 0;
  ss.forEach((s) => { cost += s.cost; waste += s.waste; cr += s.tok.cr || 0; den += s.den; });
  const hit = den ? cr / den : 0, wr = cost ? waste / cost : 0, score = thrift(hit, wr);
  const label = F.range === 'all' ? 'all time' : `the last ${F.range} days`;
  const none = !report.sessions.length;
  $('#repLead').textContent = none ? `No Claude Code sessions yet. Mallow reads them from ${report.root || 'your .claude/projects folder'} as you use Claude Code.`
    : ss.length ? `${ss.length} session${ss.length === 1 ? '' : 's'} from ${label}. Usage is in relative units: cached reads are cheap, cache writes and output cost more, and bigger models multiply it.`
    : `No sessions from ${label}${F.q ? ' match your search' : ''}.`;
  $('#dialV').textContent = ss.length ? score : '-';
  $('#dialArc').setAttribute('stroke-dasharray', `${(ss.length ? score : 0) / 100 * 276.5} 277`);
  $('#fHit').textContent = ss.length ? pct(hit) : '-';
  $('#fUse').textContent = fmtU(cost);
  $('#fWaste').textContent = fmtU(waste);
  $('#fCount').textContent = ss.length;

  const all = []; ss.forEach((s) => s.findings.forEach((f) => all.push([f, s])));
  const top = all.filter(([f]) => f.units > 0).sort((x, y) => y[0].units - x[0].units).slice(0, 8);
  const kinds = {}; all.forEach(([f]) => { kinds[f.kind] = (kinds[f.kind] || 0) + 1; });
  let h = top.length ? '' : `<div class="box-empty">${ss.length ? 'Nothing big to report here. Mallow approves.' : 'Nothing to show yet.'}</div>`;
  top.forEach(([f, s]) => { h += findingHTML(f, s, true); });
  const rest = Object.entries(kinds).filter(([k]) => !top.some(([f]) => f.kind === k));
  if (rest.length) h += `<p class="also">Also seen: ${rest.map(([k, n]) => `${esc(k.toLowerCase())} (${n})`).join(', ')}. Open a session for details.</p>`;
  $('#findings').innerHTML = h;

  const byP = {}; ss.forEach((s) => (byP[s.project] = byP[s.project] || []).push(s));
  const order = Object.entries(byP).sort((x, y) => y[1].reduce((t, s) => t + s.cost, 0) - x[1].reduce((t, s) => t + s.cost, 0));
  const sorter = { new: (x, y) => Date.parse(y.end) - Date.parse(x.end), cost: (x, y) => y.cost - x.cost, waste: (x, y) => y.waste - x.waste }[F.sort];
  const narrowed = F.range !== 'all' || F.q || F.project !== 'all';
  h = order.length ? '' : `<div class="box-empty">${none ? 'Your sessions will be listed here.' : narrowed ? 'No sessions match. Try a wider range or clear the search.' : 'No sessions to show.'}</div>`;
  const PAGE = 25;
  order.forEach(([p, list]) => {
    h += `<div class="proj"><div class="proj-head"><h3 title="${esc(p)}">${esc(base(p))}</h3><span class="mini">${fmtU(list.reduce((t, s) => t + s.cost, 0))} units</span><button class="btn small ghost" data-export="${esc(p)}">Export for Claude</button></div>`;
    const sorted = list.sort(sorter), shown = showAll.has(p) ? sorted : sorted.slice(0, PAGE);
    shown.forEach((s) => { h += sessionHTML(s); });
    if (shown.length < sorted.length) h += `<button class="btn small ghost more" data-more="${esc(p)}">Show all ${sorted.length} sessions</button>`;
    h += '</div>';
  });
  // keep open sessions open when the report refreshes
  const open = new Set([...document.querySelectorAll('details.sess[open]')].map((d) => d.dataset.sid));
  $('#sessions').innerHTML = h;
  document.querySelectorAll('details.sess').forEach((d) => {
    if (open.has(d.dataset.sid)) { d.dataset.quiet = '1'; d.open = true; }
  });
  document.querySelectorAll('details.sess').forEach((d) => d.addEventListener('toggle', () => {
    if (d.dataset.quiet) { delete d.dataset.quiet; return; }
    if (!d.open) return;
    const s = report.sessions.find((x) => x.id === d.dataset.sid);
    if (s) say(s.findings.length ? `${esc(s.findings[0].detail)}.` : 'That one looks clean.', 3500);
  }));
}

function chipFor(w) { return w === 'claude' ? '<span class="chip claude">Claude can fix</span>' : w === 'you' ? '<span class="chip you">Your habit</span>' : w === 'info' ? '<span class="chip info">fyi</span>' : ''; }
function findingHTML(f, s, clickable) {
  const tag = clickable ? 'button' : 'div';
  return `<${tag} class="finding${clickable ? '' : ' static'}" ${clickable ? `data-sid="${esc(s.id)}" type="button"` : ''}>
    <span class="ico${f.who === 'claude' ? ' claude' : ''}">${icon(KIND_ICON[f.kind] || 'other', 24)}</span>
    <span class="main"><span class="k">${esc(f.kind)} ${chipFor(f.who)}</span><span class="d" style="display:block">${esc(f.detail)}</span><span class="f" style="display:block">${esc(f.fix)}</span>${clickable ? `<span class="in" style="display:block">in "${esc(s.title)}"</span>` : ''}</span>
    ${f.units ? `<span class="amt">${fmtU(f.units)}<small>units</small></span>` : ''}</${tag}>`;
}
function sessionHTML(s) {
  const t = s.tok, cw = (t.cw5 || 0) + (t.cw1h || 0);
  const extras = [`${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`, `${s.calls} model calls`];
  if (s.subCalls) extras.push(`${s.subCalls} in subagents (${pct(s.subShare)} of usage)`);
  if (s.compactions) extras.push(`${s.compactions} compactions`);
  if (s.branch) extras.push(`branch ${s.branch}`);
  return `<details class="sess" id="s-${esc(s.id)}" data-sid="${esc(s.id)}"><summary>
    <img class="mood" src="sprites/${MOOD_SPRITE[s.mood] || 'm-idle'}.png" alt="">
    <span class="t">${esc(s.title)}</span><span class="mini">${fmtDate(s.end)}</span><span class="mini">${fmtDur(s.minutes)}</span>
    <span class="mini">${fmtU(s.cost)} units</span><span class="mini${s.hit < .7 ? ' bad' : ''}">cache ${pct(s.hit)}</span>
    ${s.findings.length ? `<span class="mini bad">${s.findings.length} flag${s.findings.length > 1 ? 's' : ''}</span>` : ''}</summary>
    <div class="sess-body"><div class="tiles">
      <div><span>Uncached in</span><b>${(t.in || 0).toLocaleString()}</b></div><div><span>Cache writes</span><b>${cw.toLocaleString()}</b></div>
      <div><span>Cache reads</span><b>${(t.cr || 0).toLocaleString()}</b></div><div><span>Output</span><b>${(t.out || 0).toLocaleString()}</b></div>
      <div><span>Peak context</span><b>${s.peak.toLocaleString()}</b></div><div><span>Start context</span><b>${s.baseline.toLocaleString()}</b></div></div>
    <div class="note">${esc(extras.join(' · '))}<br>Models: ${esc(s.models.map(([m, u]) => prettyModel(m) + ' ' + pct(u)).join(', '))}${s.tools.length ? '<br>Tools: ' + esc(s.tools.map(([n, c]) => n + ' ' + c).join(', ')) : ''}</div>
    ${s.findings.map((f) => findingHTML(f, s, false)).join('')}</div></details>`;
}

function prettyModel(m) { return m.replace(/^claude-/, '').replace(/(\d+)-(\d+)/g, '$1.$2').split('-').map((w) => /^[a-z]+$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(' '); }

function setRange(v) {
  F.range = v;
  document.querySelectorAll('#range button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
}
document.querySelectorAll('#range button').forEach((b) => b.addEventListener('click', () => { setRange(b.dataset.v); renderReport(); }));
$('#fProject').addEventListener('change', (e) => { F.project = e.target.value; renderReport(); });
$('#fSort').addEventListener('change', (e) => { F.sort = e.target.value; renderReport(); });
let searchTimer = 0;
$('#fQ').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { F.q = e.target.value.trim().toLowerCase(); renderReport(); }, 200);
});
$('#sessions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-more]'); if (!b) return;
  showAll.add(b.dataset.more); renderReport();
});
document.addEventListener('click', (e) => {
  const ex = e.target.closest('[data-export]'); if (ex) { openExport(ex.dataset.export); return; }
  const fd = e.target.closest('button.finding[data-sid]');
  if (fd) { const d = document.getElementById('s-' + fd.dataset.sid); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); } }
});

/* export */
function brief(ss, scope) {
  const byP = {}; ss.forEach((s) => (byP[s.project] = byP[s.project] || []).push(s));
  const parts = [];
  Object.entries(byP).forEach(([p, list]) => {
    const items = [];
    const bases = list.map((s) => s.baseline).filter(Boolean).sort((a, b) => a - b);
    const med = bases.length ? bases[Math.floor(bases.length / 2)] : 0;
    if (med >= 30000) items.push(`Sessions here start with about ${kTok(med)} tokens loaded before any work. Review CLAUDE.md and anything it imports, and cut what isn't needed in every session. Then list the MCP servers, plugins and skills this setup loads, and point out any this project doesn't use.`);
    const big = {};
    list.forEach((s) => s.findings.forEach((f) => {
      if (f.kind === 'Big tool result' && f.who === 'claude') {
        const key = f.tool + '|' + f.target;
        const e = big[key] = big[key] || { tool: f.tool, target: f.target || '(no target)', toks: 0, n: 0 };
        e.toks = Math.max(e.toks, f.toks); e.n++;
      }
    }));
    const groups = { Read: [], Bash: [], other: [] };
    Object.values(big).sort((a, b) => b.toks - a.toks).forEach((e) => groups[e.tool === 'Read' ? 'Read' : e.tool === 'Bash' ? 'Bash' : 'other'].push(e));
    const li = (e) => `   - ${e.tool === 'Read' || e.tool === 'Bash' ? '' : e.tool + ': '}${e.target} (about ${kTok(e.toks)} tokens${e.n > 1 ? ', ' + e.n + ' times' : ''})`;
    if (groups.Read.length) items.push(`These files were read in full and were large:\n${groups.Read.slice(0, 6).map(li).join('\n')}\n   Add a CLAUDE.md rule to read them by line range, and a few lines outlining what is in each so a full read is rarely needed. If one is this big because it does too much, suggest how to split it.`);
    if (groups.Bash.length) items.push(`These commands printed very long output:\n${groups.Bash.slice(0, 5).map(li).join('\n')}\n   Add a CLAUDE.md note on how to run each one quietly (a quiet flag, or piping through tail or grep), and use that form from now on.`);
    if (groups.other.length) items.push(`These tool calls returned large results:\n${groups.other.slice(0, 5).map(li).join('\n')}\n   Add guidance for narrowing them, like tighter search patterns or result limits.`);
    const rr = {}; list.forEach((s) => s.findings.forEach((f) => { if (f.kind === 'Re-read file') rr[f.target] = Math.max(rr[f.target] || 0, f.count); }));
    const rre = Object.entries(rr).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (rre.length) items.push(`These files were re-read many times in one session:\n${rre.map(([t, n]) => `   - ${t} (${n} times)`).join('\n')}\n   Add a short summary of each to CLAUDE.md covering what lives where.`);
    const subs = list.filter((s) => s.findings.some((f) => f.kind === 'Subagent heavy')).length;
    if (subs) items.push(`Subagents used most of the usage in ${subs} session${subs > 1 ? 's' : ''}. Add a CLAUDE.md rule: use subagents for wide searches across many files, and handle quick lookups directly.`);
    if (!items.length) return;
    const d0 = fmtDay(list.map((s) => s.start).sort()[0]), ends = list.map((s) => s.end).sort(), d1 = fmtDay(ends[ends.length - 1]);
    const when = d0 === d1 ? `on ${d0}` : `from ${d0} to ${d1}`;
    parts.push(`## ${base(p)}\nPath: ${p}\nBased on ${list.length} Claude Code session${list.length > 1 ? 's' : ''} ${when}.\n\n` + items.map((t, i) => `${i + 1}. ${t}`).join('\n\n'));
  });
  if (!parts.length) return `# Claude Code usage review\n\nNothing in ${scope} needs changes from Claude right now.\n`;
  return `# Claude Code usage review\n\nThese are patterns from my recent sessions that waste usage. Please make the changes below. Keep each new CLAUDE.md rule to one line, and show me the diff before committing.\n\n` + parts.join('\n\n') + '\n';
}
let briefText = '', briefName = '';
function openExport(project) {
  const ss = project ? filtered().filter((s) => s.project === project) : filtered();
  const scope = project ? base(project) : (F.project === 'all' ? 'all projects' : base(F.project));
  briefText = brief(ss, scope);
  briefName = 'claude-usage-brief-' + (project ? base(project) : F.project === 'all' ? 'all' : base(F.project)).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.md';
  $('#expScope').textContent = `${scope} · ${ss.length} session${ss.length === 1 ? '' : 's'} · only fixes Claude can make`;
  $('#expText').value = briefText; $('#expOk').textContent = '';
  $('#exp').showModal();
}
$('#exportAll').addEventListener('click', () => openExport(F.project === 'all' ? null : F.project));
$('#expCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(briefText); } catch (e) { const t = $('#expText'); t.select(); document.execCommand('copy'); }
  $('#expOk').textContent = 'Copied. Paste it into your project.';
});
$('#expDl').addEventListener('click', () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([briefText], { type: 'text/markdown' }));
  a.download = briefName; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); $('#expOk').textContent = 'Saved ' + briefName;
});
$('#expClose').addEventListener('click', () => $('#exp').close());

/* ================================================================ start */
function frame(now) {
  const dt = Math.min(.05, (now - (frame.last || now)) / 1000);
  frame.last = now;
  mallowTick(now, dt);
  babyTick(now, dt);
  dragonTick(now);
  bugTick(dt);
  signTick();
  const spin = document.querySelector('.wheel-spin');
  if (spin) {
    const runners = (M.inWheel && M.mode === 'work' ? 1 : 0) + [...babies.values()].filter((b) => b.inWheel).length;
    spin.classList.toggle('on', runners > 0);
    spin.classList.toggle('fast', runners >= 3);
  }
  bubbleTick(now);
  badgeTick();
  tagsTick(now);
  requestAnimationFrame(frame);
}

async function start() {
  try { await loadSprites(); } catch (e) { $('#subline').textContent = 'Mallow could not load his pictures. Open him with the launcher.'; return; }
  M.actor = new Actor('mallow', { face: 'normal' }, 'mallow');
  M.actor.x = 520;
  applyTheme(true);
  $('#bSound').setAttribute('aria-pressed', String(settings.sound));
  $('#bSound').firstChild.textContent = settings.sound ? 'Sound on ' : 'Sound off ';
  updateSeedNote();
  setIdle(1500);
  requestAnimationFrame(frame);
  poll();
  (async function pollLoop() { await poll(); setTimeout(pollLoop, 1000); })();   // one request at a time
  setInterval(cacheTick, 1000);
  setInterval(() => { applyTheme(false); updateClock(); }, 20000);
  loadReport();
  setInterval(loadReport, 5 * 60 * 1000);
  harnessCall();
  setInterval(() => harnessCall(), 60 * 1000);
  setTimeout(() => say(hasAlerts() ? 'Psst, something needs a look. Click me.' : pick(['Hi! I\'m Mallow.', 'Hello again!', 'Ready when you are.']), 2600), 600);
}
start();
