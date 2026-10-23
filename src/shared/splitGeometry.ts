/**
 * Pure mathematical calculation of split pane bounds given available content width and ratio.
 * Used symmetrically by main process (TabLayer) and renderer (SplitDivider).
 */

export const DIVIDER_WIDTH = 6
export const MIN_PANE_WIDTH = 260

export interface SplitPaneBounds {
  leftWidth: number
  rightWidth: number
  dividerWidth: number
}

export function computeSplitPaneBounds(availWidth: number, ratio: number): SplitPaneBounds {
  const divWidth = DIVIDER_WIDTH
  const minPane = MIN_PANE_WIDTH
  const minCombined = minPane * 2

  if (availWidth <= divWidth) {
    return { leftWidth: 0, rightWidth: 0, dividerWidth: divWidth }
  }

  const usableWidth = availWidth - divWidth
  let leftWidth: number
  let rightWidth: number

  if (usableWidth < minCombined) {
    // Deterministic equal-split fallback for narrow windows
    leftWidth = Math.floor(usableWidth / 2)
    rightWidth = usableWidth - leftWidth
  } else {
    const clampedRatio = Math.max(0.1, Math.min(0.9, Number.isFinite(ratio) ? ratio : 0.5))
    const ideal = Math.round(usableWidth * clampedRatio)
    leftWidth = Math.max(minPane, Math.min(usableWidth - minPane, ideal))
    rightWidth = usableWidth - leftWidth
  }

  return { leftWidth, rightWidth, dividerWidth: divWidth }
}
