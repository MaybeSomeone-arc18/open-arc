import { useEffect, useState } from 'react'
import type { CommandDef } from '../../../shared/types'

interface Props {
  onClose: () => void
}

/** Keyboard shortcut reference, opened with Ctrl+/ and closed with Esc or a click outside. */
export function ShortcutsOverlay({ onClose }: Props): JSX.Element {
  const [commands, setCommands] = useState<CommandDef[]>([])

  useEffect(() => {
    window.openArc.listCommands().then(setCommands)
  }, [])

  return (
    <div className="command-overlay shortcuts-overlay" onClick={onClose}>
      <div className="command-bar shortcuts-panel" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-title">Shortcuts &amp; commands</div>
        <div className="command-rows">
          {commands.map((c) => (
            <div key={c.id} className="command-row shortcuts-row">
              <span>{c.title}</span>
              {c.hint && <span className="command-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
