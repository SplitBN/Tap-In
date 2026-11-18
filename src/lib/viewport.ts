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
  const frameH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || window.innerHeight;
  const kb = keyboardInset(window.visualViewport, frameH, window.innerHeight);
  document.documentElement.style.setProperty('--kb', `${kb}px`);
  // when iOS pans the page up to reveal the input, the chat's header follows the visible top edge
  document.documentElement.style.setProperty('--kb-top', `${kb > 0 ? Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0)) : 0}px`);
  document.documentElement.classList.toggle('kb-open', kb > 0);
}

export function installViewportFix() {
  apply(); keyboard();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  window.visualViewport?.addEventListener('resize', () => { apply(); keyboard(); });
  window.visualViewport?.addEventListener('scroll', keyboard);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply());
}
