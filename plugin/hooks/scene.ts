// Draws Mallow's room as one SVG: the room, his wheel or the dragon, Mallow, his crew.
// Animation is SMIL inside the SVG (frames swap by opacity, the wheel turns), so the
// pane only redraws when something actually changes. A pane's SVG is capped at
// 131,072 characters; every picture is defined once in <defs> and reused.
import { SPR } from './assets'
import type { Baby, Mode } from '../types'

export const W = 560
export const H = 240
const FLOOR = 208
const LIMIT = 130_000

type Look = {
  theme: 'day' | 'night' | 'knight'
  mode: Mode
  outfit: string
  crew: Baby[]
  bug: boolean
  nonce: number
}

// world size per encoded pixel, so each kind keeps its size relative to the others
const hOf = (n: string) => SPR[n]?.h ?? 100
const U = { m: 66 / hOf('m-idle'), b: 36 / hOf('b-ginger-idle'), d: 112 / hOf('d-battle1') }

const WEAR: Record<string, { w: number; dy: number; dx?: number; ex?: number; eyes?: boolean; neck?: boolean }> = {
  'h-party': { w: 0.4, dy: 0.17 }, 'h-crown': { w: 0.5, dy: 0.15 }, 'h-flowers': { w: 0.84, dy: 0.17 },
  'h-bow': { w: 0.36, dy: 0.16, dx: 0.3 }, 'h-beanie': { w: 0.86, dy: 0.3 }, 'h-chef': { w: 0.6, dy: 0.18 },
  'h-helmet': { w: 1.06, dy: 0.4 },
  'g-explorer': { w: 1.02, dy: 0.25 }, 'g-hardhat': { w: 0.84, dy: 0.25 }, 'g-cap': { w: 0.84, dy: 0.24 },
  'g-guard': { w: 0.92, dy: 0.4 }, 'g-knight': { w: 0.9, dy: 0.4 },
  'g-goggles': { w: 0.8, dy: 0.45, eyes: true }, 'g-glasses': { w: 0.78, dy: 0.46, eyes: true },
  'gs-explorer': { w: 0.94, dy: 0.31 }, 'gs-hardhat': { w: 0.84, dy: 0.3 }, 'gs-cap': { w: 0.9, dy: 0.29, dx: -0.08 },
  'gs-guard': { w: 0.9, dy: 0.46 }, 'gs-knight': { w: 0.9, dy: 0.47 },
  'gs-goggles': { w: 0.44, dy: 0.5, eyes: true, ex: 0.04 }, 'gs-glasses': { w: 0.44, dy: 0.51, eyes: true, ex: 0.04 },
}
const SIDE_GEAR: Record<string, string> = {
  'g-explorer': 'gs-explorer', 'g-hardhat': 'gs-hardhat', 'g-cap': 'gs-cap', 'g-guard': 'gs-guard',
  'g-knight': 'gs-knight', 'g-goggles': 'gs-goggles', 'g-glasses': 'gs-glasses',
}
const HEAD_FIX: Record<string, number> = { 'k-swing': 0.57, 'k-victory': 0.57 }
const SIDE_HEAD: Record<string, number> = { m: -0.06, b: -0.2 }
export const GEAR: Record<string, string> = {
  explore: 'g-explorer', plan: 'g-hardhat', test: 'g-goggles', review: 'g-glasses', docs: 'g-glasses',
  dev: 'g-cap', security: 'g-guard',
}
const HAT: Record<string, string> = {
  party: 'h-party', crown: 'h-crown', flowers: 'h-flowers', bow: 'h-bow', beanie: 'h-beanie', chef: 'h-chef',
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

class Svg {
  used = new Set<string>()
  body: string[] = []

  use(name: string): string {
    if (!SPR[name]) return ''
    this.used.add(name)
    return `#${name}`
  }

  /** The one wearable on a character, in that character's own pixels. */
  wear(item: string, name: string, ref: string): string {
    const spr = SPR[name], r = SPR[ref]
    if (!spr || !r) return ''
    const sideView = spr.facing === 'left' && spr.anchorX != null
    const sideName = sideView ? SIDE_GEAR[item] : undefined
    const side = sideName && SPR[sideName] ? sideName : null
    if (side) item = side
    const meta = SPR[item], p = WEAR[item]
    if (!meta || !p) return ''
    if (p.eyes && !side && spr.facing !== 'front') return ''
    const headW = r.headW
    const iw = headW * p.w, ih = (iw * meta.h) / meta.w
    const ax = spr.anchorX ?? spr.w / 2
    let cx: number
    if (sideView) cx = ((SIDE_HEAD[name.charAt(0)] ?? -0.15) + (p.dx ?? 0) + (p.ex ?? 0)) * headW
    else {
      const fix = HEAD_FIX[name] ?? HEAD_FIX[name.replace(/\d$/, '')]
      cx = ((fix ? fix * spr.w : spr.headX) - ax) + (p.dx ?? 0) * headW
    }
    if (p.neck) cx = 0
    const top = -spr.h, hh = sideView ? spr.h : r.h
    const y = p.eyes || p.neck ? top + p.dy * hh - ih / 2 : top + p.dy * hh - ih
    return `<use href="${this.use(item)}" transform="translate(${f1(cx - iw / 2)} ${f1(y)}) scale(${(iw / meta.w).toFixed(3)})"/>`
  }

  /** A character with its feet at (0,0) in its own pixels. */
  figure(name: string, wear: string[], ref: string, faceRight: boolean): string {
    const spr = SPR[name]
    if (!spr) return ''
    const mirror = (spr.facing === 'left' && faceRight) || (spr.facing === 'right' && !faceRight)
    const ax = spr.anchorX ?? spr.w / 2
    let s = `<g${mirror ? ' transform="scale(-1 1)"' : ''}><use href="${this.use(name)}" x="${f1(-ax)}" y="${-spr.h}"/>`
    for (const item of wear) s += this.wear(item, name, ref)
    return s + '</g>'
  }

  /** Frames shown one after another, forever. `times` are milliseconds per frame. */
  frames(names: string[], times: number[], draw: (n: string) => string): string {
    if (names.length === 1) return draw(names[0] ?? '')
    const total = times.reduce((a, b) => a + b, 0)
    let at = 0, s = ''
    names.forEach((n, i) => {
      const t = times[i] ?? 0
      const a = at / total, b = (at + t) / total
      at += t
      const vals = i === 0 ? '1;0' : i === names.length - 1 ? '0;1' : '0;1;0'
      const keys = i === 0 ? `0;${b.toFixed(4)}` : i === names.length - 1 ? `0;${a.toFixed(4)}` : `0;${a.toFixed(4)};${b.toFixed(4)}`
      s += `<g opacity="${i === 0 ? 1 : 0}"><animate attributeName="opacity" calcMode="discrete" dur="${total}ms" repeatCount="indefinite" values="${vals}" keyTimes="${keys}"/>${draw(n)}</g>`
    })
    return s
  }

  /** Place something drawn in a kind's own pixels into the room. */
  place(x: number, y: number, scale: number, inner: string, rot = 0): string {
    return `<g transform="translate(${f1(x)} ${f1(y)})${rot ? ` rotate(${f1(rot)})` : ''} scale(${scale.toFixed(4)})">${inner}</g>`
  }

  prop(name: string, x: number, baseY: number, height: number, extra = ''): string {
    const spr = SPR[name]
    if (!spr) return ''
    const s = height / spr.h
    return `<g transform="translate(${f1(x - (spr.w * s) / 2)} ${f1(baseY - height)}) scale(${s.toFixed(4)})"${extra}><use href="${this.use(name)}"/></g>`
  }

  shadow(x: number, y: number, rx: number): string {
    return `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(rx)}" ry="${f1(Math.max(2, rx * 0.16))}" fill="rgba(60,30,10,.16)"/>`
  }

  done(alt: string, budgetCheck = true): string {
    const defs = [...this.used].map(n => {
      const s = SPR[n]
      if (!s) return ''
      return `<image id="${n}" width="${s.w}" height="${s.h}" href="data:image/${s.mime};base64,${s.d}"/>`
    }).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"><title>${alt}</title>` +
      `<defs><filter id="night"><feColorMatrix type="matrix" values="0.72 0 0 0 0 0 0.76 0 0 0 0 0 0.95 0 0 0 0 0 1 0"/></filter>` +
      `<path id="heart" d="M0 3C-4-3-10 1-6 6L0 11 6 6C10 1 4-3 0 3Z" fill="#E98B8B" stroke="#5A3424" stroke-width="1.5"/></defs>` +
      `<defs>${defs}</defs>${this.body.join('')}</svg>`
    return budgetCheck && svg.length > LIMIT ? '' : svg
  }
}

function heartsFx(x: number, y: number, nonce: number): string {
  // a fresh nonce makes a new drawing, so the hearts play again
  return [0, 1, 2].map(i => `<g opacity="0" data-n="${nonce}"><use href="#heart" transform="translate(${x + (i - 1) * 12} ${y})"/>` +
    `<animateTransform attributeName="transform" type="translate" from="0 0" to="${(i - 1) * 6} -34" begin="${i * 0.25}s" dur="1.6s" fill="freeze"/>` +
    `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.7;1" begin="${i * 0.25}s" dur="1.6s" fill="freeze"/></g>`).join('')
}

function zzz(x: number, y: number): string {
  return [0, 1].map(i => `<text x="${x + i * 8}" y="${y}" font-family="sans-serif" font-weight="700" font-size="${12 + i * 3}" fill="#5A3424" opacity="0">z` +
    `<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${i * 1.2}s" repeatCount="indefinite"/>` +
    `<animateTransform attributeName="transform" type="translate" values="0 0;4 -16" dur="2.4s" begin="${i * 1.2}s" repeatCount="indefinite"/></text>`).join('')
}

/** Mallow's main pose for a mode, used by the terminal's single picture too. */
export function poseFor(theme: string, mode: Mode): string {
  const knight = theme === 'knight'
  switch (mode) {
    case 'work': return knight ? 'k-swing2' : 'm-run1'
    case 'turn': return knight ? 'k-victory' : 'm-wave'
    case 'sleep': return 'm-sleep'
    case 'alert': return 'm-alert'
    case 'eat': return 'm-eat'
    case 'dance': return 'm-dance'
    case 'pet': return 'm-blink'
    default: return knight ? 'k-ready' : 'm-idle'
  }
}

export function sceneSvg(look: Look, alt: string): string {
  // try the full drawing, then lighter ones, until it fits the pane's limit
  for (const lite of [0, 1, 2]) {
    const s = draw(look, alt, lite)
    if (s) return s
  }
  return ''
}

function draw(look: Look, alt: string, lite: number): string {
  const g = new Svg()
  const { theme, mode } = look
  const knight = theme === 'knight'
  const tint = theme === 'night' ? ' filter="url(#night)"' : ''
  const b = g.body
  b.push(`<use href="${g.use(`room-${theme}`)}"/>`)

  const hat = knight ? 'h-helmet' : HAT[look.outfit]
  const mWear = (pose: string) => (pose === 'm-sleep' || /^k-swing\d$/.test(pose) || !hat ? [] : [hat])
  const mallow = (pose: string, faceRight = false) => g.figure(pose, mWear(pose), 'm-idle', faceRight)
  const working = mode === 'work'
  const crew = look.crew.slice(0, lite ? 2 : 3)

  if (!knight) {
    // furniture
    b.push(`<g${tint}>`)
    b.push(g.shadow(16, 197, 18) + g.prop('p-plant', 16, 197, 54))
    b.push(g.shadow(486, 197, 40) + g.prop('p-house', 486, 197, 88))
    b.push(g.prop('p-bottle', 412, 179, 69))
    b.push(g.shadow(388, 203, 14) + g.prop('p-bowl', 388, 203, 22))
    b.push('</g>')
    // the wheel: the stand behind, the wheel turning in front while Claude works
    const cx = 104, cy = 120, r = 70, rin = r * 0.865
    const wh = SPR['wheel'], st = SPR['wheel-stand']
    if (!wh || !st) return ''
    const wk = (2 * r) / wh.w
    b.push(`<g${tint}>` + g.shadow(cx, cy + st.h * wk, st.w * wk * 0.45) +
      `<g transform="translate(${f1(cx - (st.w * wk) / 2)} ${cy}) scale(${wk.toFixed(4)})"><use href="${g.use('wheel-stand')}"/></g>`)
    const spin = working ? `<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="-360 ${cx} ${cy}" dur="2.2s" repeatCount="indefinite"/>` : ''
    b.push(`<g>${spin}<g transform="translate(${f1(cx - r)} ${f1(cy - (wh.h * wk) / 2)}) scale(${wk.toFixed(4)})"><use href="${g.use('wheel')}"/></g></g></g>`)
    if (working) {
      // babies run beside Mallow on the inside of the rim
      const slots = [-40, 40, -52]
      crew.forEach((c, i) => {
        const dx = slots[i] ?? 0, th = Math.asin(dx / rin)
        const x = cx + rin * Math.sin(th), y = cy + rin * Math.cos(th)
        const runs = lite >= 2 ? [`b-${c.fur}-run1`] : [`b-${c.fur}-run1`, `b-${c.fur}-run3`]
        const gearName = GEAR[c.role]
        const gear = gearName ? [gearName] : []
        b.push(g.place(x, y, U.b * 0.9, g.frames(runs, runs.map(() => 140), n => g.figure(n, gear, 'b-ginger-idle', false)), (-th * 180) / Math.PI))
      })
      const runs = lite >= 2 ? ['m-run1', 'm-run3'] : ['m-run1', 'm-run2', 'm-run3', 'm-run4']
      b.push(g.place(cx, cy + rin, U.m * 0.88, g.frames(runs, runs.map(() => 95), n => mallow(n))))
    }
  } else {
    // the dragon: asleep, fighting, or seeing stars
    const dragon = working ? (lite >= 2 ? ['d-battle1', 'd-battle4'] : ['d-battle1', 'd-battle2', 'd-battle3', 'd-battle4'])
      : mode === 'turn' ? ['d-dizzy'] : ['d-sleep']
    const dTimes = dragon.length === 4 ? [700, 420, 260, 520] : dragon.map(() => 700)
    b.push(g.shadow(470, 205, 52) + g.place(470, 205, U.d, g.frames(dragon, dTimes, n => g.figure(n, [], 'd-battle1', false))))
    if (working) {
      const spots = [272, 238, 204]
      crew.forEach((c, i) => {
        const sx = spots[i] ?? 200
        b.push(g.shadow(sx, FLOOR, 12) + g.place(sx, FLOOR, U.b, g.figure(`b-${c.fur}-sword`, ['g-knight'], 'b-ginger-idle', true)))
      })
      const swing = lite >= 2 ? ['k-swing1', 'k-swing3'] : ['k-swing1', 'k-swing2', 'k-swing3', 'k-swing4']
      const times = swing.length === 4 ? [520, 150, 130, 300] : [520, 300]
      b.push(g.shadow(314, FLOOR, 24) + g.place(314, FLOOR, U.m, g.frames(swing, times, n => mallow(n, true))))
    }
  }

  // Mallow when he's not working
  if (!working) {
    const x = knight ? 250 : mode === 'sleep' ? 420 : 300
    const y = FLOOR
    const pose = poseFor(theme, mode)
    let inner = mode === 'idle' && !knight
      ? g.frames(['m-idle', 'm-blink'], [2800, 160], n => mallow(n))
      : mallow(pose)
    if (mode === 'dance') {
      inner = `<g><animateTransform attributeName="transform" type="rotate" values="-8 0 -30;8 0 -30;-8 0 -30" dur="0.8s" repeatCount="indefinite"/>${inner}</g>`
    }
    b.push(g.shadow(x, y, 26) + g.place(x, y, U.m, inner))
    if (mode === 'pet') b.push(heartsFx(x, y - 70, look.nonce))
    if (mode === 'sleep') b.push(zzz(x + 18, y - 52))
    if (mode === 'eat') b.push(g.prop('p-seed', x + 30, y + 2, 12))
  }

  // a bug on the floor while the last command is failing
  if (look.bug) {
    const name = knight ? 'p-slime' : 'p-beetle'
    b.push(`<g><animateTransform attributeName="transform" type="translate" values="0 0;-60 0;0 0" dur="9s" repeatCount="indefinite"/>${g.prop(name, 380, FLOOR + 8, 18)}</g>`)
  }
  return g.done(alt)
}
