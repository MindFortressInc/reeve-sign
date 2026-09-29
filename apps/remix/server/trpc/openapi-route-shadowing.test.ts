import { appRouter } from '@documenso/trpc/server/router';
import { describe, expect, it } from 'vitest';

/**
 * DEV-12256: trpc-to-openapi (2.1.5) routes a public API v2 request to the
 * FIRST registered procedure whose path regex matches, and a `{param}` matches
 * any single segment. So a literal route like `GET /envelope/field/get-file-
 * download-url` registered after `GET /envelope/field/{fieldId}` is dead: it
 * lands on the param route with `fieldId: "get-file-download-url"`.
 *
 * This mirrors the library's matcher (`adapters/node-http/procedures.js` +
 * `utils/path.js`, not exported) and asserts every OpenAPI route resolves to
 * itself, so a new route registered in the wrong order fails here instead of
 * in a prod smoke.
 */

type OpenApiMeta = { method: string; path: string; enabled?: boolean };

type RouteEntry = { procedurePath: string; method: string; path: string; regExp: RegExp };

const normalizePath = (path: string) => `/${path.replace(/^\/|\/$/g, '')}`;

const getPathRegExp = (path: string) =>
  new RegExp(`^${path.replace(/\{(.+?)\}/g, (_, key: string) => `(?<${key}>[^/]+)`)}$`, 'i');

const getOpenApiRoutes = (): RouteEntry[] => {
  const routes: RouteEntry[] = [];

  // Same iteration the library uses: `Object.entries(router._def.procedures)`,
  // i.e. registration order.
  for (const [procedurePath, procedure] of Object.entries(appRouter._def.procedures)) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const openapi = (procedure as unknown as { _def: { meta?: { openapi?: OpenApiMeta } } })._def.meta?.openapi;

    if (!openapi || openapi.enabled === false) {
      continue;
    }

    const path = normalizePath(openapi.path);

    routes.push({ procedurePath, method: openapi.method, path, regExp: getPathRegExp(path) });
  }

  return routes;
};

const resolveFirstMatch = (routes: RouteEntry[], method: string, path: string) =>
  routes.find((route) => route.method === method && route.regExp.test(path));

describe('public API v2 route registration order', () => {
  const routes = getOpenApiRoutes();

  it('finds the OpenAPI routes', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('never shadows a route behind an earlier path-param route', () => {
    const shadowed = routes
      .map((route) => {
        const concretePath = route.path.replace(/\{(.+?)\}/g, '1');
        const winner = resolveFirstMatch(routes, route.method, concretePath);

        return winner && winner.procedurePath !== route.procedurePath
          ? `${route.method} ${route.path} (${route.procedurePath}) is caught by ${winner.path} (${winner.procedurePath})`
          : null;
      })
      .filter((entry): entry is string => entry !== null);

    expect(shadowed).toEqual([]);
  });

  it('routes the FILE_UPLOAD download URL to its own procedure', () => {
    expect(resolveFirstMatch(routes, 'GET', '/envelope/field/get-file-download-url')?.procedurePath).toBe(
      'envelope.field.getFileDownloadUrl',
    );
  });

  it('keeps the recipient-token download route off the public API', () => {
    expect(routes.map((route) => route.procedurePath)).not.toContain('envelope.field.getFileDownloadUrlByToken');
  });
});
