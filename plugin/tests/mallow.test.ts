import { expect, mock, test } from 'claude-code/testing'

import { Streak, activityFor, clearTip, fileUrl, nextStreak, parseGit, roleFor, themeNow } from '../hooks/logic'
import { sceneSvg } from '../hooks/scene'

// what the engine would answer beneath the plugin
function engine(on: any) {
  mock.clock(on, { now: Date.parse('2026-10-14T15:00:00Z') })
  mock.store(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120_000, window: 200_000, percent: 60 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: '2030-01-01T00:00:00Z' }] } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '' } }))
}

const PANE = {
  plugin: 'mallow',
  component: 'Pane',
  requestId: 'mallow',
  props: { title: 'Mallow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
} as const

test('tool calls pass through untouched and Mallow goes to work', async ($, on) => {
  engine(on)
  let seen: unknown
  on('tool.call', ($, e) => {
    seen = e
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const input = { tool: 'Bash', tool_use_id: 't1', command: 'npm test', description: 'run tests' } as const
  const ran = await $.tool.call(input as never)
  expect((seen as { command: string }).command).toBe('npm test')
  expect((ran as { text?: string }).text).toBe('ok')
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: /running npm test/i })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'pet' })).toBeDefined()
    await ui.unmount()
  }
})

test('three failures of the same step raise one alert, and Got it clears it', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ isError: true, result: 'boom', text: 'boom' }) as never)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `f${i}`, command: 'cargo build' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /keeps hitting the same error/ })).toBeDefined()
  const ack = await ui.find({ type: 'Button', text: 'Got it' })
  expect(ack).toBeDefined()
  await ui.press({ key: ack!.key! })
  expect(await ui.find({ type: 'Text', text: /keeps hitting the same error/ })).toBeUndefined()
  await ui.unmount()
})

test('pet and outfit buttons work on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'pet' })
    await ui.press({ key: 'outfit' })
    expect(await ui.find({ type: 'Button', key: 'theme' })).toBeDefined()
    await ui.unmount()
  }
})

test('helpers: activities, roles, tips, git and links', async () => {
  expect(activityFor('Edit', { file_path: 'C:\\x\\src\\a.ts' }).label).toBe('editing src/a.ts')
  expect(activityFor('Bash', { command: 'npm test' }).kind).toBe('bash')
  expect(roleFor('Explore')).toBe('explore')
  expect(clearTip(90_000)).toBeNull()
  expect(clearTip(160_000)?.key).toBe('clear-2')
  expect(themeNow('auto', 22)).toBe('night')
  expect(nextStreak('2026-10-13', 4, '2026-10-14')).toBe(5)
  expect(nextStreak('2026-10-10', 4, '2026-10-14')).toBe(1)
  const rows = parseGit(' M src/a.ts\n?? new.txt\n', '12\t3\tsrc/a.ts\n', 'C:\\proj')
  expect(rows[0]).toEqual({ path: 'src/a.ts', abs: 'C:\\proj\\src\\a.ts', status: 'M', add: 12, del: 3 })
  expect(rows[1]?.status).toBe('+')
  expect(fileUrl('C:\\proj\\my file.ts')).toBe('file:///C:/proj/my%20file.ts')
  const s = new Streak()
  expect(s.push('Bash', 'x', true)).toBeNull()
  expect(s.push('Bash', 'x', true)).toBeNull()
  expect(s.push('Bash', 'x', true)?.title).toBe('Claude keeps hitting the same error')
})

test('every scene fits the pane limit', async () => {
  const crew = ['a', 'b', 'c'].map((id, i) => ({ id, agentId: null, role: ['explore', 'test', 'dev'][i] ?? 'dev', label: id, fur: ['cream', 'cocoa', 'smoke'][i] ?? 'ginger' }))
  for (const theme of ['day', 'night', 'knight'] as const) {
    for (const mode of ['idle', 'work', 'turn', 'sleep', 'alert', 'eat', 'dance', 'pet'] as const) {
      const svg = sceneSvg({ theme, mode, outfit: 'flowers', crew, bug: true, nonce: 1 }, 'Mallow')
      expect(svg.length > 1000 && svg.length <= 131_072, `${theme} ${mode}: ${svg.length}`).toBe(true)
    }
  }
})

test('a finished turn waves, and a big session shows the /clear tip', async ($, on) => {
  engine(on)
  on('turn.complete', (_$: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }) as never)
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 2000, output_tokens: 300 } } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /^Your turn/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /type \/clear first/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5-hour limit/ })).toBeDefined()
  await ui.press({ key: 'tip-ok' })
  expect(await ui.find({ type: 'Text', text: /type \/clear first/ })).toBeUndefined()
  await ui.unmount()
})
