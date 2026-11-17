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
function keyboard() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  const open = kb > 120;
  document.documentElement.style.setProperty('--kb', `${open ? kb : 0}px`);
  document.documentElement.classList.toggle('kb-open', open);
  // iOS scrolls the (non-scrolling) document to reveal the input; the chat screen lifts itself instead. Elsewhere (sheets)
  // leave iOS's own scroll-into-view alone.
  if (open && document.querySelector('.chat-screen')) window.scrollTo(0, 0);
}

export function installViewportFix() {
  apply(); keyboard();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  window.visualViewport?.addEventListener('resize', () => { apply(); keyboard(); });
  window.visualViewport?.addEventListener('scroll', keyboard);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply());
}
