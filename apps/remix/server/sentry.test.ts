import * as Sentry from '@sentry/node';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HonoEnv } from './router';
import {
  initServerSentry,
  SENTRY_HOST_APP,
  SENTRY_SERVICE_NAME,
  sentryErrorHandler,
  sentryTaggingMiddleware,
} from './sentry';

// These tests are order-dependent within this file: the "unset DSN" case
// must run before any successful `initServerSentry` call, since Sentry's
// Node client is a process-wide singleton (`Sentry.getClient()`) that this
// module's double-init guard checks against. Vitest runs `it` blocks within
// a single file sequentially by default, so this is safe.
//
// Assertions below use `@sentry/node`'s real client/scope APIs rather than
// `vi.spyOn` on the SDK's named exports -- Sentry's ESM build exposes a
// non-configurable module namespace (Node's ESM spec), so `vi.spyOn(Sentry,
// 'setTag')` etc. throw "Cannot redefine property" under vitest. Reading
// real scope state via the public `getScopeData()` API exercises actual SDK
// behavior instead of mocking around it.
//
// Note: `Sentry.setTag()` writes to the *isolation* scope
// (`Sentry.getIsolationScope()`), not `Sentry.getCurrentScope()` -- those
// are distinct scope objects in the SDK's scope model (verified against the
// real SDK via a throwaway repro during development, not assumed from
// memory). They get merged when an event is actually captured, which the
// end-to-end test below verifies directly via `beforeSend`.

describe('initServerSentry', () => {
  it('no-ops and returns false when SENTRY_DSN is unset', () => {
    expect(Sentry.getClient()).toBeUndefined();

    const result = initServerSentry(undefined);

    expect(result).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
  });

  it('initializes the Sentry client and returns true when a DSN is provided', () => {
    const result = initServerSentry('https://examplePublicKey@o0.ingest.sentry.io/0');

    expect(result).toBe(true);
    expect(Sentry.getClient()).toBeDefined();
  });

  it('does not re-initialize the client on a second call (double-init guard)', () => {
    const clientBefore = Sentry.getClient();

    const result = initServerSentry('https://anotherKey@o0.ingest.sentry.io/0');

    expect(result).toBe(true);
    // Same client instance -> Sentry.init was not called again (a second
    // init() call would produce a new client object).
    expect(Sentry.getClient()).toBe(clientBefore);
  });
});

describe('sentryTaggingMiddleware', () => {
  // By this point in the file, initServerSentry has already run (previous
  // describe block), so Sentry.getClient() is defined and the middleware's
  // tagging branch is exercised.

  const buildApp = () => {
    const app = new Hono<HonoEnv>();

    app.use('*', sentryTaggingMiddleware);
    app.get('/ok', (c) => c.text('ok'));
    app.get('/scope-tags', (c) => c.json(Sentry.getIsolationScope().getScopeData().tags));
    app.get('/boom', () => {
      throw new Error('boom');
    });

    return app;
  };

  it('passes the request through and preserves the response', async () => {
    const app = buildApp();

    const res = await app.request('/ok');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('sets service_name and host_app tags on the isolation scope visible to the route handler', async () => {
    const app = buildApp();

    const res = await app.request('/scope-tags');
    const tags = await res.json();

    expect(tags).toMatchObject({
      service_name: SENTRY_SERVICE_NAME,
      host_app: SENTRY_HOST_APP,
    });
  });

  it('gives each request its own isolation scope (tags do not leak across requests)', async () => {
    const app = buildApp();

    app.get('/tag-then-check', async (c, next) => {
      Sentry.setTag('per_request_marker', c.req.query('marker'));
      await next();
    });

    const runTagThenCheck = async (marker: string) => {
      // `app.request()` returns `Response | Promise<Response>` (Hono has a
      // synchronous fast path), so `await` it directly rather than chaining
      // `.then()`.
      await app.request(`/tag-then-check?marker=${marker}`);
      return app.request('/scope-tags');
    };

    const [resA, resB] = await Promise.all([runTagThenCheck('A'), runTagThenCheck('B')]);

    const tagsA = await resA.json();
    const tagsB = await resB.json();

    // Neither request's `/scope-tags` call should see the other's
    // `per_request_marker` (each `app.request()` call here is a fresh
    // request, so the isolation scope from the tagging middleware should
    // not have leaked the marker forward at all).
    expect(tagsA.per_request_marker).toBeUndefined();
    expect(tagsB.per_request_marker).toBeUndefined();
  });

  it('still propagates a thrown error through the isolation scope', async () => {
    const app = buildApp();

    const res = await app.request('/boom');

    // Hono's default error handler turns an uncaught throw into a 500;
    // the point of this test is that the isolation-scope wrapper doesn't
    // swallow it or break Hono's own error handling.
    expect(res.status).toBe(500);
  });

  it('end-to-end: a route error is captured to Sentry, tagged with service_name/host_app', async () => {
    // This is the actual acceptance criterion (DEV-2839): "a thrown error
    // appears in the reeve-sign Sentry project, tagged with...". Wires the
    // tagging middleware AND the error handler together (as `router.ts`
    // does) and inspects the real event Sentry would have sent, via a
    // temporary `addEventProcessor` (a supported public API, not a mock).
    let captured: Sentry.Event | undefined;

    const client = Sentry.getClient();
    client?.addEventProcessor((event) => {
      captured = event;
      // Drop the event here so this test never attempts a real network
      // send to the fake DSN's host.
      return null;
    });

    const app = new Hono<HonoEnv>();
    app.use('*', sentryTaggingMiddleware);
    app.onError(sentryErrorHandler);
    app.get('/boom', () => {
      throw new Error('boom for real');
    });

    const res = await app.request('/boom');

    expect(res.status).toBe(500);

    // captureException's event-processor pipeline runs asynchronously;
    // give it a tick before asserting (verified empirically -- reading
    // `captured` immediately after `app.request()` resolves is undefined).
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(captured?.exception?.values?.[0]?.value).toBe('boom for real');
    expect(captured?.tags).toMatchObject({
      service_name: SENTRY_SERVICE_NAME,
      host_app: SENTRY_HOST_APP,
    });
  });
});

describe('sentryTaggingMiddleware without an initialized client', () => {
  let originalClient: ReturnType<typeof Sentry.getClient>;

  beforeAll(() => {
    // Simulate the SENTRY_DSN-unset deployment shape by tearing down the
    // client the earlier describe block created.
    originalClient = Sentry.getClient();
    Sentry.getCurrentScope().setClient(undefined);
  });

  afterAll(() => {
    Sentry.getCurrentScope().setClient(originalClient);
  });

  it('skips tagging entirely and calls next() directly', async () => {
    const app = new Hono<HonoEnv>();
    app.use('*', sentryTaggingMiddleware);
    app.get('/ok', (c) => c.text('ok'));
    app.get('/scope-tags', (c) => c.json(Sentry.getIsolationScope().getScopeData().tags));

    const okRes = await app.request('/ok');
    expect(okRes.status).toBe(200);

    const tagsRes = await app.request('/scope-tags');
    const tags = await tagsRes.json();

    expect(tags.service_name).toBeUndefined();
    expect(tags.host_app).toBeUndefined();
  });
});
