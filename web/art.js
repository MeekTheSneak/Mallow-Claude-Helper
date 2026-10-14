/* Mallow artwork: hand-made sprites (web/sprites) placed in an SVG scene.
   sprites.json holds each sprite's pixel size and measured anchors:
   headX / headW = where the head sits and how wide it is, facing = which way it looks. */
'use strict';

const INK = '#5A3424';
let SPR = {};                                  // filled from sprites/sprites.json before start()

async function loadSprites() {
  const r = await fetch('sprites/sprites.json');
  SPR = await r.json();
  // warm the image cache so the first pose changes don't flash
  for (const name of Object.keys(SPR)) if (!name.startsWith('room-')) { const i = new Image(); i.src = `sprites/${name}.png`; }
}

/* world height (scene units) of each kind of character, measured on a reference pose */
const WORLD = { mallow: 118, baby: 64, dragon: 212 };
function kFor(kind) {
  const ref = kind === 'mallow' ? 'm-idle' : kind === 'baby' ? 'b-ginger-idle' : 'd-awake';
  return WORLD[kind] / SPR[ref].h;
}

/* where hats and gear sit. w = width as a share of head width; dy = share of the sprite's height
   from the top to the item's bottom edge (head items) or center (eye and neck items); dx = sideways nudge */
const WEAR = {
  'h-party': { w: .40, dy: .17 }, 'h-crown': { w: .50, dy: .15 }, 'h-flowers': { w: .84, dy: .17 },
  'h-bow': { w: .36, dy: .16, dx: .30 }, 'h-beanie': { w: .86, dy: .30 }, 'h-chef': { w: .60, dy: .18 },
  'h-helmet': { w: 1.06, dy: .40 },
  'g-explorer': { w: 1.02, dy: .25 }, 'g-hardhat': { w: .84, dy: .25 }, 'g-cap': { w: .84, dy: .24 },
  'g-guard': { w: .92, dy: .40 }, 'g-knight': { w: .9, dy: .40 },
  'g-goggles': { w: .80, dy: .45, eyes: true }, 'g-glasses': { w: .78, dy: .46, eyes: true },
  'g-scarf': { w: .80, dy: .66, neck: true }, 'g-bandana': { w: .56, dy: .70, neck: true },
};
/* poses where a raised sword pulls the measured head position sideways: head center as a share of width */
const HEAD_FIX = { 'k-swing': .57, 'k-victory': .57,
  // side views face left: the head is toward the front, not in the middle of the body
  'm-walk1': .38, 'm-walk2': .38, 'm-run1': .38, 'm-run2': .38,
  'b-ginger-run': .36, 'b-cream-run': .36, 'b-cocoa-run': .36, 'b-smoke-run': .36 };
const HAT_SPRITE = { party: 'h-party', crown: 'h-crown', flowers: 'h-flowers', bow: 'h-bow', beanie: 'h-beanie', chef: 'h-chef', helmet: 'h-helmet' };
const GEAR_SPRITE = { explore: 'g-explorer', plan: 'g-hardhat', test: 'g-goggles', review: 'g-glasses', docs: 'g-glasses', dev: 'g-cap', security: 'g-guard', knight: 'g-knight' };

/* Which picture to show for Mallow right now. */
function mallowPose(look, cls, frame, blink, knight) {
  if (cls === 'sleep' || look.face === 'sleep') return 'm-sleep';
  if (cls === 'walk') return frame ? 'm-walk2' : 'm-walk1';
  if (cls === 'run') return frame ? 'm-run2' : 'm-run1';
  if (knight) {
    if (cls === 'fight') return frame ? 'k-ready' : 'k-swing';
    if (cls === 'cheer' || look.face === 'cheer') return 'k-victory';
    if (look.item === 'sword' && cls === 'groom') return 'k-polish';
    if (cls === 'idle' && !look.item && look.face === 'normal') return blink ? 'm-blink' : 'k-ready';
  }
  if (cls === 'wave') return 'm-wave';
  if (cls === 'cheer') return 'm-cheer';
  if (cls === 'dance') return 'm-dance';
  if (cls === 'stretch') return 'm-stretch';
  if (cls === 'chew' || look.item === 'seed') return 'm-eat';
  if (cls === 'alertpose' || look.item === 'sign') return 'm-alert';
  if (look.item === 'mug') return 'm-sip';
  if (look.item === 'book') return 'm-read';
  if (look.face === 'worried') return 'm-worried';
  if (look.face === 'happy' || look.face === 'cheer') return 'm-blink';
  return blink ? 'm-blink' : 'm-idle';
}

