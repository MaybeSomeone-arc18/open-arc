import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, CommandDef } from '../../../shared/types'

interface Props {
  state: AppState
  onClose: () => void
}

interface Row {
  kind: 'open-url' | 'command' | 'tab'
  id: string
  title: string
  hint?: string
}

export function CommandBar({ state, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [commands, setCommands] = useState<CommandDef[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.openArc.listCommands().then(setCommands)
    inputRef.current?.focus()
  }, [])

  const allTabs = useMemo(
    () =>
      state.spaces.flatMap((s) =>
        [...s.pinned, ...s.today].map((t) => ({ ...t, spaceName: s.name, spaceId: s.id }))
      ),
    [state]
  )

  const rows = useMemo((): Row[] => {
    const q = query.trim().toLowerCase()
    const out: Row[] = []
    if (q.length > 0) {
      out.push({ kind: 'open-url', id: 'open-url', title: `Open "${query.trim()}"`, hint: 'URL or search' })
    }
    for (const c of commands) {
      if (!q || c.title.toLowerCase().includes(q)) {
        out.push({ kind: 'command', id: c.id, title: c.title, hint: c.hint })
      }
    }
    for (const t of allTabs) {
      if (q && (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))) {
        out.push({ kind: 'tab', id: t.id, title: t.title || t.url, hint: t.spaceName })
      }
    }
    return out.slice(0, 12)
  }, [query, commands, allTabs])

  useEffect(() => setSelected(0), [query])

  const run = (row: Row): void => {
    if (row.kind === 'open-url') window.openArc.openTab(query.trim())
    if (row.kind === 'command') window.openArc.runCommand(row.id, row.id === 'new-space' ? query.trim() : undefined)
    if (row.kind === 'tab') window.openArc.switchTab(row.id)
    onClose()
  }

  return (
    <div className="command-overlay" onClick={onClose}>
      <div className="command-bar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-input"
          placeholder="Type a command, search tabs, or enter a URL…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, rows.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
            if (e.key === 'Enter' && rows[selected]) run(rows[selected])
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="command-rows">
          {rows.map((row, i) => (
            <div
              key={`${row.kind}-${row.id}`}
              className={`command-row ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(row)}
            >
              <span>{row.title}</span>
              {row.hint && <span className="command-hint">{row.hint}</span>}
            </div>
          ))}
          {rows.length === 0 && <div className="command-row empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}
