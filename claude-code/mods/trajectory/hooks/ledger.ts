import type { Row, Span } from '../types'

// The trace is reduced by scripts/ledger.py: a mod may not read a file over 4 MiB, and a long
// session's transcript is far larger. This file only lays the reduced data out.

export const dur = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

export const clock = (ms: number) => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export const clip = (text: string, max: number) =>
  max <= 1 ? '' : text.length > max ? `${text.slice(0, max - 1)}…` : text

export const centre = (text: string, width: number) => {
  const left = Math.max(0, Math.floor((width - text.length) / 2))
  return (' '.repeat(left) + text).padEnd(width)
}

export const COLORS = {
  system: { fg: '#b4b4bc', bg: '#3a3a40' },
  user: { fg: '#a9b8ff', bg: '#3a4778' },
  context: { fg: '#7fe3a6', bg: '#1f4a35' },
  assistant: { fg: '#cdb0ff', bg: '#46335f' },
  tool: { fg: '#e6b86a', bg: '' },
  error: '#ff7b72',
  input: '#7f93ea',
  model: '#8f74d6',
  work: '#4fb477',
  fail: '#e5584f',
  band: '#2c3350',
} as const

const BLOCKS = ' ▁▂▃▄▅▆▇█'
export const level = (fraction: number) => BLOCKS[Math.max(fraction > 0 ? 1 : 0, Math.min(8, Math.round(fraction * 8)))] ?? ' '

export type Lanes = {
  model: number[] // 0..1, the share of each column's slice the model was running
  tools: number[] // 0..1, the share the tools were running
  fail: boolean[] // a tool failed in this slice
  input: ('' | 'g' | 'i')[] // where a prompt arrived; g is the first
  band: boolean[] // the turns now on screen
}

// Idle time between turns is the person thinking, so the timeline lays out only the time the model and
// the tools were busy, and gives each column the share of its slice spent in each. A few hundred steps
// share a few dozen columns, so a bar's height says what the slice was bound by.
export function lanes(spans: Span[], width: number, view: [number, number]): Lanes {
  const model: number[] = Array(width).fill(0)
  const tools: number[] = Array(width).fill(0)
  const fail: boolean[] = Array(width).fill(false)
  const input: Lanes['input'] = Array(width).fill('')
  const band: boolean[] = Array(width).fill(false)

  let total = 0
  for (const [, kind, ms] of spans) if (kind !== 'i') total += ms
  if (total <= 0 || width <= 0) return { model, tools, fail, input, band }

  const slice = total / width
  const col = (offset: number) => Math.min(width - 1, Math.floor(offset / slice))
  const first = new Map<number, number>()
  const last = new Map<number, number>()
  let at = 0
  let isFirstInput = true
  for (const [turn, kind, ms] of spans) {
    if (!first.has(turn)) first.set(turn, at)
    if (kind === 'i') {
      input[col(at)] = isFirstInput ? 'g' : 'i'
      isFirstInput = false
      continue
    }
    const bucket = kind === 'm' ? model : tools
    for (let c = col(at); c <= col(at + ms); c++) {
      const overlap = Math.min(at + ms, (c + 1) * slice) - Math.max(at, c * slice)
      if (overlap > 0) bucket[c] = (bucket[c] ?? 0) + overlap / slice
      if (kind === 'e') fail[c] = true
    }
    last.set(turn, at + ms)
    at += ms
  }
  const start = first.get(view[0])
  const end = last.get(view[1]) ?? start
  if (start !== undefined && end !== undefined) {
    for (let c = col(start); c <= col(end); c++) band[c] = true
  }
  return { model, tools, fail, input, band }
}

export function visible(rows: Row[], show: { turns: boolean; calls: boolean; context: boolean }, query: string) {
  const needle = query.trim().toLowerCase()
  return rows.filter(row => {
    if (row.k === 'tool' ? !show.calls : row.k === 'context' ? !show.context : !show.turns) return false
    if (needle === '') return true
    return `${row.text} ${row.result}`.toLowerCase().includes(needle)
  })
}
