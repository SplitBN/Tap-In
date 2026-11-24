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

function keyboard() {
  const frameH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || window.innerHeight;
  const root = document.documentElement;
  let vv = vvNow();
  let kb = keyboardInset(vv, frameH, window.innerHeight);
  // Chat composer focused with the keyboard up: pin the document at 0,0 first, then measure. iOS pans the page to
  // reveal the input and again when a scroller overscrolls at its top (scroll chaining); reading offsetTop while that
  // pan comes and goes made the composer drop under the keyboard and "teleport" back. Pinned, offsetTop stays ~0 and
  // the chat is simply the top vv.height px of the screen.
  const pin = kb > 0 && inPinZone();
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
  root.classList.toggle('kb-pin', pin && kb > 0);
  debugReadout(kb, frameH);
}

/** localStorage 'tapin:vvdebug' = '1' shows the viewport numbers in a corner (for diagnosing iOS keyboard layout).
 *  gap = visible bottom − composer bottom: ≥ 0 means the composer is fully above the keyboard. */
function debugReadout(kb: number, frameH: number) {
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
  el.textContent = [
    `inner ${window.innerHeight} frame ${frameH} screen ${screen.height}`,
    `vv h ${Math.round(vv?.height ?? 0)} top ${Math.round(vv?.offsetTop ?? 0)} kb ${kb}${pin ? ' pin' : ''}`,
    `scrollY ${Math.round(window.scrollY)} doc ${document.documentElement.clientHeight}`,
    ...(comp ? [`composer ${Math.round(comp.bottom)} gap ${Math.round(visBottom - comp.bottom)}`] : []),
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
  // fire again until the user scrolls — the composer stayed half under the keyboard until then. So after any
  // viewport/focus change, keep re-measuring every frame for ~900 ms until the keyboard has settled.
  let until = 0, raf = 0;
  const settle = () => {
    until = performance.now() + 900;
    if (raf) return;
    const tick = () => { keyboard(); raf = performance.now() < until ? requestAnimationFrame(tick) : 0; };
    raf = requestAnimationFrame(tick);
  };
  window.visualViewport?.addEventListener('resize', () => { apply(); settle(); });
  window.visualViewport?.addEventListener('scroll', settle);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', () => {
    // leaving a pinned composer: iOS (26) can leave the page panned after the keyboard closes; put it back
    if (document.documentElement.classList.contains('kb-pin')) window.setTimeout(unpan, 60);
    settle();
  });
  // pinned chat keyboard: any document scroll is iOS panning it; undo at once (keyboard() re-measures in the settle loop)
  window.addEventListener('scroll', () => { if (document.documentElement.classList.contains('kb-pin')) { unpan(); settle(); } }, { passive: true });
  installTouchGuard();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply());
}
