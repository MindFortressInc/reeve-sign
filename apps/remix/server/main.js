/**
 * This is the main entry point for the server which will launch the RR7 application
 * and spin up auth, api, etc.
 *
 * Note:
 *  This file will be copied to the build folder during build time.
 *  Running this file will not work without a build.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import handle from 'hono-react-router-adapter/node';
import { getLoadContext } from './hono/server/load-context.js';
import server from './hono/server/router.js';
import { initServerSentry } from './hono/server/sentry.js';
import * as build from './index.js';

// Sentry (DEV-2839): no-op when SENTRY_DSN is unset. Also called from
// `server/router.ts` (idempotent -- see `initServerSentry`'s double-init
// guard in `./hono/server/sentry.js`, compiled from
// `apps/remix/server/sentry.ts`, which has the SDK-choice rationale).
// Whichever of the two import chains resolves `./sentry.js` first actually
// runs the init; either way it completes before `serve()` below starts
// accepting connections, which is what request-time error capture needs.
initServerSentry();

server.use(
  serveStatic({
    root: 'build/client',
    onFound: (path, c) => {
      if (path.startsWith('build/client/assets')) {
        // Hard cache assets with hashed file names.
        c.header('Cache-Control', 'public, immutable, max-age=31536000');
      } else {
        // Cache with revalidation for rest of static files.
        c.header('Cache-Control', 'public, max-age=0, stale-while-revalidate=86400');
      }
    },
  }),
);

const handler = handle(build, server, { getLoadContext });

const port = parseInt(process.env.PORT || '3000', 10);

serve({ fetch: handler.fetch, port });
