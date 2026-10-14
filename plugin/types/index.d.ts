// Mallow's session state: the values the side pane draws from.

export type Mode = 'idle' | 'work' | 'turn' | 'sleep' | 'alert' | 'eat' | 'dance' | 'pet'

export type Activity = { kind: string; label: string }

export type Scene = { mode: Mode; busy: boolean; activity: Activity | null; at: number; bug: boolean; nonce: number }

export type Baby = { id: string; agentId: string | null; role: string; label: string; fur: string }

export type RateWindow = { kind: string; pct: number; resetsAt: string | null }

export type Meter = {
  model: string
  ctxTokens: number
  ctxWindow: number
  ctxPct: number
  hit: number | null
  rates: RateWindow[]
  usd: number | null
  lastEnd: number | null
  ttl: number
  now: number
}

export type FileRow = { path: string; abs: string; status: string; add: number; del: number }

export type Alert = { id: string; title: string; detail: string }

export type Theme = 'auto' | 'day' | 'night' | 'knight'

export type Prefs = { theme: Theme; outfit: string; sound: boolean; files: boolean }

export type Journal = { turns: number; edits: number; commands: number; fixes: number }

export type Pet = { mood: number; energy: number; streak: number; lastDay: string; fedAt: number }

declare module 'claude-code' {
  interface PluginState {
    mallow: {
      scene: Scene
      crew: Baby[]
      meter: Meter
      files: FileRow[]
      alerts: Alert[]
      seen: string[]
      prefs: Prefs
      journal: Journal
      pet: Pet
      app: string | null
    }
  }
}
