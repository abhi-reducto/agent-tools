export type Phase = { title: string; outcome: string }
export type Decision = { what: string; why: string }
export type Question = { q: string; blocking: boolean }

export type Trajectory = {
  goal: string
  now: string
  phases: Phase[]
  decisions: Decision[]
  open: Question[]
  loose: string[]
  next: string[]
}

export type View = {
  status: 'idle' | 'working' | 'failed'
  traj: Trajectory | null
  error: string
  at: number
  turnsAtRun: number
}

export type Stats = { turns: number; tools: number; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    trajectory: { view: Shaped<View>; stats: Shaped<Stats>; ui: Shaped<Ui> }
  }
}

export type RowKind = 'system' | 'user' | 'context' | 'assistant' | 'tool'

export type Row = {
  k: RowKind
  n: number
  at: number
  ms: number
  text: string
  result: string
  err: boolean
}

// [turn, kind, ms]: i a prompt arrived, m the model ran, t a tool ran, e a tool failed
export type Span = [number, 'i' | 'm' | 't' | 'e', number]

export type Trace = { rows: Row[]; spans: Span[] }

export type Ui = {
  tab: 'overview' | 'trace'
  top: number
  sel: number
  q: string
  timeline: boolean
  turns: boolean
  calls: boolean
  context: boolean
}
