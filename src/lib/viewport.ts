// iOS standalone (Home Screen) web apps can report a layout viewport shorter than the screen
// (WebKit bugs 237961 / 254868, still seen on iOS 26): anything anchored to "bottom" then floats
// above the real bottom edge. In standalone mode the app always fills the whole screen, so we size
// the app frame from the screen itself and expose it as --app-h.

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function viewportInfo() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  return {
    standalone: isStandalone(),
    innerHeight: window.innerHeight,
    visualHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
    screenHeight: screenH,
    docHeight: document.documentElement.clientHeight,
    appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
  };
}

function apply() {
  const v = viewportInfo();
  // In standalone mode the visible area is the full screen; trust the screen, never a shorter viewport.
  const h = v.standalone ? Math.max(v.innerHeight, v.screenHeight) : v.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}

/** On-screen keyboard: how much of the layout it covers, as --kb (0 when closed), plus html.kb-open.
 *  --app-h is left alone (it is the screen frame); screens that have an input at the bottom (the agent chat) lift
 *  themselves by --kb. Below 120 px is noise (toolbar/status bar differences), not a keyboard. */
export function keyboardInset(vv: { height: number; offsetTop: number } | null | undefined, frameH: number, innerH: number) {
  if (!vv) return 0;
  // The chat screen hangs off the bottom of #root, which is `frameH` (--app-h) tall from the top of the layout
  // viewport. In iOS standalone that frame is the full screen (e.g. 844) while innerHeight can report less (797), so
  // measuring against innerHeight left the composer ~47 px too low: under the keyboard. The visible area ends at
  // offsetTop + height (offsetTop = how far iOS panned the visual viewport to reveal the input), so the keyboard
  // covers everything of the frame below that line.
  const kb = Math.round(frameH - (vv.offsetTop + vv.height));
  // closed: the only difference is the frame-vs-innerHeight gap (status bar), never a keyboard
  const closedGap = Math.max(0, frameH - innerH);
  return kb > closedGap + 80 ? kb : 0;
}
/** The visual viewport, or a fake one in dev (window.__tapinVV = { height, offsetTop }) to simulate the iOS keyboard. */
function vvNow(): { height: number; offsetTop: number } | null {
  const fake = import.meta.env.DEV ? (window as unknown as { __tapinVV?: { height: number; offsetTop: number } }).__tapinVV : undefined;
  return fake ?? window.visualViewport ?? null;
}
/** Screens whose bottom input owns the keyboard: while it is open the document is pinned (never panned by iOS). */
const PIN_ZONE = '.chat-screen, .quick-chat';
const inPinZone = () => !!(document.activeElement as HTMLElement | null)?.closest?.(PIN_ZONE);
/** Undo any pan/scroll iOS applied to the document (focus reveal, scroll chaining from an inner scroller). */
function unpan() {
  // iOS may report the focus pan only as visualViewport.offsetTop (scrollY stays 0: html/body are overflow hidden)
  if (window.scrollY || window.scrollX || (window.visualViewport?.offsetTop ?? 0) > 0) window.scrollTo(0, 0);
  if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
  if (document.body.scrollTop) document.body.scrollTop = 0;
}

/** Pin-zone focus seen, keyboard not measured yet: hold the document pinned meanwhile, so the first keyboard show is
 *  measured (and panned by iOS) against the same pinned layout as every later one. */
let prePinUntil = 0;

