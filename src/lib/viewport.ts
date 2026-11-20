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
function keyboard() {
  const vv = window.visualViewport;
  const frameH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || window.innerHeight;
  const kb = keyboardInset(vv, frameH, window.innerHeight);
  const root = document.documentElement;
  root.style.setProperty('--kb', `${kb}px`);
  // While the keyboard is open, screens with a bottom input pin themselves to the visible rectangle iOS reports
  // (offsetTop / height of the visual viewport, in layout-viewport coordinates = the fixed #root's coordinates).
  // This doesn't depend on --app-h, which iOS standalone reports inconsistently once the keyboard is up.
  root.style.setProperty('--vv-top', `${kb > 0 ? Math.max(0, Math.round(vv?.offsetTop ?? 0)) : 0}px`);
  root.style.setProperty('--vv-h', `${Math.round(vv?.height ?? window.innerHeight)}px`);
  root.style.setProperty('--kb-top', `${kb > 0 ? Math.max(0, Math.round(vv?.offsetTop ?? 0)) : 0}px`);
  root.classList.toggle('kb-open', kb > 0);
  debugReadout(kb, frameH);
}

/** localStorage 'tapin:vvdebug' = '1' shows the viewport numbers in a corner (for diagnosing iOS keyboard layout). */
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
  const vv = window.visualViewport;
  el.textContent = `inner ${window.innerHeight} frame ${frameH} screen ${screen.height}\nvv h ${Math.round(vv?.height ?? 0)} top ${Math.round(vv?.offsetTop ?? 0)} kb ${kb}\nscrollY ${Math.round(window.scrollY)} doc ${document.documentElement.clientHeight}`;
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
  document.addEventListener('focusout', settle);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply());
}
