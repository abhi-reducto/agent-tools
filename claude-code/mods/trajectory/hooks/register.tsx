import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { centre, clip, COLORS, dur, lanes, level, visible } from './ledger'
import type { Row, Trace, Trajectory, Ui, View } from '../types'

const PANE = 'trajectory'
const TITLE = 'Trajectory'
const GET = 'mcp__trajectory__trajectory_get'
const NOTE = 'mcp__trajectory__trajectory_note'
const EMPTY: Trajectory = { goal: '', now: '', phases: [], decisions: [], open: [], loose: [], next: [] }
const HINT =
  'This session keeps a trajectory record: goal, phases, key decisions, open questions and loose ends. ' +
  'It survives compaction. When you are unsure why something was decided, or after the conversation was compacted, ' +
  'call trajectory_get before re-deriving or re-asking. When you make a decision that closes off an alternative, ' +
  'or hit a question you cannot answer yet, record it with trajectory_note (one line, with the reason).'

const view = atom(
  { plugin: 'trajectory', key: 'view' } as const,
  { status: 'idle', traj: null, error: '', at: 0, turnsAtRun: 0 },
  { shape: 'view-1' },
)
const ui = atom(
  { plugin: 'trajectory', key: 'ui' } as const,
  { tab: 'overview', top: -1, sel: -1, q: '', timeline: true, turns: true, calls: true, context: false },
  { shape: 'ui-2' },
)
const stats = atom(
  { plugin: 'trajectory', key: 'stats' } as const,
  { turns: 0, tools: 0, startedAt: 0 },
  { shape: 'stats-1' },
)

const ASK = `Write a concise trajectory overview of this session so far, for the person to skim.
Reply with JSON only, no prose and no code fence, in exactly this shape:
{"goal": string, "now": string,
 "phases": [{"title": string, "outcome": string}],
 "decisions": [{"what": string, "why": string}],
 "open": [{"q": string, "blocking": boolean}],
 "loose": [string], "next": [string]}
Rules:
- Every string is at most 100 characters.
- goal: what the person is trying to get done. now: where things stand right now.
- phases: at most 8, in order. As the session grows make phases coarser, not more numerous.
- decisions: only choices that changed direction or closed off an alternative. At most 8, with the reason.
- open: unresolved questions, or things waiting on the person. At most 6. blocking is true only when work cannot go on without an answer.
- loose: things unfinished, unverified, assumed or skipped. At most 5.
- next: at most 3 concrete next steps.
- An earlier record is given below. Its decisions and open questions stay unless the session shows they are resolved or wrong. The transcript may have been compacted, so do not drop them just because you cannot see them. When over a limit, merge or drop the least important first.
- Say only what the session shows or the earlier record says. If unsure, leave it out. Do not mention this request.`

const strs = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one !== '').slice(0, max)
    : []

const parse = (text: string): Trajectory | undefined => {
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from < 0 || to <= from) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(from, to + 1))
  } catch {
    return undefined
  }
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
      : []
  const line = (value: unknown) => (typeof value === 'string' ? value : '')
  return {
    goal: line(raw.goal),
    now: line(raw.now),
    phases: list(raw.phases).slice(0, 8).map(p => ({ title: line(p.title), outcome: line(p.outcome) })),
    decisions: list(raw.decisions).slice(0, 8).map(d => ({ what: line(d.what), why: line(d.why) })),
    open: list(raw.open).slice(0, 6).map(o => ({ q: line(o.q), blocking: o.blocking === true })),
    loose: strs(raw.loose, 5),
    next: strs(raw.next, 3),
  }
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const plain = (traj: Trajectory): string => {
  const out: string[] = [`Goal: ${traj.goal}`, `Now:  ${traj.now}`]
  if (traj.phases.length) out.push('', 'Phases', ...traj.phases.map((p, i) => `  ${i + 1}. ${p.title} — ${p.outcome}`))
  if (traj.decisions.length) out.push('', 'Decisions', ...traj.decisions.map(d => `  ◆ ${d.what} — ${d.why}`))
  if (traj.open.length) out.push('', 'Open questions', ...traj.open.map(o => `  ${o.blocking ? '!' : '?'} ${o.q}`))
  if (traj.loose.length) out.push('', 'Loose ends', ...traj.loose.map(l => `  · ${l}`))
  if (traj.next.length) out.push('', 'Next', ...traj.next.map(n => `  → ${n}`))
  return out.join('\n')
}