function keyboard(reason = '') {
  const frameH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || window.innerHeight;
  const root = document.documentElement;
  let vv = vvNow();
  let kb = keyboardInset(vv, frameH, window.innerHeight);
  // Chat composer focused with the keyboard up: pin the document at 0,0 first, then measure. iOS pans the page to
  // reveal the input and again when a scroller overscrolls at its top (scroll chaining); reading offsetTop while that
  // pan comes and goes made the composer drop under the keyboard and "teleport" back. Pinned, offsetTop stays ~0 and
  // the chat is simply the top vv.height px of the screen.
  const zone = inPinZone();
  const pin = zone && (kb > 0 || performance.now() < prePinUntil);
  if (pin) { unpan(); vv = vvNow(); kb = keyboardInset(vv, frameH, window.innerHeight); }
  root.style.setProperty('--kb', `${kb}px`);
  // While the keyboard is open, screens with a bottom input pin themselves to the visible rectangle iOS reports
  // (offsetTop / height of the visual viewport, in layout-viewport coordinates = the fixed #root's coordinates).
  // This doesn't depend on --app-h, which iOS standalone reports inconsistently once the keyboard is up.
  const top = kb > 0 ? Math.max(0, Math.round(vv?.offsetTop ?? 0)) : 0;
  root.style.setProperty('--vv-top', `${top}px`);
  root.style.setProperty('--vv-h', `${Math.round(vv?.height ?? window.innerHeight)}px`);
  root.style.setProperty('--kb-top', `${top}px`);
  root.classList.toggle('kb-open', kb > 0);
  root.classList.toggle('kb-pin', pin);
  debugReadout(kb, frameH, reason);
}

/** localStorage 'tapin:vvdebug' = '1' shows the viewport numbers in a corner (for diagnosing iOS keyboard layout).
 *  gap = visible bottom − composer bottom: ≥ 0 means the composer is fully above the keyboard. */
const trace: string[] = [];
let traceT0 = 0;
function debugReadout(kb: number, frameH: number, reason: string) {
  let on = false;
  try { on = localStorage.getItem('tapin:vvdebug') === '1'; } catch { /* ignore */ }
  let el = document.getElementById('vv-debug');
  if (!on) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'vv-debug';
    el.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top) + 4px);left:4px;z-index:99999;padding:4px 6px;border-radius:6px;background:rgba(255,0,80,.85);color:#fff;font:11px/1.3 ui-monospace,monospace;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
  }
  const vv = vvNow();
  const comp = document.querySelector('.chat-screen .composer-wrap, .quick-chat .composer-wrap')?.getBoundingClientRect();
  const visBottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
  const pin = document.documentElement.classList.contains('kb-pin');
  // timestamped trace of what changed (first vs later keyboard opens differ on iOS: compare the two on the device)
  const gap = comp ? Math.round(visBottom - comp.bottom) : NaN;
  const line = `${reason || '·'} h${Math.round(vv?.height ?? 0)} t${Math.round(vv?.offsetTop ?? 0)} kb${kb}${pin ? 'P' : ''} g${gap}`;
  if (reason === 'focusin' || !traceT0) traceT0 = performance.now();
  const stamped = `${Math.round(performance.now() - traceT0)}ms ${line}`;
  if (trace[trace.length - 1]?.replace(/^\d+ms /, '') !== line) { trace.push(stamped); if (trace.length > 8) trace.shift(); }
  el.textContent = [
    `inner ${window.innerHeight} frame ${frameH} screen ${screen.height}`,
    `vv h ${Math.round(vv?.height ?? 0)} top ${Math.round(vv?.offsetTop ?? 0)} kb ${kb}${pin ? ' pin' : ''}`,
    `scrollY ${Math.round(window.scrollY)} doc ${document.documentElement.clientHeight}`,
    ...(comp ? [`composer ${Math.round(comp.bottom)} gap ${gap}`] : []),
    ...trace,
  ].join('\n');
}

/** While the chat keyboard is pinned, a touch drag may only scroll an inner scroller that can still move that way;
 *  anything else (a drag on the composer, or past a scroller's end) would pan/scroll the document on iOS. */
