import { APP_DISPLAY_NAME, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { generateOpenApi } from '@ts-rest/open-api';

import { ApiContractV1 } from './contract';

export const OpenAPIV1 = Object.assign(
  generateOpenApi(
    ApiContractV1,
    {
      info: {
        title: `${APP_DISPLAY_NAME} API`,
        version: '1.0.0',
        description: `API V1 is deprecated, but will continue to be supported. New integrations should use the v2 API (/api/v2/openapi.json).\n\nThe ${APP_DISPLAY_NAME} API for retrieving, creating, updating and deleting documents.`,
      },
      servers: [
        {
          url: NEXT_PUBLIC_WEBAPP_URL(),
        },
      ],
    },
    {
      setOperationId: true,
    },
  ),
  {
    components: {
      securitySchemes: {
        authorization: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
        },
      },
    },
    security: [
      {
        authorization: [],
      },
    ],
  },
);
