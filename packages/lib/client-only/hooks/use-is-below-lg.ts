import { useCallback, useSyncExternalStore } from 'react';

/**
 * Tailwind's `lg` breakpoint is 1024px (the shared tailwind config only *extends*
 * screens with 3xl/4xl/5xl, so `lg` keeps its default). `lg:` styles apply from
 * 1024px up, so "below lg" is everything under that.
 */
const BELOW_LG_QUERY = '(max-width: 1023.98px)';

/**
 * Whether the viewport is narrower than Tailwind's `lg` breakpoint.
 *
 * This exists so a component can keep a mobile-only Radix overlay (Sheet/Dialog)
 * out of the DOM on desktop. A `lg:hidden` class is NOT enough for those: Radix
 * renders them in a portal and locks body scroll while open, so an overlay left
 * open across a resize would silently freeze scrolling on a viewport where it is
 * visually hidden. Callers gate on this value instead.
 *
 * SSR-safe: `getServerSnapshot` returns false, so the server renders the desktop
 * layout and the client corrects on hydration.
 */
export const useIsBelowLg = () => {
  const subscribe = useCallback((onChange: () => void) => {
    const mediaQuery = window.matchMedia(BELOW_LG_QUERY);

    mediaQuery.addEventListener('change', onChange);

    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(BELOW_LG_QUERY).matches,
    () => false,
  );
};
