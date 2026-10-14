// Pure helpers for Mallow's pane: no `$`, so they can be tested on their own.
import type { Activity, Alert, FileRow, RateWindow, Theme } from '../types'

export const FURS = ['ginger', 'cream', 'cocoa', 'smoke'] as const

export const ROLE_NAMES: Record<string, string> = {
  explore: 'Explorer', plan: 'Planner', test: 'Tester', review: 'Reviewer', docs: 'Librarian',
  dev: 'Coder', security: 'Guard', worker: 'Helper',
}

export const OUTFITS = ['none', 'party', 'flowers', 'bow', 'beanie', 'chef', 'crown'] as const

const short = (p: string, n = 34) => {
  const s = String(p || '').replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return tail.length > n ? '...' + tail.slice(-(n - 3)) : tail || s.slice(0, n)
}

/** What a tool call looks like to Mallow: a kind (picks his pose) and a short label. */
export function activityFor(tool: string, input: Record<string, unknown>): Activity {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return { kind: 'edit', label: `editing ${short(str('file_path') || str('notebook_path'))}` }
    case 'Read':
      return { kind: 'read', label: `reading ${short(str('file_path'))}` }
    case 'Grep': case 'Glob':
      return { kind: 'read', label: `searching ${str('pattern').slice(0, 30)}` }
    case 'Bash': case 'PowerShell': {
      const cmd = str('command').trim().replace(/\s+/g, ' ')
      return { kind: 'bash', label: `running ${cmd.slice(0, 36)}${cmd.length > 36 ? '...' : ''}` }
    }
    case 'WebFetch': case 'WebSearch':
      return { kind: 'web', label: tool === 'WebSearch' ? `searching the web` : `reading a web page` }
    case 'Agent': case 'Task':
      return { kind: 'agent', label: `sending a helper: ${str('description').slice(0, 30)}` }
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate':
      return { kind: 'plan', label: 'updating the plan' }
    default:
      return { kind: 'other', label: tool.startsWith('mcp__') ? `using ${tool.split('__')[1] || 'a tool'}` : `using ${tool}` }
  }
}

/** Which costume a helper wears, from its subagent type. */
export function roleFor(type: string): string {
  const t = (type || '').toLowerCase()
  if (/explor|search|find/.test(t)) return 'explore'
  if (/plan|architect/.test(t)) return 'plan'
  if (/test|qa/.test(t)) return 'test'
  if (/review|critic/.test(t)) return 'review'
  if (/doc|writ/.test(t)) return 'docs'
  if (/secur|audit/.test(t)) return 'security'
  if (/code|dev|build|implement|general/.test(t)) return 'dev'
  return 'worker'
}

export function furFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return FURS[h % FURS.length] ?? 'ginger'
}

export const kTok = (t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(Math.round(t)))

/** A text bar: ▰▰▰▱▱▱ for 0..100. */
export function bar(pct: number, width = 10): string {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(n) + '▱'.repeat(width - n)
}

export function minutesLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`
}

export function resetText(iso: string | null, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const left = t - now
  if (left <= 0) return 'resetting now'
  return `resets in ${minutesLeft(left)}`
}

export function rateName(kind: string): string {
  return kind === 'five_hour' ? '5-hour limit' : kind === 'seven_day' ? 'Weekly limit'
    : kind === 'spend_limit' ? 'Spend limit' : kind.replace(/_/g, ' ')
}

/** Day, night or knight. Auto picks by the local hour. */
export function themeNow(pref: Theme, hour: number): 'day' | 'night' | 'knight' {
  if (pref !== 'auto') return pref
  return hour >= 20 || hour < 7 ? 'night' : 'day'
}

/** Mood in words, for a pet that should feel like a pet rather than a score. */
export function moodWord(mood: number): string {
  return mood >= 85 ? 'over the moon' : mood >= 65 ? 'happy' : mood >= 45 ? 'content' : mood >= 25 ? 'a bit lonely' : 'grumpy'
}

export function hearts(v: number, n = 5): string {
  const full = Math.max(0, Math.min(n, Math.round((v / 100) * n)))
  return '♥'.repeat(full) + '♡'.repeat(n - full)
}

/** Days in a row with at least one session. */
export function nextStreak(lastDay: string, streak: number, today: string): number {
  if (lastDay === today) return Math.max(1, streak)
  const prev = new Date(Date.parse(today + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10)
  return lastDay === prev ? streak + 1 : 1
}

/** Watches tool results for Claude going in circles. One alert per bad stretch. */
export class Streak {
  recent: { tool: string; label: string; err: boolean }[] = []

  push(tool: string, label: string, err: boolean): Alert | null {
    this.recent = [...this.recent, { tool, label, err }].slice(-6)
    const last3 = this.recent.slice(-3)
    if (last3.length === 3 && last3.every(r => r.err) && new Set(last3.map(r => r.tool + '|' + r.label)).size === 1) {
      this.recent = []
      return { id: `stuck-${Date.now()}`, title: 'Claude keeps hitting the same error',
        detail: `The same step failed 3 times in a row (${label}). If Claude isn't getting closer, press Esc and point it in a new direction. Every retry re-sends the whole conversation.` }
    }
    if (this.recent.length === 6 && this.recent.filter(r => r.err).length >= 5) {
      this.recent = []
      return { id: `fails-${Date.now()}`, title: 'Lots of failures in a row',
        detail: "5 of Claude's last 6 tool calls failed. If it's going in circles, press Esc and redirect it before it spends more." }
    }
    return null
  }
}

/** The /clear tip: once per 75k of growth, when a big session finishes a turn. */
export function clearTip(ctx: number, threshold = 100_000): { key: string; text: string } | null {
  if (ctx < threshold) return null
  return { key: `clear-${Math.floor(ctx / 75_000)}`,
    text: `Claude's done. This session sends about ${kTok(ctx)} tokens with every message. If your next task is unrelated, type /clear first. It's free, and Claude does better without old context in the way.` }
}

/** Git's view of what changed: `git status --porcelain=v1` and `git diff --numstat HEAD`. */
export function parseGit(porcelain: string, numstat: string, root: string): FileRow[] {
  const counts = new Map<string, { add: number; del: number }>()
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m) counts.set((m[3] ?? '').trim(), { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) })
  }
  const rows: FileRow[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ')[1] ?? path
    path = path.replace(/^"|"$/g, '')
    const status = code === '??' ? '+' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : 'M'
    const c = counts.get(path) || { add: 0, del: 0 }
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
    rows.push({ path, abs: root.replace(/[\\/]+$/, '') + sep + path.replace(/\//g, sep), status, add: c.add, del: c.del })
  }
  return rows.slice(0, 40)
}

/** A file:// link for a local path, Windows drive letters included. */
export function fileUrl(abs: string): string {
  const p = abs.replace(/\\/g, '/')
  const withSlash = /^[A-Za-z]:\//.test(p) ? '/' + p : p
  return 'file://' + encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

export function sortRates(rates: RateWindow[]): RateWindow[] {
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  return [...rates].sort((a, b) => order(a.kind) - order(b.kind))
}
