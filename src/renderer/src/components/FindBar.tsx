import { useEffect, useRef, useState } from 'react'

interface Props {
  onClose: () => void
}

export function FindBar({ onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ matches: number; activeMatchOrdinal: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => window.openArc.stopFind()
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim()) {
        window.openArc.findInPage(query).then(setResult)
      } else {
        window.openArc.stopFind()
        setResult(null)
      }
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  const next = (): void => {
    if (query.trim()) window.openArc.findInPage(query, true).then(setResult)
  }

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find in page"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); next() }
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="find-count">
        {query.trim() ? (result ? `${result.activeMatchOrdinal}/${result.matches}` : '…') : ''}
      </span>
      <button className="row-btn" title="Next match (Enter)" onClick={next}>↓</button>
      <button className="row-btn" title="Close (Esc)" onClick={onClose}>×</button>
    </div>
  )
}
