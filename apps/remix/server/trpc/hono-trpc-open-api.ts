import { API_V2_BETA_URL, API_V2_URL } from '@documenso/lib/constants/app';
import { AppError, ZAppErrorJsonSchema } from '@documenso/lib/errors/app-error';
import { createTrpcContext } from '@documenso/trpc/server/context';
import { appRouter } from '@documenso/trpc/server/router';
import { createOpenApiFetchHandler } from '@documenso/trpc/utils/openapi-fetch-handler';
import { handleTrpcRouterError } from '@documenso/trpc/utils/trpc-error-handler';
import type { Context } from 'hono';
import { z } from 'zod';

type OpenApiTrpcServerHandlerOptions = {
  isBeta: boolean;
};

const ZAppErrorResponseBodySchema = z.object({ data: z.object({ appError: ZAppErrorJsonSchema }) });

/**
 * `trpc-to-openapi` sets the body's top-level `code` from the TRPCError wrapping
 * the thrown error, which is INTERNAL_SERVER_ERROR for every AppError. Report the
 * AppError's code instead so it agrees with `data.code` and the HTTP status.
 */
const withAppErrorCode = async (response: Response) => {
  if (response.ok) {
    return response;
  }

  const body = await response
    .clone()
    .json()
    .catch(() => null);

  const parsedBody = ZAppErrorResponseBodySchema.safeParse(body);

  if (!parsedBody.success) {
    return response;
  }

  return new Response(JSON.stringify({ ...body, code: parsedBody.data.data.appError.code }), {
    status: response.status,
    headers: response.headers,
  });
};

export const openApiTrpcServerHandler = async (c: Context, { isBeta }: OpenApiTrpcServerHandlerOptions) => {
  const response = await createOpenApiFetchHandler<typeof appRouter>({
    endpoint: isBeta ? API_V2_BETA_URL : API_V2_URL,
    router: appRouter,
    createContext: async () => createTrpcContext({ c, requestSource: 'apiV2' }),
    req: c.req.raw,
    onError: (opts) => handleTrpcRouterError(opts, 'apiV2'),
    // Not sure why we need to do this since we handle it in errorFormatter which runs after this.
    responseMeta: (opts) => {
      if (opts.errors[0]?.cause instanceof AppError) {
        const appError = AppError.parseError(opts.errors[0].cause);

        return {
          status: AppError.toHttpStatus(appError),
        };
      }

      return {};
    },
  });

  return await withAppErrorCode(response);
};
