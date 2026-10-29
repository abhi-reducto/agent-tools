export type PaneKind =
  | 'file'
  | 'diff'
  | 'dir'
  | 'image'
  | 'markdown'
  | 'code'
  | 'mermaid'

export type PaneItem = {
  kind: PaneKind
  title: string
  // '' for inline content
  path: string
  // Inline text for markdown, code and mermaid; '' otherwise.
  content: string
  language: string
  note: string
  line: number
  endLine: number
  // First line (file) or first entry (dir) in the window.
  start: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-pane': {
      item: Shaped<PaneItem | null>
      back: Shaped<PaneItem[]>
    }
  }
}
