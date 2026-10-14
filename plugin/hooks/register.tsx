// Mallow for Claude Code: a hamster in the side pane who works when Claude works.
// Every hook here only watches: tool calls, prompts and turns pass through unchanged,
// and nothing here calls a model.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alert, Baby, FileRow, Journal, Meter, Mode, Pet, Prefs, Scene } from '../types'
import { SPR } from './assets'
import {
  OUTFITS, ROLE_NAMES, Streak, activityFor, bar, clearTip, furFor, hearts, kTok, minutesLeft,
  moodWord, nextStreak, parseGit, rateName, resetText, roleFor, sortRates, themeNow,
} from './logic'
import { poseFor, sceneSvg } from './scene'

const PANE = 'mallow'
const APP_URL = 'http://127.0.0.1:47321/'
const REPO_URL = 'https://github.com/MeekTheSneak/Mallow-Claude-Helper'
const CLEAR_AT = 100_000
const COLD_AT = 40_000
const TICK_MS = 15_000

const scene = atom({ plugin: 'mallow', key: 'scene' } as const,
  { mode: 'idle', busy: false, activity: null, at: 0, bug: false, nonce: 0 } as Scene)
const crew = atom({ plugin: 'mallow', key: 'crew' } as const, [] as Baby[])
const meter = atom({ plugin: 'mallow', key: 'meter' } as const,
  { model: '', ctxTokens: 0, ctxWindow: 0, ctxPct: 0, hit: null, rates: [], usd: null, lastEnd: null, ttl: 3600, now: 0 } as Meter)
const files = atom({ plugin: 'mallow', key: 'files' } as const, [] as FileRow[])
const alerts = atom({ plugin: 'mallow', key: 'alerts' } as const, [] as Alert[])
const seen = atom({ plugin: 'mallow', key: 'seen' } as const, [] as string[])
const prefs = atom({ plugin: 'mallow', key: 'prefs' } as const,
  { theme: 'auto', outfit: 'none', sound: false, files: true } as Prefs)
const journal = atom({ plugin: 'mallow', key: 'journal' } as const, { turns: 0, edits: 0, commands: 0, fixes: 0 } as Journal)
const pet = atom({ plugin: 'mallow', key: 'pet' } as const, { mood: 70, energy: 80, streak: 1, lastDay: '', fedAt: 0 } as Pet)
const app = atom({ plugin: 'mallow', key: 'app' } as const, null as string | null)

type $T = EngineInterface

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const today = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// what lives only as long as this copy of the module (a reload starts these over)
const mem = {
  streak: new Streak(),
  reads: new Map<string, number>(),
  edited: new Set<string>(),
  fired: new Set<string>(),
  cacheMisses: 0,
  warnedFor: 0,
  gitAt: 0,
  gitRoot: undefined as string | null | undefined,
  poseTimer: null as { cancel: () => void } | null,
}


async function sound($: $T, clip: string) {
  if ((await read($, prefs)).sound) $.audio.play({ asset: `sounds/${clip}.wav` }).catch(() => {})
}
async function addAlert($: $T, a: Alert) {
  await update($, alerts, list => (list.some(x => x.title === a.title && x.detail === a.detail) ? list : [...list, a].slice(-6)))
  void sound($, 'ding')
}
async function savePet($: $T) { return $.store.set('pet', await read($, pet)).catch(() => {}) }

/** Where Mallow is when nothing special is happening. */
async function restMode($: $T): Promise<Mode> {
  const s = await read($, scene)
  if (s.busy) return 'work'
  if ((await read($, alerts)).length) return 'alert'
  const idleMs = (await $.clock.now()) - (s.at || 0)
  if (idleMs > 10 * 60_000) return 'sleep'
  if (idleMs > 2 * 60_000) return 'idle'
  return s.mode === 'turn' ? 'turn' : 'idle'
}
/** A short pose (pet, feed, dance), then back to whatever he was doing. */
async function briefly($: $T, mode: Mode, ms: number) {
  await update($, scene, s => ({ ...s, mode, nonce: s.nonce + 1 }))
  mem.poseTimer?.cancel()
  mem.poseTimer = $.clock.after(ms, () => { void restMode($).then(m => update($, scene, s => ({ ...s, mode: m }))) })
}