function babyPose(look, cls) {
  const f = look.fur || 'ginger';
  if (cls === 'run' || cls === 'walk') return `b-${f}-run`;
  if (cls.startsWith('wave')) return `b-${f}-wave`;
  if (cls === 'fight') return `b-${f}-sword`;
  return `b-${f}-idle`;
}

/* An overlay (hat or gear) drawn on a sprite, in the sprite's own local box. */
function wearMarkup(item, spr, k, w, h, ref, name) {
  const meta = SPR[item], p = WEAR[item];
  if (!meta || !p) return '';
  if (p.eyes && spr.facing !== 'front') return '';            // glasses only make sense on a front-facing face
  // size and height come from the character's reference pose, so raised arms or a sign don't stretch the hat
  const headW = ref ? ref.headW : spr.headW, refH = (ref ? ref.h : spr.h) * k;
  const iw = headW * k * p.w, ih = iw * meta.h / meta.w;
  const headX = HEAD_FIX[name] ? HEAD_FIX[name] * spr.w : spr.headX;
  let cx = (headX - spr.w / 2) * k + (p.dx || 0) * headW * k;
  if (p.neck) cx = 0;
  const y = p.eyes || p.neck ? -h + p.dy * refH - ih / 2 : -h + p.dy * refH - ih;
  return `<image href="sprites/${item}.png" x="${(cx - iw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}"/>`;
}

/* Full markup for a character standing with its feet at (0, 0). */
function characterMarkup(name, opts) {
  const spr = SPR[name];
  if (!spr) return '';
  const k = opts.k;
  const w = spr.w * k, h = spr.h * k;
  const mirror = (spr.facing === 'left' && opts.faceRight) || (spr.facing === 'right' && !opts.faceRight);
  let s = opts.shadow === false ? '' : `<ellipse class="shadow" cx="0" cy="-1" rx="${(w * .34).toFixed(1)}" ry="${Math.max(3, w * .05).toFixed(1)}"/>`;
  s += `<g class="spr"><g${mirror ? ' transform="scale(-1 1)"' : ''}>`;
  s += `<image href="sprites/${name}.png" x="${(-w / 2).toFixed(1)}" y="${(-h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  const ref = opts.ref ? SPR[opts.ref] : null;
  for (const item of opts.wear || []) s += wearMarkup(item, spr, k, w, h, ref, name);
  s += `</g></g>`;
  return s;
}

/* A prop or critter with its base at (0, 0), scaled to a target height in scene units. */
function propMarkup(name, height, extraClass = '') {
  const m = SPR[name];
  if (!m) return '';
  const h = height, w = m.w * h / m.h;
  return `<image class="${extraClass}" href="sprites/${name}.png" x="${(-w / 2).toFixed(1)}" y="${(-h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
}
function propWidth(name, height) { const m = SPR[name]; return m ? m.w * height / m.h : 0; }

/* tiny icons for the activity badge and the report, drawn in a 24 x 24 box */
const ICONS = {
  edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  bash: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10l3 2-3 2M12 15h5"/>',
  read: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"/>',
  agent: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 19c1-3 3-4 5-4s4 1 5 4M11 19c1-3 3-4 5-4s4 1 5 4"/>',
  plan: '<path d="M7 4h10v16H7z"/><path d="M10 9h4M10 13h4M10 17h2"/>',
  think: '<path d="M7 17a5 5 0 1 1 3-9 5 5 0 0 1 9 3 4 4 0 0 1-2 6z"/><circle cx="6" cy="21" r="1.2"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
};
function icon(kind, size = 20, color = INK) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind] || ICONS.other}</svg>`;
}