function installTouchGuard() {
  let lastY = 0;
  document.addEventListener('touchstart', (e) => { lastY = e.touches[0]?.clientY ?? 0; }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const y = e.touches[0]?.clientY ?? lastY;
    const dy = y - lastY; lastY = y; // > 0: finger moves down = content toward its top
    if (!document.documentElement.classList.contains('kb-pin') || e.touches.length > 1) return;
    for (let el = e.target as Element | null; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        const atTop = el.scrollTop <= 0, atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if ((dy > 0 && atTop) || (dy < 0 && atBottom)) break; // would chain to the document: block
        return; // this scroller takes it
      }
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
}

export function installViewportFix() {
  apply(); keyboard();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  // iOS fires the first visualViewport resize while the keyboard is still sliding in (height not final) and may not
  // fire again. The FIRST show of the keyboard in a session is the slow one: the keyboard process loads, the
  // QuickType/predictive bar arrives late and shrinks the viewport again (often with no event), and the main thread
  // can stall long enough that a fixed "measure for 900 ms" window ran out before the final height existed — so the
  // composer sat under the keyboard only the first time. Now: after any viewport/focus change, re-measure every frame
  // until the visual viewport has been unchanged for STABLE_MS (at least MIN_MS, at most MAX_MS), then one more pass
  // (after the pin has re-laid-out the page); and while the keyboard is open a slow poll catches late changes that
  // fire no event at all.
  const STABLE_MS = 300, MIN_MS = 450, MAX_MS = 2500;
  // next frame, or 50 ms when frames are paused (hidden/background page: rAF never fires, the loop must still end)
  const nextFrame = (f: () => void) => { let done = false; const go = () => { if (!done) { done = true; f(); } }; requestAnimationFrame(go); window.setTimeout(go, 50); return 1; };
  let raf = 0, started = 0, stableSince = 0, lastSig = '', why = '';
  const sig = () => { const v = vvNow(); return `${Math.round(v?.height ?? 0)}:${Math.round(v?.offsetTop ?? 0)}:${window.innerHeight}`; };
  const settle = (reason: string) => {
    why = reason;
    started = performance.now(); stableSince = started; lastSig = sig();
    keyboard(reason);
    if (raf) return;
    const tick = () => {
      const now = performance.now(), s = sig();
      if (s !== lastSig) { lastSig = s; stableSince = now; }
      keyboard(why); why = '';
      const done = now - started >= MAX_MS || (now - started >= MIN_MS && now - stableSince >= STABLE_MS);
      if (done) { raf = 0; nextFrame(() => keyboard('final')); return; }
      raf = nextFrame(tick);
    };
    raf = nextFrame(tick);
  };
  // slow poll while the keyboard is open (or a pin-zone focus is pending): cheap, and catches silent viewport changes
  window.setInterval(() => {
    const root = document.documentElement;
    if (raf || !(root.classList.contains('kb-open') || root.classList.contains('kb-pin') || inPinZone())) return;
    if (sig() !== lastSig) settle('poll');
    // pre-pin ran out and no keyboard came (hardware keyboard, focus without keyboard): unpin
    else if (root.classList.contains('kb-pin') && !root.classList.contains('kb-open') && performance.now() > prePinUntil) keyboard('expire');
  }, 250);
  window.visualViewport?.addEventListener('resize', () => { apply(); settle('vv-resize'); });
  window.visualViewport?.addEventListener('scroll', () => settle('vv-scroll'));
  // Chromium's VirtualKeyboard API (not in iOS Safari as of iOS 26; harmless where missing)
  (navigator as unknown as { virtualKeyboard?: EventTarget }).virtualKeyboard?.addEventListener?.('geometrychange', () => settle('vk-geometry'));
  document.addEventListener('focusin', () => {
    // pin before the keyboard arrives, so its first appearance is measured against the pinned layout
    if (inPinZone()) prePinUntil = performance.now() + MAX_MS;
    settle('focusin');
  });
  document.addEventListener('focusout', () => {
    prePinUntil = 0;
    // leaving a pinned composer: iOS (26) can leave the page panned after the keyboard closes; put it back
    if (document.documentElement.classList.contains('kb-pin')) window.setTimeout(unpan, 60);
    settle('focusout');
  });
  // pinned chat keyboard: any document scroll is iOS panning it; undo at once (keyboard() re-measures in the settle loop)
  window.addEventListener('scroll', () => { if (document.documentElement.classList.contains('kb-pin')) { unpan(); settle('scroll'); } }, { passive: true });
  installTouchGuard();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply());
}