async function refreshFiles($: $T, force = false) {
  const now = await $.clock.now()
  if (!force && now - mem.gitAt < 2500) return
  mem.gitAt = now
  try {
    if (mem.gitRoot === undefined) {
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
      mem.gitRoot = r.exitCode === 0 ? r.stdout.trim() : null
    }
    if (mem.gitRoot) {
      const st = await $.process.run(['git', 'status', '--porcelain=v1', '-uall'], { cwd: mem.gitRoot })
      const ns = await $.process.run(['git', 'diff', '--numstat', 'HEAD'], { cwd: mem.gitRoot })
      if (st.exitCode === 0) await update($, files, () => parseGit(st.stdout, ns.exitCode === 0 ? ns.stdout : '', mem.gitRoot as string))
      return
    }
  } catch { /* no git here: fall back to what Claude edited */ }
  await update($, files, () => [...mem.edited].slice(-40).map(abs => ({ path: abs.replace(/\\/g, '/').split('/').slice(-2).join('/'), abs, status: 'M', add: 0, del: 0 })))
}

/** Opens a file or a web address with what this computer uses for it: VS Code first for files, then the default app.
 *  No shell ever sees the path, except VS Code's launcher on Windows, and only for paths with no shell characters. */
async function openThing($: $T, target: string, isFile: boolean) {
  const win = /^[A-Za-z]:[\\/]/.test(target) || /^[A-Za-z]:[\\/]/.test(await $.session.cwd().catch(() => ''))
  const run = async (argv: string[]) => {
    try { return (await $.process.run(argv)).exitCode === 0 } catch { return false }
  }
  if (win) {
    if (isFile && !/[&|<>^%!"()]/.test(target) && (await run(['cmd', '/c', 'code', '-r', target]))) return
    await run(['explorer.exe', target])          // explorer reports 1 even when it worked
    return
  }
  if (isFile && (await run(['code', '-r', target]))) return
  if (await run(['open', ...(isFile ? ['-t'] : []), target])) return
  if (await run(['xdg-open', target])) return
  $.ui.toast(`Mallow couldn't open ${target}`)
}

async function checkApp($: $T) {
  try {
    const r = await $.http.fetch(APP_URL + 'api/ping')
    const ok = r.ok && /"mallow"/.test(r.text)
    await update($, app, () => (ok ? APP_URL : null))
  } catch {
    await update($, app, () => null)
  }
}

async function applyUsage($: $T, u: { context: { tokens?: number; window: number; percent?: number }; rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]; cost?: { usd: number } }) {
  await update($, meter, m => ({
    ...m,
    ctxTokens: u.context.tokens ?? m.ctxTokens, ctxWindow: u.context.window || m.ctxWindow,
    ctxPct: u.context.percent ?? m.ctxPct,
    rates: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt ?? null })),
    usd: u.cost ? u.cost.usd : m.usd,
    ttl: u.rateLimits.length ? 3600 : 300,
  }))
}


async function tick($: $T) {
  const now = await $.clock.now()
  const s = await read($, scene)
  const m = await update($, meter, mm => ({ ...mm, now }))
  // mood drifts back toward content; rest brings energy back
  await update($, pet, p => ({
    ...p,
    mood: clamp(p.mood + (p.mood > 60 ? -0.15 : 0.15)),
    energy: clamp(p.energy + (s.busy ? 0 : s.mode === 'sleep' ? 1.5 : 0.5)),
  }))
  if (!s.busy && !['pet', 'eat', 'dance'].includes(s.mode)) {
    const rest = await restMode($)
    if (rest !== s.mode) await update($, scene, sc => ({ ...sc, mode: rest }))
  }
  // the cache is about to go cold on a session worth keeping warm
  if (!s.busy && m.lastEnd && m.ctxTokens >= 20_000 && mem.warnedFor !== m.lastEnd) {
    const left = m.lastEnd + m.ttl * 1000 - now
    const lead = m.ttl > 600 ? 5 * 60_000 : 60_000
    if (left > 0 && left <= lead) {
      mem.warnedFor = m.lastEnd
      const mins = Math.max(1, Math.round(left / 60_000))
      $.ui.toast(`Mallow: the cache cools in about ${mins} min. Reply now to keep this session cheap.`, { timeoutMs: 10_000 })
      $.ui.notify(`The cache cools in about ${mins} min. Reply now, or let it go and start fresh later.`, { title: 'Mallow' }).catch(() => {})
    }
  }
  if (Math.round(now / TICK_MS) % 4 === 0) {
    void checkApp($)
    void savePet($)
  }
}

