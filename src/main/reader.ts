/**
 * Reader mode extractor. Injected into the tab page as a stringified,
 * self-contained vanilla-JS function (no imports, no TS). Toggling on:
 * finds the most text-dense container, clones its readable blocks into a
 * clean overlay; toggling off removes it. Returns 'on' | 'off' | 'no-content'.
 */
export function readerToggle(): string {
  const w = window as unknown as { __oaReaderOn?: boolean }
  const OVERLAY_ID = 'oa-reader-overlay'
  const existing = document.getElementById(OVERLAY_ID)
  if (existing || w.__oaReaderOn) {
    existing?.remove()
    w.__oaReaderOn = false
    return 'off'
  }

  const textLen = (el: Element): number => {
    let n = 0
    el.querySelectorAll('p').forEach((p) => {
      n += (p.textContent ?? '').trim().length
    })
    return n
  }
  const candidates = Array.from(document.querySelectorAll('article, main, [role="main"], #content, #bodyContent, .article, .post, .content, section, div'))
  let best: Element | null = null
  let bestLen = 400 // minimum viable article
  for (const el of candidates) {
    const n = textLen(el)
    if (n > bestLen) {
      best = el
      bestLen = n
    }
  }
  if (!best) return 'no-content'

  const title = document.querySelector('h1')?.textContent?.trim() || document.title
  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.className = 'oa-reader'
  overlay.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:2147483647;background:#faf8f5;color:#1c1c1e;overflow-y:auto;' +
      'font:18px/1.7 Georgia,serif;padding:48px 16px;box-sizing:border-box;'
  )
  const col = document.createElement('div')
  col.setAttribute('style', 'max-width:680px;margin:0 auto;')
  const h = document.createElement('h1')
  h.textContent = title
  h.setAttribute('style', 'font:700 32px/1.25 Georgia,serif;margin:0 0 24px;')
  col.appendChild(h)
  const SELECTOR = 'p, h2, h3, blockquote, pre, ul, ol'
  best.querySelectorAll(SELECTOR).forEach((node) => {
    // Skip blocks nested inside another selected block: the parent's clone
    // already contains them (nested lists would otherwise appear twice).
    const parent = node.parentElement
    if (parent && parent.closest(SELECTOR) && best.contains(parent.closest(SELECTOR))) return
    const text = (node.textContent ?? '').trim()
    if (text.length < 2) return
    // Skip navigation-like lists (tables of contents, link lists): most
    // items are dominated by an anchor. Whole-list text ratios miss these
    // when items carry non-link chrome (toggle buttons, badges).
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      const items = Array.from(node.children).filter((c) => c.tagName === 'LI')
      if (items.length > 0) {
        let linkItems = 0
        for (const li of items) {
          const liText = (li.textContent ?? '').trim().length
          let aLen = 0
          li.querySelectorAll('a').forEach((a) => {
            aLen += (a.textContent ?? '').trim().length
          })
          if (liText > 0 && aLen / liText > 0.5) linkItems++
        }
        if (linkItems / items.length > 0.6) return
      }
    }
    const clone = node.cloneNode(true) as HTMLElement
    clone.removeAttribute('style')
    clone.removeAttribute('class')
    clone.querySelectorAll('script, style, sup').forEach((x) => x.remove())
    clone.setAttribute('style', 'margin:0 0 18px;')
    col.appendChild(clone)
  })
  const hint = document.createElement('div')
  hint.textContent = 'Reader mode - press the shortcut again to exit'
  hint.setAttribute('style', 'margin:32px 0 0;font:13px sans-serif;color:#888;')
  col.appendChild(hint)
  overlay.appendChild(col)
  document.body.appendChild(overlay)
  w.__oaReaderOn = true
  return 'on'
}