// The record lives on disk beside the transcript so it outlives a compaction or a resume.
async function fileOf($: EngineInterface) {
  const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  return `${home}/.claude/trajectories/${await $.session.id()}.json`
}

async function save($: EngineInterface) {
  const now = await read($, view)
  if (!now.traj) return
  const keep = { traj: now.traj, at: now.at, turnsAtRun: now.turnsAtRun }
  await $.fs.write(await fileOf($), JSON.stringify(keep, null, 2))
}

async function restore($: EngineInterface) {
  try {
    const kept = JSON.parse(await $.fs.read(await fileOf($)))
    if (kept && kept.traj) {
      await update($, view, one => ({ ...one, traj: kept.traj, at: kept.at ?? 0, turnsAtRun: kept.turnsAtRun ?? 0 }))
    }
  } catch {
    // no record yet
  }
}

// The transcript keeps the whole history, compacted turns included; reduce it again only when it grows.
let ledger: { path: string; size: number; trace: Trace } | undefined
const NONE: Trace = { rows: [], spans: [] }

async function loadLedger($: EngineInterface): Promise<Trace> {
  const id = await $.session.id()
  if (!ledger || ledger.path === '') {
    const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    const found = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
    ledger = { path: found.stdout.split('\n')[0]?.trim() ?? '', size: -1, trace: NONE }
  }
  if (ledger.path === '') return NONE
  const size = (await $.fs.stat(ledger.path)).size
  if (size !== ledger.size) {
    const ran = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/ledger.py`, ledger.path], { timeoutMs: 20000 })
    ledger = { path: ledger.path, size, trace: ran.exitCode === 0 ? (JSON.parse(ran.stdout) as Trace) : NONE }
  }
  return ledger.trace
}

async function refresh($: EngineInterface) {
  const before = await read($, stats)
  const earlier = (await read($, view)).traj
  await update($, view, (one): View => ({ ...one, status: 'working', error: '' }))
  try {
    const record = earlier ? `\n\nEarlier record:\n${JSON.stringify(earlier)}` : ''
    const reply = await $.model.fork({ prompt: ASK + record })
    if (!reply.isAnswered) {
      const why = reply.reason === 'nothing-to-fork' ? 'Nothing to summarize yet.' : `No reply (${reply.reason}).`
      await update($, view, (one): View => ({ ...one, status: 'failed', error: why }))
      return
    }
    const traj = parse(reply.text)
    if (!traj) {
      await update($, view, (one): View => ({ ...one, status: 'failed', error: 'The reply was not valid JSON. Try again.' }))
      return
    }
    await update($, view, (): View => ({ status: 'idle', traj, error: '', at: Date.now(), turnsAtRun: before.turns }))
    await save($)
  } catch (err) {
    await update($, view, (one): View => ({ ...one, status: 'failed', error: String(err) }))
  }
}

async function readTrajectory($: EngineInterface, e: unknown) {
  const input = e as { refresh?: boolean }
  if (input.refresh === true) await refresh($)
  const now = await read($, view)
  if (!now.traj) return { result: 'No trajectory recorded yet. Run /trajectory or call trajectory_note.' }
  return { result: `${plain(now.traj)}\n\n(recorded ${ago(now.at)})` }
}

async function noteTrajectory($: EngineInterface, e: unknown) {
  const input = e as { kind?: string; text?: string; why?: string; blocking?: boolean }
  const text = (input.text ?? '').slice(0, 160)
  if (text === '') return { result: 'Nothing to record: text is empty.' }
  await update($, view, one => {
    const traj: Trajectory = one.traj ?? { ...EMPTY }
    const next: Trajectory = { ...traj }
    if (input.kind === 'decision') next.decisions = [...traj.decisions, { what: text, why: (input.why ?? '').slice(0, 160) }].slice(-8)
    else if (input.kind === 'question') next.open = [...traj.open, { q: text, blocking: input.blocking === true }].slice(-6)
    else if (input.kind === 'loose') next.loose = [...traj.loose, text].slice(-5)
    else if (input.kind === 'goal') next.goal = text
    else if (input.kind === 'now') next.now = text
    else if (input.kind === 'resolved') {
      const phrase = text.toLowerCase()
      next.open = traj.open.filter(o => !o.q.toLowerCase().includes(phrase))
    }
    return { ...one, traj: next, at: one.at || Date.now() }
  })
  await save($)
  return { result: 'Recorded.' }
}

// /reload-plugins can run session.start before the REPL has bound the session, and then registering throws.
// Try again a moment later instead of leaving the command unknown.
let isReady = false

async function ensure($: EngineInterface) {
  try {
  await $.command.register({
    name: 'trajectory',
    description: 'Show a concise overview of this session: phases, decisions, open questions',
  })
  await $.tool.register({
    name: 'trajectory_get',
    description:
      "Read this session's trajectory record: goal, phases, key decisions with reasons, open questions, loose ends. " +
      'It survives compaction, so use it after a compaction or whenever you are unsure why something was decided. ' +
      'Pass refresh: true to rebuild it from the conversation first (slower).',
    inputSchema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: 'Rebuild the record from the conversation first.' } },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'trajectory_note',
    description:
      'Record one item in the trajectory right now, without a model call. Use kind decision for a choice that closed off ' +
      'an alternative (give why), question for an open question, loose for something unfinished or unverified, ' +
      'resolved to clear an open question (text is a phrase from it), goal or now to set those lines.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['decision', 'question', 'loose', 'resolved', 'goal', 'now'] },
        text: { type: 'string', description: 'One line, at most 100 characters.' },
        why: { type: 'string', description: 'For a decision: the reason.' },
        blocking: { type: 'boolean', description: 'For a question: work cannot go on without an answer.' },
      },
      required: ['kind', 'text'],
    },
    isDeferred: false,
  })
    isReady = true
  } catch {
    isReady = false
  }
}

function retry($: EngineInterface, tries: number) {
  void $.clock.after(1500, async () => {
    await ensure($)
    if (!isReady && tries < 20) retry($, tries + 1)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    if (!isReady) retry($, 1)
    try {
      await update($, stats, one => (one.startedAt ? one : { ...one, startedAt: Date.now() }))
      await restore($)
    } catch {
      // the session is not bound yet; the record is read again on the first command
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections, { id: 'trajectory:hint', scope: 'session', text: HINT }] }
  })

  on('session.compact', ($, e, next) => {
    // Bring the record up to date while the full transcript is still there.
    const ready = !e.agentId && (e.trigger === 'auto' || e.trigger === 'manual') ? refresh($) : Promise.resolve()
    return ready.catch(() => undefined).then(() => next(e))
  })

  on('turn.start', async ($, e, next) => {
    await update($, stats, one => ({ ...one, turns: one.turns + 1 }))
    return next(e)
  })

  on('tool.call', ($, e, next) =>
    update($, stats, one => ({ ...one, tools: one.tools + 1 }))
      .catch(() => undefined)
      .then(() => next(e)),
  )

  on('tool.call', { tool: GET }, ($, e) =>
    readTrajectory($, e).catch(() => ({ result: 'The trajectory could not be read.' })),
  )

  on('tool.call', { tool: NOTE }, ($, e) =>
    noteTrajectory($, e).catch(() => ({ result: 'The note could not be recorded.' })),
  )

  on('command.run', { command: 'trajectory' }, async $ => {
    const now = await read($, view)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const wanted = now.traj === null || now.status === 'failed'
    if (opened.isPlaced) {
      if (wanted) void refresh($)
      return { text: wanted ? 'Building the trajectory…' : 'Trajectory open. [r] refreshes it.' }
    }
    if (now.traj) return { text: plain(now.traj) }
    void refresh($).then(async () => {
      const done = await read($, view)
      $.ui.log(done.traj ? plain(done.traj) : done.error)
    })
    return { text: 'Building the trajectory…' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, view)
    const run = await read($, stats)
    const shown = await read($, ui)
    const traj = now.traj
    // viewport.columns is the whole conversation; the pane's own body is narrower
    const cols = Math.max(30, e.props.bodyColumns - 1)

    const tabs = (
      <Box>
        <Button plain key="tab-overview" hotkey="1" onPress={() => void update($, ui, (one): Ui => ({ ...one, tab: 'overview' }))}>
          {shown.tab === 'overview' ? '[1 Overview]' : ' 1 Overview '}
        </Button>
        <Button plain key="tab-trace" hotkey="2" onPress={() => void update($, ui, (one): Ui => ({ ...one, tab: 'trace' }))}>
          {shown.tab === 'trace' ? '[2 Trace]' : ' 2 Trace '}
        </Button>
      </Box>
    )
    const controls = (
      <Box>
        <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
          {now.status === 'working' ? '[r] building…' : '[r] refresh'}
        </Button>
        <Text> </Text>
        <Button key="close" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>[x] close</Button>
      </Box>
    )
    const mins = run.startedAt ? Math.max(1, Math.round((Date.now() - run.startedAt) / 60000)) : 0
    const meta = `${run.turns} turns · ${run.tools} tool calls · ${mins}m`

    if (shown.tab === 'trace') {
      const elements = $.ui.resolve(e)
      const Input = 'Input' in elements ? elements.Input : undefined
      const trace = await loadLedger($)
      const set = (patch: Partial<Ui>) => void update($, ui, (one): Ui => ({ ...one, ...patch }))
      const toggle = (label: string, isOn: boolean, patch: Partial<Ui>) => (
        <Button plain key={`tg-${label}`} onPress={() => set(patch)}>
          <Text color={isOn ? 'cyan' : undefined} dimColor={!isOn}>{isOn ? '☑' : '☐'} {label}  </Text>
        </Button>
      )
      const head = (
        <Box flexDirection="column">
          {tabs}
          <Box>
            {toggle('Duration', shown.timeline, { timeline: !shown.timeline })}
            {toggle('Turns', shown.turns, { turns: !shown.turns })}
            {toggle('Calls', shown.calls, { calls: !shown.calls })}
            {toggle('Context', shown.context, { context: !shown.context })}
          </Box>
          {Input && (
            <Input key="trace-search" placeholder="Search" value={shown.q} onInput={(text: string) => set({ q: text, top: -1, sel: -1 })} onSubmit={() => undefined} />
          )}
        </Box>
      )
      if (trace.rows.length === 0) {
        return (
          <Box flexDirection="column">
            {head}
            <Text dimColor>No transcript found for this session yet.</Text>
          </Box>
        )
      }

      const list = visible(trace.rows, shown, shown.q)
      const size = Math.max(5, e.props.scroll.bodyRows - (shown.timeline ? 9 : 5))
      const maxStart = Math.max(0, list.length - size)
      const start = shown.top < 0 ? maxStart : Math.min(shown.top, maxStart)
      const shownRows = list.slice(start, start + size)
      const turnsInView = shownRows.filter(row => row.n > 0).map(row => row.n)
      const view: [number, number] = [Math.min(...turnsInView, Infinity), Math.max(...turnsInView, 0)]
      const width = Math.max(10, cols - 8)
      const map = lanes(trace.spans, width, view)

      type Cut = { glyph: string; color: string | undefined; band: boolean; len: number }
      const lane = (label: string, count: number, cellOf: (index: number) => { glyph: string; color?: string }) => {
        const runs: Cut[] = []
        for (let index = 0; index < count; index++) {
          const cell = cellOf(index)
          const band = map.band[index] === true
          const last = runs[runs.length - 1]
          if (last && last.glyph === cell.glyph && last.color === cell.color && last.band === band) last.len += 1
          else runs.push({ glyph: cell.glyph, color: cell.color, band, len: 1 })
        }
        return (
          <Box overflow="hidden">
            <Text dimColor>{label.padEnd(7)}</Text>
            {runs.map((run, index) => (
              <Text key={`${label}${index}`} color={run.color} backgroundColor={run.band ? COLORS.band : undefined}>
                {run.glyph.repeat(run.len)}
              </Text>
            ))}
          </Box>
        )
      }

      const body = shownRows.map((row, index) => {
        const at = start + index
        const prev = shownRows[index - 1]
        const first = row.n > 0 && (prev === undefined || prev.n !== row.n)
        const isSel = shown.sel === at
        const paint = COLORS[row.k]
        const gutter = first ? `Turn ${row.n}`.padEnd(8) : ' '.repeat(8)
        const label = row.k === 'tool' ? 'TOOL' : row.k.toUpperCase()
        const room = Math.max(8, cols - 8 - 12)
        const summary =
          row.k === 'tool' && row.result !== ''
            ? `${clip(row.text, Math.floor(room * 0.5))} → ${clip(row.result, room)}`
            : row.text
        return (
          <Box key={`r${at}`} flexDirection="column">
            <Button plain key={`row${at}`} onPress={() => set({ sel: isSel ? -1 : at })}>
              <Text dimColor>{gutter}</Text>
              {paint.bg === '' ? (
                <Text color={paint.fg} bold>{centre(label, 10)} </Text>
              ) : (
                <Text color={paint.fg} backgroundColor={paint.bg} bold>{centre(label, 10)}</Text>
              )}
              <Text> </Text>
              <Text color={row.err ? COLORS.error : undefined} dimColor={row.k === 'context'}>
                {clip(summary, room)}
              </Text>
            </Button>
            {isSel && (
              <Box flexDirection="column" paddingLeft={8} borderStyle="round" borderColor={paint.fg}>
                <Text color={paint.fg} bold>
                  {label}{row.ms > 0 ? ` · ${dur(row.ms)}` : ''}{row.err ? ' · failed' : ''}
                </Text>
                <Text>{row.text}</Text>
                {row.result !== '' && <Text color={row.err ? COLORS.error : undefined} dimColor={!row.err}>→ {row.result}</Text>}
              </Box>
            )}
          </Box>
        )
      })

      const shownCount = list.length === 0 ? 0 : start + 1
      return (
        <Box flexDirection="column">
          {head}
          {shown.timeline && (
            <Box flexDirection="column">
              {lane('Input', width, index => {
                const mark = map.input[index]
                return mark === '' || mark === undefined ? { glyph: ' ' } : { glyph: '▄', color: mark === 'g' ? 'gray' : COLORS.input }
              })}
              {lane('Model', width, index => ({ glyph: level(map.model[index] ?? 0), color: COLORS.model }))}
              {lane('Tools', width, index => ({ glyph: level(map.tools[index] ?? 0), color: map.fail[index] ? COLORS.fail : COLORS.work }))}
            </Box>
          )}
          <Text> </Text>
          {list.length === 0 ? <Text dimColor>Nothing matches.</Text> : body}
          <Text> </Text>
          <Box>
            <Button plain key="up" hotkey="k" onPress={() => set({ top: Math.max(0, start - Math.ceil(size / 2)), sel: -1 })}>[k] up</Button>
            <Text> </Text>
            <Button plain key="down" hotkey="j" onPress={() => set({ top: Math.min(maxStart, start + Math.ceil(size / 2)), sel: -1 })}>[j] down</Button>
            <Text> </Text>
            <Button plain key="latest" hotkey="l" onPress={() => set({ top: -1, sel: -1 })}>[l] latest</Button>
            <Text dimColor>  {shownCount}–{Math.min(list.length, start + size)} of {list.length}  </Text>
            <Button key="close" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>[x] close</Button>
          </Box>
        </Box>
      )
    }

    if (!traj) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{meta}</Text>
          <Text>{now.status === 'failed' ? now.error : 'Building the trajectory from this session…'}</Text>
          {controls}
        </Box>
      )
    }

    const stale = run.turns - now.turnsAtRun
    const section = (label: string) => (
      <Text bold color="cyan">
        {'\n'}
        {label}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {tabs}
        <Text bold>{traj.goal}</Text>
        <Text dimColor>
          {meta} · {ago(now.at)}
          {stale > 0 ? ` · ${stale} turn${stale === 1 ? '' : 's'} newer` : ''}
        </Text>
        {now.status === 'failed' && <Text color="red">{now.error}</Text>}
        <Text>
          <Text color="green">now </Text>
          {traj.now}
        </Text>

        {traj.phases.length > 0 && section('Phases')}
        {traj.phases.map((p, i) => (
          <Text key={`p${i}`}>
            <Text dimColor>{i + 1}. </Text>
            {p.title}
            <Text dimColor> — {p.outcome}</Text>
          </Text>
        ))}

        {traj.decisions.length > 0 && section('Decisions')}
        {traj.decisions.map((d, i) => (
          <Text key={`d${i}`}>
            <Text color="yellow">◆ </Text>
            {d.what}
            <Text dimColor> — {d.why}</Text>
          </Text>
        ))}

        {traj.open.length > 0 && section('Open questions')}
        {traj.open.map((o, i) => (
          <Text key={`o${i}`}>
            <Text color={o.blocking ? 'red' : 'yellow'}>{o.blocking ? '! ' : '? '}</Text>
            {o.q}
          </Text>
        ))}

        {traj.loose.length > 0 && section('Loose ends')}
        {traj.loose.map((l, i) => (
          <Text key={`l${i}`} dimColor>· {l}</Text>
        ))}

        {traj.next.length > 0 && section('Next')}
        {traj.next.map((n, i) => (
          <Text key={`n${i}`}>
            <Text color="green">→ </Text>
            {n}
          </Text>
        ))}
        <Text> </Text>
        {controls}
      </Box>
    )
  })
}