async function setPrefs($: $T, change: (p: Prefs) => Prefs) {
  const p = await update($, prefs, change)
  await $.store.set('prefs', p).catch(() => {})
  return p
}
async function petMallow($: $T) {
  await update($, pet, p => ({ ...p, mood: clamp(p.mood + 8) }))
  void sound($, 'chirp')
  await briefly($, 'pet', 3500)
}

async function feedMallow($: $T): Promise<string> {
  const now = await $.clock.now()
  const p = await read($, pet)
  if (now - p.fedAt < 60_000) return "He's still full. Try again in a minute."
  await update($, pet, pp => ({ ...pp, mood: clamp(pp.mood + 10), energy: clamp(pp.energy + 15), fedAt: now }))
  void sound($, 'pop')
  await briefly($, 'eat', 4000)
  return 'Crunch crunch. Mallow loves sunflower seeds.'
}

async function dance($: $T) {
  await update($, pet, p => ({ ...p, mood: clamp(p.mood + 4), energy: clamp(p.energy - 3) }))
  await briefly($, 'dance', 4000)
}

async function cycleOutfit($: $T, name?: string) {
  const p = await setPrefs($, pr => {
    const list = OUTFITS as readonly string[]
    const next = name && list.includes(name) ? name : (list[(list.indexOf(pr.outfit) + 1) % list.length] ?? 'none')
    return { ...pr, outfit: next }
  })
  return p.outfit
}

async function cycleTheme($: $T, name?: string) {
  const order = ['auto', 'day', 'night', 'knight'] as const
  const p = await setPrefs($, pr => ({ ...pr, theme: (order as readonly string[]).includes(name ?? '') ? (name as Prefs['theme']) : (order[(order.indexOf(pr.theme) + 1) % order.length] ?? 'auto') }))
  return p.theme
}

async function meterText($: $T) {
  const m = await read($, meter)
  const now = await $.clock.now()
  const lines = [`Context: ${m.ctxTokens ? `${Math.round(m.ctxPct)}% (${kTok(m.ctxTokens)} of ${kTok(m.ctxWindow)})` : 'no reading yet'}`]
  lines.push(`Cache: ${cacheLine(m, now)}`)
  for (const r of sortRates(m.rates)) lines.push(`${rateName(r.kind)}: ${Math.round(r.pct)}% used${r.resetsAt ? `, ${resetText(r.resetsAt, now)}` : ''}`)
  if (!m.rates.length && m.usd != null) lines.push(`Cost so far: $${m.usd.toFixed(2)}`)
  return lines.join('\n')
}

