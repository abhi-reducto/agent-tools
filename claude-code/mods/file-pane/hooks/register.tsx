import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { PaneItem, PaneKind } from '../types'

const PANE = 'file-pane'
const TOOL = 'mcp__file-pane__show'
const TMP = '/tmp/file-pane'
// Change a tag when the fields of what it holds change: it declines what an
// earlier version stored, which outlives a reload.
const current = atom({ plugin: 'file-pane', key: 'item' } as const, null, {
  shape: 'item-1',
})
const back = atom({ plugin: 'file-pane', key: 'back' } as const, [], {
  shape: 'back-1',
})

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'ico'])
const KINDS: readonly PaneKind[] = ['file', 'diff', 'dir', 'image', 'markdown', 'code', 'mermaid']
const CAP = 90000
// Claude Code only sends real images when it detects a capable terminal, or when
// this variable forces it; until then the picture is painted as half-block cells,
// which any true-color terminal shows.
const FORCE_IMAGES = 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES'
let isNativeCache: boolean | undefined
async function isNative($: EngineInterface) {
  if (isNativeCache !== undefined) return isNativeCache
  try {
    isNativeCache = (await $.process.run(['printenv', FORCE_IMAGES])).stdout.trim() !== ''
  } catch {
    isNativeCache = false
  }

  return isNativeCache
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const ext = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase()
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`
const parent = (p: string) => {
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')

  return i < 0 ? '.' : i === 0 ? '/' : t.slice(0, i)
}
const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0

  return h.toString(16)
}

// "src/a.ts", "src/a.ts:40", "src/a.ts:40-52", "--diff src/a.ts"
const parse = (spec: string) => {
  const raw = spec.trim()
  const isDiff = /^(--diff|-d)\s+/.test(raw)
  const rest = raw.replace(/^(--diff|-d)\s+/, '')
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(rest)

  return {
    path: m?.[1] ?? rest,
    line: m?.[2] ? Number(m[2]) : undefined,
    endLine: m?.[3] ? Number(m[3]) : undefined,
    isDiff,
  }
}

type Target = {
  path?: string
  content?: string
  title?: string
  kind?: PaneKind
  language?: string
  line?: number
  endLine?: number
  note?: string
  isDiff?: boolean
}

// Where a path lands, absolute, and what it is.
async function resolve($: EngineInterface, path: string) {
  const st = await $.fs.stat(path, { resolve: true })

  return { kind: st.kind, abs: st.realPath ?? path, mtime: Math.floor(st.mtimeMs) }
}

// The file's changes against HEAD (staged and unstaged), as unified hunks.
async function diffOf($: EngineInterface, path: string) {
  const { abs } = await resolve($, path)
  const ran = await $.process.run(['git', 'diff', 'HEAD', '--', basename(abs)], { cwd: parent(abs) })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'git diff failed')
  if (ran.stdout.trim() === '') throw new Error(`no changes against HEAD in ${path}`)
  // The element draws 100000 characters at most, and a diff cut mid-hunk does
  // not parse, so cut at the last hunk that fits.
  if (ran.stdout.length <= CAP) return ran.stdout
  const cut = ran.stdout.lastIndexOf('\n@@', CAP)

  return cut > 0 ? ran.stdout.slice(0, cut + 1) : ran.stdout.slice(0, CAP)
}

const dims = new Map<string, readonly [number, number]>()
// The terminal may be across ssh, where it cannot read a file here, so a PNG
// small enough (2 MiB decoded) travels in the tree as base64 instead.
const MAX_INLINE = 2 * 1024 * 1024
const inline = new Map<string, string>()

// A PNG file the terminal can draw for an image path, and its pixel size.
// Other formats are converted with whichever tool the machine has.
async function pngOf($: EngineInterface, path: string) {
  const { abs, mtime } = await resolve($, path)
  let file = abs
  if (ext(abs) !== 'png') {
    file = `${TMP}/${hash(`${abs}:${mtime}`)}.png`
    if (!(await $.fs.exists(file))) {
      await $.process.run(['mkdir', '-p', TMP])
      const tries: string[][] = [
        ['sips', '-s', 'format', 'png', abs, '--out', file],
        ['magick', `${abs}[0]`, file],
        ['convert', `${abs}[0]`, file],
        ['ffmpeg', '-y', '-i', abs, '-frames:v', '1', file],
        ['rsvg-convert', '-o', file, abs],
      ]
      let isDone = false
      for (const argv of tries) {
        try {
          const ran = await $.process.run(argv)
          if (ran.exitCode === 0 && (await $.fs.exists(file))) {
            isDone = true
            break
          }
        } catch {
          // The tool is not installed: try the next.
        }
      }
      if (!isDone) {
        throw new Error(`cannot convert .${ext(abs)} to PNG here: install ImageMagick, ffmpeg or librsvg`)
      }
    }
  }
  const key = `${file}:${mtime}`
  let size = dims.get(key)
  if (!size) {
    const out = (await $.process.run(['file', '-b', file])).stdout
    const m = /(\d+)\s*x\s*(\d+)/.exec(out)
    if (!m) throw new Error(`not a readable image: ${path}`)
    size = [Number(m[1]), Number(m[2])] as const
    dims.set(key, size)
  }

  let png = inline.get(key)
  if (png === undefined && (await $.fs.stat(file)).size <= MAX_INLINE) {
    png = (await $.fs.read(file, { as: 'bytes' })).base64
    if (inline.size >= 8) inline.clear()
    inline.set(key, png)
  }

  return { file, w: size[0], h: size[1], generation: mtime % 2147483647, png }
}

// A PNG of mermaid source, when the machine has mmdc; else undefined.
async function mermaidPng($: EngineInterface, source: string) {
  const key = hash(source)
  const png = `${TMP}/${key}.png`
  if (await $.fs.exists(png)) return png
  try {
    await $.process.run(['mkdir', '-p', TMP])
    await $.fs.write(`${TMP}/${key}.mmd`, source)
    const ran = await $.process.run(['mmdc', '-i', `${TMP}/${key}.mmd`, '-o', png, '-b', 'white', '-s', '2'])
    if (ran.exitCode === 0 && (await $.fs.exists(png))) return png
  } catch {
    // mmdc is not installed.
  }

  return undefined
}

// The pane is tall and narrow, so a left-to-right flowchart is drawn top-down.
const vertical = (source: string) => source.replace(/^(\s*)(graph|flowchart)\s+(LR|RL)\b/, '$1$2 TB')

const mermaidSource = async ($: EngineInterface, item: PaneItem) =>
  vertical(item.content !== '' ? item.content : await $.fs.read(item.path))

async function build($: EngineInterface, t: Target): Promise<{ item: PaneItem; warning?: string }> {
  const base = {
    title: t.title ?? '',
    path: '',
    content: '',
    language: t.language ?? '',
    note: t.note ?? '',
    line: 1,
    endLine: 1,
    start: 1,
  }
  if (t.content !== undefined) {
    const kind: PaneKind =
      t.kind ??
      (t.language === 'mermaid' ? 'mermaid' : t.language && t.language !== 'markdown' ? 'code' : 'markdown')
    const item: PaneItem = { ...base, kind, title: base.title || kind, content: t.content.slice(0, CAP) }

    return { item, warning: kind === 'mermaid' ? await mermaidWarning($, item) : undefined }
  }
  if (!t.path) throw new Error('give a path or content')
  const { kind: found } = await resolve($, t.path)
  const title = base.title || basename(t.path)
  if (found === 'dir') return { item: { ...base, kind: 'dir', title, path: t.path } }
  if (t.isDiff) {
    await diffOf($, t.path)

    return { item: { ...base, kind: 'diff', title, path: t.path } }
  }
  const e = ext(t.path)
  if (t.kind === 'image' || (!t.kind && IMAGE.has(e))) {
    await pngOf($, t.path)

    return { item: { ...base, kind: 'image', title, path: t.path } }
  }
  if (t.kind === 'mermaid' || (!t.kind && (e === 'mmd' || e === 'mermaid'))) {
    const item: PaneItem = { ...base, kind: 'mermaid', title, path: t.path }

    return { item, warning: await mermaidWarning($, item) }
  }
  const total = (await $.fs.read(t.path)).split('\n').length
  const isMarkdown = e === 'md' || e === 'markdown'
  const kind: PaneKind = t.kind ?? (isMarkdown && t.line === undefined ? 'markdown' : 'file')
  const line = clamp(t.line ?? 1, 1, total)
  const endLine = clamp(t.endLine ?? line, line, total)

  return { item: { ...base, kind, title, path: t.path, line, endLine, start: Math.max(1, line - 6) } }
}

const mermaidWarning = async ($: EngineInterface, item: PaneItem) =>
  (await mermaidPng($, await mermaidSource($, item)))
    ? undefined
    : 'mermaid-cli (mmdc) is not installed, so the diagram source is shown instead of a rendering'

async function go($: EngineInterface, item: PaneItem, isPush = true) {
  const cur = await read($, current)
  if (cur && isPush) await update($, back, list => [...list, cur].slice(-20))
  await update($, current, () => item)
  await $.ui.open({ id: PANE, title: item.title })
}

async function goBack($: EngineInterface) {
  const prev = (await read($, back)).at(-1)
  if (!prev) return
  await update($, back, list => list.slice(0, -1))
  await update($, current, () => prev)
  await $.ui.open({ id: PANE, title: prev.title })
}

const summary = (item: PaneItem) => {
  const what =
    item.kind === 'file'
      ? `${item.path}:${item.line}${item.endLine > item.line ? `-${item.endLine}` : ''}`
      : item.kind === 'diff'
        ? `the diff of ${item.path}`
        : item.path || `${item.kind} "${item.title}"`

  return `Showing ${what} in the person's side pane.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'show',
      description: 'Open a file, folder, image or diff in the side pane: /show [--diff] path[:line[-end]]',
    })
    await $.tool.register({
      name: 'show',
      description:
        'Put something in the side pane next to the chat, where the person can look at it: ' +
        'a file (syntax highlighted, with lines highlighted), a directory they can navigate, ' +
        'an image (PNG; other formats need ImageMagick/ffmpeg), a git diff, a markdown ' +
        'write-up, a code snippet, or a mermaid diagram. Use it whenever you point at code ' +
        'or want to show something you made: pass path for something on disk, or content ' +
        '(with kind/language) for something you wrote yourself. For a file, pass line (and ' +
        'end_line) to highlight what you are referring to. The pane is tall and narrow: write ' +
        'mermaid flowcharts top-down (graph TD), not left-to-right, and keep labels short.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory on disk, absolute or relative to the working directory.' },
          content: { type: 'string', description: 'Text to show instead of a path: markdown by default, or code when language is set, or a mermaid diagram.' },
          title: { type: 'string', description: 'Pane title for inline content.' },
          kind: { type: 'string', enum: [...KINDS], description: 'Override how it is shown; normally detected.' },
          language: { type: 'string', description: "For inline content: 'mermaid', 'markdown', or a code language such as 'ts' or 'python'." },
          line: { type: 'number', description: 'First line to highlight in a file (1-based).' },
          end_line: { type: 'number', description: 'Last line of the highlighted range.' },
          note: { type: 'string', description: 'One short sentence shown above it saying why you are showing it.' },
          diff: { type: 'boolean', description: "Show the file's uncommitted changes against HEAD as a colored diff." },
        },
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'show' }, async ($, e) => {
    const t = parse(e.args)
    if (!t.path) return { text: 'Usage: /show [--diff] path[:line[-end]]' }
    try {
      const { item, warning } = await build($, t)
      await go($, item)

      return { text: summary(item) + (warning ? ` Note: ${warning}.` : '') }
    } catch (err) {
      return { text: `Could not open ${t.path}: ${errorText(err)}` }
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as {
      path?: string
      content?: string
      title?: string
      kind?: string
      language?: string
      line?: number
      end_line?: number
      note?: string
      diff?: boolean
    }
    try {
      const kind = KINDS.find(k => k === input.kind)
      const { item, warning } = await build($, {
        path: input.path,
        content: input.content,
        title: input.title,
        kind,
        language: input.language,
        line: input.line,
        endLine: input.end_line,
        note: input.note,
        isDiff: input.diff,
      })
      await go($, item)

      return { result: summary(item) + (warning ? ` Note: ${warning}.` : '') }
    } catch (err) {
      return { deny: `show failed: ${errorText(err)}` }
    }
  }).catch(() => ({ deny: 'show failed.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    const item = await read($, current)
    if (!item) return <Text dimColor>Nothing shown yet. Try /show path[:line]</Text>

    const history = await read($, back)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const bodyColumns = e.props.bodyColumns
    const fail = (err: unknown) => $.ui.toast(errorText(err))
    const open = (path: string) =>
      void build($, { path })
        .then(({ item: next }) => go($, next))
        .catch(fail)

    const note = item.note !== '' && <Text color="warning" wrap="wrap">{item.note}</Text>
    const Chrome = (props: { sub: string }) => (
      <Box flexDirection="column">
        <Box>
          <Text bold>{item.title}</Text>
          <Text dimColor> · {props.sub}</Text>
        </Box>
        {note}
      </Box>
    )
    const nav = (
      <Box>
        {history.length > 0 && (
          <Button key="back" hotkey="b" onPress={() => void goBack($)}>[b] back</Button>
        )}
        {history.length > 0 && item.path !== '' && <Text> </Text>}
        {item.path !== '' && (
          <Button key="parent" hotkey="o" onPress={() => open(parent(item.path))}>
            {item.kind === 'dir' ? '[o] up a folder' : '[o] folder'}
          </Button>
        )}
      </Box>
    )
    const frame = (sub: string, body: RenderChildren, footer?: RenderChildren) => (
      <Box flexDirection="column">
        <Chrome sub={sub} />
        {body}
        {footer}
        {nav}
      </Box>
    )

    // A picture sized to the room at the terminal's roughly 1:2 cell shape.
    const picture = async (img: { file: string; w: number; h: number; generation: number; png?: string }) => {
      if (e.surface !== 'terminal') return <Text dimColor>Images show in the terminal only.</Text>
      const room = Math.max(4, bodyRows - 5)
      let cols = Math.min(Math.max(10, bodyColumns), 120)
      let rows = Math.ceil((cols * img.h) / img.w / 2)
      if (rows > room) {
        rows = room
        cols = Math.max(1, Math.floor((rows * 2 * img.w) / img.h))
      }
      cols = clamp(cols, 1, 255)
      rows = clamp(rows, 1, 255)

      if (await isNative($)) {
        const { Image } = $.ui.resolve(e)

        return (
          <Image
            key="image"
            source={img.png ? { png: img.png } : { file: img.file, format: 'png', generation: img.generation }}
            columns={cols}
            rows={rows}
            alt={`[image ${img.w}×${img.h}: ${item.title}]`}
          />
        )
      }
      const { Raster } = $.ui.resolve(e)
      const ran = await $.process.run(
        ['python3', `${$.plugin.root}/scripts/png2cells.py`, img.file, String(cols), String(rows)],
        { timeoutMs: 60000 },
      )
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'could not draw the image')

      return <Raster key="image" columns={cols} rows={rows} cells={ran.stdout.trim()} />
    }

    try {
      if (item.kind === 'diff') {
        const diff = await diffOf($, item.path)

        return frame('git diff HEAD', <Code source={diff} format="diff" path={item.path} wrap="truncate-end" />)
      }

      if (item.kind === 'image') {
        const img = await pngOf($, item.path)

        return frame(`${img.w}×${img.h}`, await picture(img))
      }

      if (item.kind === 'mermaid') {
        const source = await mermaidSource($, item)
        const png = await mermaidPng($, source)
        if (png) {
          const img = await pngOf($, png)

          return frame('mermaid', await picture(img))
        }

        return frame(
          'mermaid source (install mermaid-cli to render)',
          <Code source={source} language="mermaid" wrap="truncate-end" />,
        )
      }

      if (item.kind === 'markdown') {
        const text = item.content !== '' ? item.content : (await $.fs.read(item.path)).slice(0, CAP)

        return frame('markdown', <Markdown text={text} />)
      }

      if (item.kind === 'code') {
        return frame(
          item.language || 'code',
          <Code source={item.content} language={item.language || undefined} startLine={1} wrap="truncate-end" />,
        )
      }

      if (item.kind === 'dir') {
        const entries = [...(await $.fs.list(item.path))].sort(
          (a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name),
        )
        const rows = Math.max(5, bodyRows - 6)
        const total = entries.length
        const start = clamp(item.start, 1, total - rows + 1)
        const shown = entries.slice(start - 1, start - 1 + rows)
        const move = (to: number) =>
          update($, current, cur => (cur ? { ...cur, start: clamp(to, 1, total - rows + 1) } : cur))

        return frame(
          `${item.path} · ${total} entries${total > rows ? ` · ${start}-${start + shown.length - 1}` : ''}`,
          <Box flexDirection="column">
            {total === 0 && <Text dimColor>(empty)</Text>}
            {shown.map(entry => (
              <Button key={`e:${entry.name}`} onPress={() => open(join(item.path, entry.name))}>
                {entry.kind === 'dir' ? '▸ ' : '  '}{entry.name}{entry.kind === 'dir' ? '/' : ''}
              </Button>
            ))}
          </Box>,
          total > rows && (
            <Box>
              <Button key="up" hotkey="u" onPress={() => void move(start - rows)}>[u] page up</Button>
              <Text> </Text>
              <Button key="down" hotkey="d" onPress={() => void move(start + rows)}>[d] page down</Button>
            </Box>
          ),
        )
      }

      // A file: windowed around its pinned lines.
      const lines = (await $.fs.read(item.path)).split('\n')
      const total = lines.length
      // Header, note, footer rows and the pinned block's frame.
      const rows = Math.max(5, bodyRows - 7)
      const start = clamp(item.start, 1, total - rows + 1)
      const end = Math.min(total, start + rows - 1)
      const pinFrom = clamp(item.line, start, end)
      const pinTo = clamp(item.endLine, pinFrom, end)
      const isPinShown = item.line <= end && item.endLine >= start
      const range = item.endLine > item.line ? `${item.line}-${item.endLine}` : `${item.line}`
      const move = (to: number) =>
        update($, current, cur => (cur ? { ...cur, start: clamp(to, 1, total - rows + 1) } : cur))
      const code = (from: number, to: number) => (
        <Code source={lines.slice(from - 1, to).join('\n')} path={item.path} startLine={from} wrap="truncate-end" />
      )

      return frame(
        `lines ${start}-${end} of ${total} · pinned ${range}`,
        isPinShown ? (
          <Box flexDirection="column">
            {pinFrom > start && code(start, pinFrom - 1)}
            <Box flexDirection="column" borderStyle="single" borderColor="warning">
              {code(pinFrom, pinTo)}
            </Box>
            {pinTo < end && code(pinTo + 1, end)}
          </Box>
        ) : (
          code(start, end)
        ),
        <Box>
          <Button key="up" hotkey="u" onPress={() => void move(start - rows)}>[u] page up</Button>
          <Text> </Text>
          <Button key="down" hotkey="d" onPress={() => void move(start + rows)}>[d] page down</Button>
          <Text> </Text>
          <Button key="pin" hotkey="p" onPress={() => void move(item.line - 6)}>[p] back to pin</Button>
        </Box>,
      )
    } catch (err) {
      return frame('error', <Text color="error">{errorText(err)}</Text>)
    }
  })
}
