/**
 * Isolated Patch 2 Technical Spike 2: Option B (Native Drag Shield WebContentsView)
 * & Option C (Screen cursor polling + release detection analysis).
 *
 * Evaluates:
 * 1. Can a transparent WebContentsView attached over the content area intercept
 *    all mouse movements and the mouseUp event while child views remain visible below it?
 * 2. Does it release cleanly and allow focus to restore to the intended tab?
 * 3. Does Option C (screen.getCursorScreenPoint()) provide a reliable mouse-up/release detection mechanism?
 */
import { app, BrowserWindow, WebContentsView, screen } from 'electron'

async function runSpike2() {
  await app.whenReady()

  // ---- INVESTIGATING OPTION C FIRST ----
  console.log('=== INVESTIGATING OPTION C ===')
  const pt = screen.getCursorScreenPoint()
  console.log('screen.getCursorScreenPoint():', pt)
  // Check if screen or any Electron API exposes global mouse button state
  const hasButtonState = typeof screen.getCursorButtonState === 'function' ||
                         typeof screen.isButtonPressed === 'function'
  console.log('Electron screen API exposes global mouse button state:', hasButtonState)

  // ---- INVESTIGATING OPTION B (Native Drag Shield WebContentsView) ----
  console.log('\n=== INVESTIGATING OPTION B (Native Drag Shield) ===')
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: true,
    webPreferences: { sandbox: true }
  })

  // Load shell page
  await win.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><body style="margin:0;background:#17161c;overflow:hidden;">
      <div id="shell" style="height:100vh;display:flex;">
        <div style="width:280px;background:#201f27;color:#aaa;padding:20px;">Sidebar</div>
        <div style="flex:1;position:relative;"></div>
      </div>
    </body></html>
  `))

  // Create two pane WebContentsViews
  const viewLeft = new WebContentsView({ webPreferences: { sandbox: true } })
  const viewRight = new WebContentsView({ webPreferences: { sandbox: true } })

  win.contentView.addChildView(viewLeft)
  win.contentView.addChildView(viewRight)

  // Bounds: Left pane (280 to 637, width 357), Divider gap (637 to 643, width 6), Right pane (643 to 1000, width 357)
  viewLeft.setBounds({ x: 280, y: 0, width: 357, height: 700 })
  viewRight.setBounds({ x: 643, y: 0, width: 357, height: 700 })

  await viewLeft.webContents.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><body style="background:#282634;color:#fff;margin:20px;">
      <h2>Left Split Pane</h2><button id="btn1">Button 1</button>
      <script>
        window.__events = [];
        window.addEventListener('mousemove', (e) => window.__events.push('left-move:' + e.clientX));
        window.addEventListener('mousedown', (e) => window.__events.push('left-down'));
      </script>
    </body></html>
  `))

  await viewRight.webContents.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><body style="background:#1e2430;color:#fff;margin:20px;">
      <h2>Right Split Pane</h2><button id="btn2">Button 2</button>
      <script>
        window.__events = [];
        window.addEventListener('mousemove', (e) => window.__events.push('right-move:' + e.clientX));
        window.addEventListener('mousedown', (e) => window.__events.push('right-down'));
      </script>
    </body></html>
  `))

  await new Promise((r) => setTimeout(r, 600))

  // Now simulate user initiating a divider drag at x=640 (in the gap)
  console.log('Attaching native drag shield WebContentsView...')
  const shield = new WebContentsView({
    webPreferences: { sandbox: true }
  })
  shield.setBackgroundColor('#00000000') // fully transparent

  // Shield covers the entire split panes area: x=280, width=720, height=700
  win.contentView.addChildView(shield)
  shield.setBounds({ x: 280, y: 0, width: 720, height: 700 })

  // Load a lightweight transparent HTML page in the shield that records all pointer tracking
  await shield.webContents.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html><html><head><style>
      html, body { margin:0; padding:0; width:100%; height:100%; background:transparent; overflow:hidden; cursor:col-resize; }
    </style></head><body>
      <script>
        window.__shieldEvents = [];
        window.addEventListener('pointermove', (e) => {
          window.__shieldEvents.push({ type: 'move', x: Math.round(e.clientX), y: Math.round(e.clientY) });
        });
        window.addEventListener('pointerup', (e) => {
          window.__shieldEvents.push({ type: 'up', x: Math.round(e.clientX), y: Math.round(e.clientY) });
        });
        window.addEventListener('pointercancel', (e) => {
          window.__shieldEvents.push({ type: 'cancel' });
        });
      </script>
    </body></html>
  `))

  await new Promise((r) => setTimeout(r, 400))

  // Dispatch mouse move across Left Pane (x=350, y=300 in win coords, relative x=70 in shield)
  // and Right Pane (x=800, y=300 in win coords, relative x=520 in shield)
  // Note: sendInputEvent to the shield's webContents or to the window
  shield.webContents.sendInputEvent({
    type: 'mouseMove',
    x: 70,
    y: 300,
    button: 'left'
  })
  await new Promise((r) => setTimeout(r, 100))

  shield.webContents.sendInputEvent({
    type: 'mouseMove',
    x: 520,
    y: 300,
    button: 'left'
  })
  await new Promise((r) => setTimeout(r, 100))

  shield.webContents.sendInputEvent({
    type: 'mouseUp',
    x: 520,
    y: 300,
    button: 'left',
    clickCount: 1
  })
  await new Promise((r) => setTimeout(r, 200))

  // Verify events recorded by the shield
  const shieldEvents = await shield.webContents.executeJavaScript('window.__shieldEvents')
  const leftEvents = await viewLeft.webContents.executeJavaScript('window.__events')
  const rightEvents = await viewRight.webContents.executeJavaScript('window.__events')

  console.log('Shield Recorded Events:', JSON.stringify(shieldEvents, null, 2))
  console.log('Left Child Events during shield active:', JSON.stringify(leftEvents))
  console.log('Right Child Events during shield active:', JSON.stringify(rightEvents))

  const shieldSawMoveLeft = shieldEvents.some((e) => e.type === 'move' && e.x === 70)
  const shieldSawMoveRight = shieldEvents.some((e) => e.type === 'move' && e.x === 520)
  const shieldSawUp = shieldEvents.some((e) => e.type === 'up')

  console.log('\n--- Option B Shield Assessment ---')
  console.log('Shield tracked movement over left pane area:', shieldSawMoveLeft)
  console.log('Shield tracked movement over right pane area:', shieldSawMoveRight)
  console.log('Shield received mouseUp release event:', shieldSawUp)
  console.log('Child views received 0 stolen events during drag:', leftEvents.length === 0 && rightEvents.length === 0)

  // Test teardown: detach shield and verify child views receive events again
  win.contentView.removeChildView(shield)
  shield.webContents.close()
  console.log('Shield detached cleanly. Testing child interaction after drag...')

  viewLeft.webContents.sendInputEvent({
    type: 'mouseDown',
    x: 100,
    y: 100,
    button: 'left',
    clickCount: 1
  })
  await new Promise((r) => setTimeout(r, 100))

  const leftEventsAfter = await viewLeft.webContents.executeJavaScript('window.__events')
  console.log('Left pane interaction after shield removal:', JSON.stringify(leftEventsAfter))

  const cleanRecovery = leftEventsAfter.includes('left-down')
  console.log('Child view interactive responsiveness cleanly restored:', cleanRecovery)

  win.close()
  app.quit()

  if (shieldSawMoveLeft && shieldSawMoveRight && shieldSawUp && cleanRecovery) {
    process.exit(0)
  } else {
    process.exit(1)
  }
}

runSpike2().catch((err) => {
  console.error('Spike 2 error:', err)
  process.exit(2)
})
