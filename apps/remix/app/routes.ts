import { remixRoutesOptionAdapter } from '@react-router/remix-routes-option-adapter';
import { flatRoutes } from 'remix-flat-routes';

export default remixRoutesOptionAdapter((defineRoutes) => {
  return flatRoutes('routes', defineRoutes, {
    ignoredRouteFiles: [
      '**/.*', // Ignore dot files (like .DS_Store)
      '**/*.test.{ts,tsx}', // Ignore colocated unit tests (e.g. api+/health.test.ts) -- remix-flat-routes'
      // default routeRegex has no test-file exclusion, so a `<name>.test.ts` sibling inside a
      // `+`-nested route folder (`[\/\\]\+[\/\\][^\/\\:?*]+\.(ts|tsx|...)$`) matches as a route
      // module and gets bundled into the server build, where its top-level `vi.mock()` calls
      // throw "Vitest mocker was not initialized" at runtime (DEV-7600 PR #53 CI: E2E Tests).
    ],
    //appDir: 'app',
    //routeDir: 'routes',
    //basePath: '/',
    //paramPrefixChar: '$',
    //routeRegex: /(([+][\/\\][^\/\\:?*]+)|[\/\\]((index|route|layout|page)|(_[^\/\\:?*]+)|([^\/\\:?*]+\.route)))\.(ts|tsx|js|jsx|md|mdx)$$/,
  });
});
