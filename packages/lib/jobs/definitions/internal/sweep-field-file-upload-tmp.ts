import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_ID = 'internal.sweep-field-file-upload-tmp';

const SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_SCHEMA = z.object({});

export type TSweepFieldFileUploadTmpJobDefinition = z.infer<typeof SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_SCHEMA>;

export const SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION = {
  id: SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_ID,
  name: 'Sweep Field File Upload Tmp Objects',
  version: '1.0.0',
  trigger: {
    name: SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_ID,
    schema: SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_SCHEMA,
    cron: '*/15 * * * *', // Every 15 minutes.
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./sweep-field-file-upload-tmp.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof SWEEP_FIELD_FILE_UPLOAD_TMP_JOB_DEFINITION_ID,
  TSweepFieldFileUploadTmpJobDefinition
>;
