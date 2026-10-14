/* Rooms: a painted background plus the props characters interact with.
   The scene is 1000 x 428 units (the backgrounds are 1916 x 821 px). */
'use strict';

const SCENE_H = 428;
/* Where things are. FLOOR is where characters walk; props sit a little further back. */
const LAYOUT = {
  home: {
    floor: 372, back: 352,
    wheel: { cx: 185, cy: 214, d: 250 },        // d = outer diameter
    house: { x: 868, h: 158 }, bowl: { x: 692, h: 40 }, bottle: { x: 736, top: 196, h: 124 },
    plant: { x: 28, h: 96 }, clock: { x: 880, y: 92, d: 78 },
    stroll: [380, 760], door: 868, drink: 738, work: 342, badge: [185, 64], sign: 410, bugRange: [470, 770],
  },
  knight: {
    floor: 368, back: 340,
    door: 112, work: 560, dragon: { x: 812, y: 366 }, stroll: [220, 560], badge: [560, 42], sign: 420,
    bugRange: [180, 420], fightSpots: [494, 638, 448, 404, 362, 322],
  },
};
function L() { return theme === 'knight' ? LAYOUT.knight : LAYOUT.home; }

/* The wheel's rim is ~13% of its radius, so the running surface is a bit inside the outer edge. */
function wheelGeom() {
  const w = LAYOUT.home.wheel, r = w.d / 2;
  return { cx: w.cx, cy: w.cy, r, rin: r * 0.865 };
}

function roomMarkup(t) {
  const bg = `<image href="sprites/room-${t}.jpg" x="0" y="0" width="1000" height="${SCENE_H}" preserveAspectRatio="none"/>`;
  if (t === 'knight') return bg;
  const H = LAYOUT.home;
  const tint = t === 'night' ? ' class="night-prop"' : '';
  let s = bg + `<g${tint}>`;
  // wall clock with real hands
  const c = H.clock;
  s += `<g transform="translate(${c.x} ${c.y + c.d / 2})">${propMarkup('p-clock', c.d)}</g>`;
  s += `<g transform="translate(${c.x} ${c.y})"><path class="clock-h" d="M0 0 V${-c.d * .2}" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/><path class="clock-m" d="M0 0 V${-c.d * .3}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/><circle r="3.6" fill="#E98B8B" stroke="${INK}" stroke-width="2"/></g>`;
  // water bottle on the wall, hung from a little hook
  const b = H.bottle;
  s += `<g transform="translate(${b.x} ${b.top + b.h})">${propMarkup('p-bottle', b.h)}</g>`;
  // floor props, back row
  s += `<g transform="translate(${H.plant.x} ${H.back})">${floorShadow(propWidth('p-plant', H.plant.h) * .7)}${propMarkup('p-plant', H.plant.h)}</g>`;
  s += `<g transform="translate(${H.house.x} ${H.back})">${floorShadow(propWidth('p-house', H.house.h) * .9)}${propMarkup('p-house', H.house.h)}</g>`;
  s += `<g transform="translate(${H.bowl.x} ${H.back + 10})">${floorShadow(propWidth('p-bowl', H.bowl.h) * .9)}${propMarkup('p-bowl', H.bowl.h)}</g>`;
  return s + `</g>`;
}

function floorShadow(w) { return `<ellipse cx="0" cy="-1" rx="${(w / 2).toFixed(1)}" ry="${Math.max(3, w * .06).toFixed(1)}" fill="rgba(60,30,10,.16)"/>`; }

/* the stand sits behind the characters; the wheel itself spins in front of the stand */
function wheelMarkup(t) {
  if (t === 'knight') return '';
  const g = wheelGeom(), W = SPR['wheel'], S = SPR['wheel-stand'];
  const k = g.r * 2 / W.w;                                         // stand and wheel were drawn at the same scale
  const sw = S.w * k, sh = S.h * k;
  const tint = t === 'night' ? ' class="night-prop"' : '';
  let s = `<g${tint}>`;
  s += `<g transform="translate(${g.cx} ${g.cy + sh})">${floorShadow(sw * .9)}</g>`;
  s += `<image href="sprites/wheel-stand.png" x="${(g.cx - sw / 2).toFixed(1)}" y="${g.cy.toFixed(1)}" width="${sw.toFixed(1)}" height="${sh.toFixed(1)}"/>`;
  s += `<g class="wheel-spin" style="transform-origin:${g.cx}px ${g.cy}px"><image href="sprites/wheel.png" x="${(g.cx - g.r).toFixed(1)}" y="${(g.cy - W.h * k / 2).toFixed(1)}" width="${(g.r * 2).toFixed(1)}" height="${(W.h * k).toFixed(1)}"/></g>`;
  return s + `</g>`;
}