export const register: Register = on => {
  // ---------------------------------------------------------------- start
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mallow',
      description: 'Open Mallow, or: meter, journal, files, outfit <name>, theme <auto|day|night|knight>, sound, pet, feed, dance',
      argumentHint: '[meter|journal|files|outfit|theme|sound|pet|feed|dance]',
    })
    try {
      const p = (await $.store.get('prefs')) as Prefs | undefined
      if (p && typeof p === 'object') await update($, prefs, d => ({ ...d, ...p }))
      const saved = (await $.store.get('pet')) as Pet | undefined
      const now = await $.clock.now()
      const day = today(now)
      await update($, pet, d => {
        const base = saved && typeof saved === 'object' ? { ...d, ...saved } : d
        return { ...base, streak: nextStreak(base.lastDay, base.streak, day), lastDay: day }
      })
      const s = (await $.store.get('seen')) as string[] | undefined
      if (Array.isArray(s)) await update($, seen, () => s.slice(-100))
      await update($, scene, sc => ({ ...sc, at: now }))
      await update($, meter, m => ({ ...m, now }))
      await applyUsage($, await $.session.usage())
      await savePet($)
    } catch { /* first run, or nothing stored yet */ }
    void refreshFiles($, true)
    void checkApp($)
    $.clock.every(TICK_MS, () => { void tick($) })
    void $.ui.open({ id: PANE, title: 'Mallow' })
    return next(e)
  })

  // ---------------------------------------------------------------- tool calls: watch, never change
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const act = activityFor(tool, input)
    const sub = Boolean(e.agentId)
    const now = await $.clock.now()
    if (!sub) {
      await update($, scene, (s): Scene => ({ ...s, mode: 'work', busy: true, activity: act, at: now }))
      await update($, pet, p => ({ ...p, energy: clamp(p.energy - 0.4) }))
    } else {
      // a helper's own tool call: show it on the helper it most likely belongs to
      await update($, crew, list => {
        const i = list.findIndex(b => b.agentId === e.agentId)
        const j = i >= 0 ? i : list.findIndex(b => !b.agentId)
        if (j < 0) return list
        return list.map((b, k) => (k === j ? { ...b, agentId: e.agentId ?? null, label: act.label } : b))
      })
    }
    if (!sub && (tool === 'Agent' || tool === 'Task') && e.tool_use_id) {
      const type = typeof input.subagent_type === 'string' ? (input.subagent_type as string) : ''
      const desc = typeof input.description === 'string' ? (input.description as string) : 'helping out'
      const id = e.tool_use_id
      await update($, crew, list => [...list, { id, agentId: null, role: roleFor(type), label: desc.slice(0, 60), fur: furFor(id) }].slice(-8))
      void sound($, 'chirp')
    }

    const ran = await next(e)

    if (!sub && (tool === 'Agent' || tool === 'Task') && e.tool_use_id) {
      await update($, crew, list => list.filter(b => b.id !== e.tool_use_id))
    }
    if (!sub && ran.deny === undefined) {
      const failed = ran.isError === true
      const j = await read($, journal)
      if (tool === 'Bash' || tool === 'PowerShell') {
        const was = (await read($, scene)).bug
        await update($, journal, () => ({ ...j, commands: j.commands + 1, fixes: j.fixes + (was && !failed ? 1 : 0) }))
        await update($, scene, s => ({ ...s, bug: failed }))
        if (failed && !was) void sound($, 'oops')
        if (!failed && was) void sound($, 'pop')
      }
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && !failed) {
        await update($, journal, jj => ({ ...jj, edits: jj.edits + 1 }))
        const path = String(input.file_path ?? input.notebook_path ?? '')
        if (path) mem.edited.add(path)
      }
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'].includes(tool)) void refreshFiles($)
      const stuck = mem.streak.push(tool, act.label, failed)
      if (stuck) await addAlert($, stuck)
      if (tool === 'Read' && typeof input.file_path === 'string' && !input.offset && !input.limit) {
        const n = (mem.reads.get(input.file_path) ?? 0) + 1
        mem.reads.set(input.file_path, n)
        if (n === 3) {
          await addAlert($, { id: `reread-${now}`, title: 'Same file, third read',
            detail: `${String(input.file_path).replace(/\\/g, '/').split('/').pop()} has now been read 3 times this session. A short outline of it in CLAUDE.md usually stops this.` })
        }
      }
      const toks = Math.round((ran.text?.length ?? 0) / 4)
      if (toks >= 20_000) {
        await addAlert($, { id: `big-${now}`, title: 'A huge tool result',
          detail: `${act.label} returned about ${kTok(toks)} tokens. It now rides along on every later message in this session.` })
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- prompts and turns
  on('prompt.submit', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const m = await read($, meter)
      if (m.lastEnd && now - m.lastEnd > m.ttl * 1000 && m.ctxTokens >= COLD_AT) {
        $.ui.toast(`Mallow: the cache had expired, so this message re-sends about ${kTok(m.ctxTokens)} tokens at full price.`, { timeoutMs: 8000 })
      }
      await update($, scene, (s): Scene => ({ ...s, mode: 'work', busy: true, activity: { kind: 'think', label: 'thinking' }, at: now }))
    } catch { /* never in the way of a prompt */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    try {
      const now = await $.clock.now()
      const u = e.usage
      if (u) {
        const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        const hit = total ? (u.cache_read_input_tokens ?? 0) / total : null
        await update($, meter, m => ({ ...m, model: u.model || m.model, hit, lastEnd: now, now }))
        // Claude Code caches by itself; three big turns with no cache at all means something strips it
        if ((u.cache_read_input_tokens ?? 0) === 0 && (u.cache_creation_input_tokens ?? 0) === 0 && (u.input_tokens ?? 0) > 2000) {
          mem.cacheMisses += 1
          if (mem.cacheMisses === 3) {
            await addAlert($, { id: `nocache-${now}`, title: "Prompt caching isn't working",
              detail: 'Three turns in a row went out with no cache at all, so every message pays full price. A proxy or gateway in between is usually stripping the cache markers.' })
          }
        } else mem.cacheMisses = 0
      } else {
        await update($, meter, m => ({ ...m, lastEnd: now, now }))
      }
      await applyUsage($, await $.session.usage())
      await update($, journal, j => ({ ...j, turns: j.turns + 1 }))
      await update($, pet, p => ({ ...p, mood: clamp(p.mood + (e.isAborted ? 0 : 2)) }))
      await update($, scene, (s): Scene => ({ ...s, busy: false, activity: null, at: now, mode: 'turn' }))
      await update($, crew, () => [])
      void sound($, 'chirp')
      const m = await read($, meter)
      const tip = clearTip(m.ctxTokens, CLEAR_AT)
      if (tip && !(await read($, seen)).includes(tip.key) && !mem.fired.has(tip.key)) {
        mem.fired.add(tip.key)
        $.ui.toast(`Mallow: this session carries ${kTok(m.ctxTokens)} tokens. If your next task is unrelated, /clear first.`, { timeoutMs: 8000 })
      }
    } catch { /* drawing only */ }
    return done
  })

  on('session.measure', async ($, e, next) => {
    try {
      await applyUsage($, e)
      const pct = e.context.percent ?? 0
      for (const t of [80, 90]) {
        if (pct >= t && !mem.fired.has(`ctx${t}`)) {
          mem.fired.add(`ctx${t}`)
          $.ui.toast(`Mallow: context is ${Math.round(pct)}% full. A /clear between tasks keeps every message cheaper.`, { timeoutMs: 8000 })
        }
        if (pct < t - 20) mem.fired.delete(`ctx${t}`)
      }
      for (const r of e.rateLimits) {
        for (const t of [80, 90]) {
          const key = `${r.kind}${t}`
          if (r.percentUsed >= t && !mem.fired.has(key)) {
            mem.fired.add(key)
            $.ui.toast(`Mallow: your ${rateName(r.kind).toLowerCase()} is ${Math.round(r.percentUsed)}% used${r.resetsAt ? `, ${resetText(r.resetsAt, await $.clock.now())}` : ''}.`, { timeoutMs: 10_000 })
          }
          if (r.percentUsed < t - 20) mem.fired.delete(key)
        }
      }
    } catch { /* drawing only */ }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    void savePet($)
    return next(e)
  })

  // ---------------------------------------------------------------- the /mallow command

  on('command.run', { command: 'mallow' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').toLowerCase()
    switch (sub.toLowerCase()) {
      case '': case 'open':
        await $.ui.open({ id: PANE, title: 'Mallow' })
        return { text: 'Mallow is in the side pane.' }
      case 'meter': return { text: await meterText($) }
      case 'journal': {
        const j = await read($, journal), p = await read($, pet)
        return { text: `This session: ${j.turns} turns, ${j.edits} edits, ${j.commands} commands, ${j.fixes} bugs squashed.\nMallow is ${moodWord(p.mood)} (${hearts(p.mood)}), energy ${Math.round(p.energy)}%, ${p.streak}-day streak.` }
      }
      case 'files': {
        const p = await setPrefs($, pr => ({ ...pr, files: !pr.files }))
        return { text: p.files ? 'Changed files are shown in the pane.' : 'Changed files are hidden.' }
      }
      case 'outfit': return { text: `Mallow is wearing: ${await cycleOutfit($, arg || undefined)}.` }
      case 'theme': return { text: `Theme: ${await cycleTheme($, arg || undefined)}.` }
      case 'sound': {
        const p = await setPrefs($, pr => ({ ...pr, sound: arg ? arg === 'on' : !pr.sound }))
        return { text: `Sound ${p.sound ? 'on' : 'off'}.` }
      }
      case 'pet': await petMallow($); return { text: 'Mallow loved that.' }
      case 'feed': return { text: await feedMallow($) }
      case 'dance': await dance($); return { text: 'Mallow dances.' }
      default:
        return { text: 'Try /mallow, or /mallow meter, journal, files, outfit <name>, theme <auto|day|night|knight>, sound, pet, feed, dance.' }
    }
  })

  // ---------------------------------------------------------------- the pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const S = await read($, scene), C = await read($, crew), M = await read($, meter)
    const F = await read($, files), A = await read($, alerts), P = await read($, prefs)
    const J = await read($, journal), PET = await read($, pet), APP = await read($, app), SEEN = await read($, seen)
    const now = M.now || (await $.clock.now())
    const theme = themeNow(P.theme, new Date(now).getHours())
    const status = S.busy ? (S.activity ? cap(S.activity.label) : 'Working')
      : S.mode === 'turn' ? 'Your turn' : S.mode === 'sleep' ? 'Napping' : A.length ? 'Needs a look' : 'Watching'

    const tips: { key: string; text: string }[] = []
    if (!S.busy && M.lastEnd && now > M.lastEnd + M.ttl * 1000 && M.ctxTokens >= COLD_AT) {
      tips.push({ key: `cold-${M.lastEnd}`, text: `The cache expired, so your next message here re-sends about ${kTok(M.ctxTokens)} tokens at full price. Starting something new? /clear or a new session costs nothing. Coming back to this work? Claude Code may offer to pick up from a summary.` })
    } else if (S.mode === 'turn') {
      const t = clearTip(M.ctxTokens, CLEAR_AT)
      if (t) tips.push(t)
    }
    const tip = tips.find(t => !SEEN.includes(t.key))

    const { Box, Text, Button, Link } = $.ui.resolve(e)

    const alt = `Mallow ${S.busy ? 'is working' : S.mode === 'sleep' ? 'is asleep' : S.mode === 'turn' ? 'is waving: your turn' : 'is hanging out'}`
    // the terminal shows one picture of him (where it can draw pictures); the apps draw the whole room
    let picture
    if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const pose = SPR[poseFor(theme, S.mode)]
      picture = pose ? <Image source={{ png: pose.d }} columns={14} rows={6} alt={alt} /> : <Text dimColor>{alt}</Text>
    } else {
      const { Svg } = $.ui.resolve(e)
      const svg = sceneSvg({ theme, mode: S.mode, outfit: P.outfit, crew: C, bug: S.bug, nonce: S.nonce }, alt)
      picture = svg ? <Svg source={svg} alt={alt} isInteractive /> : <Text dimColor>{alt}</Text>
    }

    const busyText = S.busy && C.length ? ` with ${C.length} helper${C.length === 1 ? '' : 's'}` : ''
    return (
      <Box flexDirection="column" gap={1}>
        {picture}
        <Box flexDirection="column">
          <Text bold>{status}{busyText}</Text>
          <Text dimColor>Mallow is {moodWord(PET.mood)} {hearts(PET.mood)} · energy {bar(PET.energy, 5)} · {PET.streak}-day streak</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="pet" label="Pet" hotkey="p" onPress={() => petMallow($)} />
          <Button key="feed" label="Feed" hotkey="f" onPress={async () => { const r = await feedMallow($); if (r.startsWith('He')) $.ui.toast(r) }} />
          <Button key="dance" label="Dance" hotkey="d" onPress={() => dance($)} />
          <Button key="outfit" label="Outfit" hotkey="o" onPress={() => cycleOutfit($)} />
          <Button key="theme" label={`Theme: ${P.theme}`} hotkey="m" onPress={() => cycleTheme($)} />
          <Button key="sound" label={P.sound ? 'Sound on' : 'Sound off'} hotkey="s" onPress={() => setPrefs($, p => ({ ...p, sound: !p.sound }))} />
          <Button key="files" label={P.files ? 'Hide files' : 'Files'} hotkey="t" onPress={() => setPrefs($, p => ({ ...p, files: !p.files }))} />
        </Box>

        {A.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text bold color="warning">Needs a look</Text>
            {A.map(a => (
              <Box key={a.id} flexDirection="column" marginTop={1}>
                <Text bold>{a.title}</Text>
                <Text>{a.detail}</Text>
                <Button key={`ack-${a.id}`} label="Got it" onPress={() => update($, alerts, list => list.filter(x => x.id !== a.id))} />
              </Box>
            ))}
          </Box>
        )}

        {tip && (
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Text>{tip.text}</Text>
            <Button key="tip-ok" label="Got it" onPress={async () => {
              const list = await update($, seen, l => [...l, tip.key].slice(-100))
              await $.store.set('seen', list).catch(() => {})
            }} />
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>This session</Text>
          <Text>Context  {bar(M.ctxPct)} {M.ctxTokens ? `${Math.round(M.ctxPct)}% · ${kTok(M.ctxTokens)} of ${kTok(M.ctxWindow)}` : 'no reading yet'}</Text>
          <Text>Cache    {cacheLine(M, now)}</Text>
          {sortRates(M.rates).map(r => (
            <Text key={r.kind}>{pad(rateName(r.kind), 8)} {bar(r.pct)} {Math.round(r.pct)}%{r.resetsAt ? ` · ${resetText(r.resetsAt, now)}` : ''}</Text>
          ))}
          {!M.rates.length && M.usd != null && <Text>Cost     ${M.usd.toFixed(2)} so far</Text>}
          {M.model && <Text dimColor>{M.model}</Text>}
        </Box>

        {C.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Crew</Text>
            {C.map(c => <Text key={c.id}>{ROLE_NAMES[c.role] ?? 'Helper'} · <Text dimColor>{c.label}</Text></Text>)}
          </Box>
        )}

        {P.files && (
          <Box flexDirection="column">
            <Text bold>Changed files{F.length ? ` (${F.length})` : ''}</Text>
            {F.length === 0 && <Text dimColor>Nothing changed yet.</Text>}
            {F.slice(0, 20).map(f => (
              <Button key={`file-${f.abs}`} plain onPress={() => openThing($, f.abs, true)}>
                <Text color={f.status === 'D' ? 'error' : f.status === 'M' ? 'warning' : 'success'}>{f.status}</Text> {f.path}{(f.add > 0 || f.del > 0) ? <Text dimColor> +{f.add} -{f.del}</Text> : ''}
              </Button>
            ))}
          </Box>
        )}

        <Text dimColor>{J.turns} turns · {J.edits} edits · {J.commands} commands{J.fixes ? ` · ${J.fixes} bugs squashed` : ''}</Text>
        {APP
          ? <Button key="app" label="Open the Mallow app: history and usage helpers" onPress={() => openThing($, APP, false)} />
          : <Link href={REPO_URL} label="Get the Mallow app for history reports and usage helpers" />}
      </Box>
    )
  })
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }
function pad(s: string, n: number) { return s.length >= n ? s : s + ' '.repeat(n - s.length) }

function cacheLine(m: Meter, now: number): string {
  if (!m.lastEnd) return 'warming up'
  const left = m.lastEnd + m.ttl * 1000 - now
  const hit = m.hit == null ? '' : ` · ${Math.round(m.hit * 100)}% from cache last turn`
  return left > 0 ? `warm, ${minutesLeft(left)} left${hit}` : `cold for ${minutesLeft(-left)}${hit}`
}
