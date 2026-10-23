import React from 'react'
import { computeSplitPaneBounds } from '../../../shared/splitGeometry'

interface SplitDividerProps {
  sidebarVisible: boolean
  ratio: number
}

export function SplitDivider({ sidebarVisible, ratio }: SplitDividerProps): JSX.Element {
  const sidebarWidth = sidebarVisible ? 280 : 0

  // Position divider in shell coordinates matching TabLayer.computePaneBounds()
  const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1000
  const availWidth = Math.max(0, windowWidth - sidebarWidth)
  const bounds = computeSplitPaneBounds(availWidth, ratio)
  const leftPos = sidebarWidth + bounds.leftWidth

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only respond to primary (left) mouse clicks
    if (e.button !== 0) return
    e.preventDefault()
    window.openArc.startSplitDrag()
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    window.openArc.resetSplitRatio()
  }

  return (
    <div
      className="split-divider"
      style={{ left: `${leftPos}px` }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      title="Drag to resize split panes, double-click to reset"
    >
      <div className="split-divider-handle" />
    </div>
  )
}
