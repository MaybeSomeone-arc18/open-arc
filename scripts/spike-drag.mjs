/**
 * Isolated Patch 2 Technical Spike: Pointer Tracking Across WebContentsView Boundaries.
 *
 * Runs a standalone Electron instance that:
 * 1. Creates a BrowserWindow (shell).
 * 2. Mounts two real WebContentsView instances side-by-side with an explicit 6px gap in the middle.
 * 3. Mounts a DOM divider element in the shell within that 6px gap.
 * 4. Listens for pointerdown, pointermove, pointerup, pointercancel, and blur on the divider with setPointerCapture.
 * 5. Uses webContents.sendInputEvent on the window to send a drag sequence starting in the gap
 *    and moving deep into the WebContentsView bounds.
 * 6. Records the exact event trace and reports whether setPointerCapture preserves the tracking stream.
 */
import { app, BrowserWindow, WebContentsView } from 'electron'

async function runSpike() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    webPreferences: {
      sandbox: true
    }
  })

  // Load a minimal shell page containing the divider in the gap
  await win.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin: 0; background: #17161c; overflow: hidden; height: 100vh; font-family: sans-serif; }
        #divider {
          position: fixed;
          top: 0;
          left: 497px;
          width: 6px;
          bottom: 0;
          background: #7c6cf0;
          cursor: col-resize;
          z-index: 10;
        }
      </style>
    </head>
    <body>
      <div id="divider"></div>
      <script>
        window.__events = [];
        const div = document.getElementById('divider');
        div.addEventListener('pointerdown', (e) => {
          div.setPointerCapture(e.pointerId);
          window.__events.push({ type: 'pointerdown', x: e.clientX, y: e.clientY, captured: div.hasPointerCapture(e.pointerId) });
        });
        div.addEventListener('pointermove', (e) => {
          window.__events.push({ type: 'pointermove', x: Math.round(e.clientX), y: Math.round(e.clientY), captured: div.hasPointerCapture(e.pointerId) });
        });
        div.addEventListener('pointerup', (e) => {
          window.__events.push({ type: 'pointerup', x: Math.round(e.clientX), y: Math.round(e.clientY) });
          try { div.releasePointerCapture(e.pointerId); } catch (_) {}
        });
        div.addEventListener('pointercancel', (e) => {
          window.__events.push({ type: 'pointercancel', x: Math.round(e.clientX), y: Math.round(e.clientY) });
        });
        window.addEventListener('blur', () => {
          window.__events.push({ type: 'window-blur' });
        });
      </script>
    </body>
    </html>
  `))

  // Attach two WebContentsView instances
  // Left: x=0, width=497, y=0, height=700
  // Gap: x=497, width=6
  // Right: x=503, width=497, y=0, height=700
  const viewLeft = new WebContentsView({ webPreferences: { sandbox: true } })
  const viewRight = new WebContentsView({ webPreferences: { sandbox: true } })

  win.contentView.addChildView(viewLeft)
  win.contentView.addChildView(viewRight)

  viewLeft.setBounds({ x: 0, y: 0, width: 497, height: 700 })
  viewRight.setBounds({ x: 503, y: 0, width: 497, height: 700 })

  // Track if child views receive pointer/mouse events during the drag
  await viewLeft.webContents.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><body style="background:#202028;color:#eee;"><p>Left WebContentsView</p>
    <script>
      window.__childEvents = [];
      window.addEventListener('mousemove', (e) => window.__childEvents.push('left-move:' + Math.round(e.clientX)));
      window.addEventListener('mousedown', (e) => window.__childEvents.push('left-down:' + Math.round(e.clientX)));
      window.addEventListener('mouseup', (e) => window.__childEvents.push('left-up:' + Math.round(e.clientX)));
    </script></body></html>
  `))

  await viewRight.webContents.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><body style="background:#202028;color:#eee;"><p>Right WebContentsView</p>
    <script>
      window.__childEvents = [];
      window.addEventListener('mousemove', (e) => window.__childEvents.push('right-move:' + Math.round(e.clientX)));
      window.addEventListener('mousedown', (e) => window.__childEvents.push('right-down:' + Math.round(e.clientX)));
      window.addEventListener('mouseup', (e) => window.__childEvents.push('right-up:' + Math.round(e.clientX)));
    </script></body></html>
  `))

  // Allow paint and layout to stabilize
  await new Promise((r) => setTimeout(r, 600))

  // 1. Send mouseDown at divider center (500, 350)
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: 500,
    y: 350,
    button: 'left',
    clickCount: 1
  })

  await new Promise((r) => setTimeout(r, 100))

  // 2. Drag into left child WebContentsView (300, 350)
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: 300,
    y: 350,
    button: 'left'
  })

  await new Promise((r) => setTimeout(r, 100))

  // 3. Drag across into right child WebContentsView (700, 350)
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: 700,
    y: 350,
    button: 'left'
  })

  await new Promise((r) => setTimeout(r, 100))

  // 4. Release mouse inside right child WebContentsView (700, 350)
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: 700,
    y: 350,
    button: 'left',
    clickCount: 1
  })

  await new Promise((r) => setTimeout(r, 200))

  // Inspect results
  const shellEvents = await win.webContents.executeJavaScript('window.__events')
  const leftChildEvents = await viewLeft.webContents.executeJavaScript('window.__childEvents')
  const rightChildEvents = await viewRight.webContents.executeJavaScript('window.__childEvents')

  console.log('=== SPIKE RESULTS ===')
  console.log('Shell Events on Divider:', JSON.stringify(shellEvents, null, 2))
  console.log('Left Child WebContentsView Events:', JSON.stringify(leftChildEvents))
  console.log('Right Child WebContentsView Events:', JSON.stringify(rightChildEvents))

  const sawDown = shellEvents.some((e) => e.type === 'pointerdown')
  const sawMoveLeft = shellEvents.some((e) => e.type === 'pointermove' && e.x === 300)
  const sawMoveRight = shellEvents.some((e) => e.type === 'pointermove' && e.x === 700)
  const sawUp = shellEvents.some((e) => e.type === 'pointerup')

  console.log('Pointer capture retained left move:', sawMoveLeft)
  console.log('Pointer capture retained right move:', sawMoveRight)
  console.log('Pointer capture retained release:', sawUp)

  app.quit()
  if (sawDown && sawMoveLeft && sawMoveRight && sawUp) {
    process.exit(0)
  } else {
    process.exit(1)
  }
}

runSpike().catch((err) => {
  console.error('Spike error:', err)
  process.exit(2)
})
