import { sweepFieldFileUploadTmp } from '../../../server-only/field/sweep-field-file-upload-tmp';
import { env } from '../../../utils/env';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSweepFieldFileUploadTmpJobDefinition } from './sweep-field-file-upload-tmp';

export const run = async ({ io }: { payload: TSweepFieldFileUploadTmpJobDefinition; io: JobRunIO }) => {
  // FILE_UPLOAD fields only exist on the S3 transport (the presign routes
  // need a bucket), so there is nothing to sweep anywhere else.
  if (env('NEXT_PUBLIC_UPLOAD_TRANSPORT') !== 's3') {
    io.logger.info('Upload transport is not s3, skipping field file upload tmp sweep');
    return;
  }

  const { deleted, kept, refused, failed } = await sweepFieldFileUploadTmp();

  io.logger.info(
    `Field file upload tmp sweep: deleted ${deleted}, kept ${kept} (too recent), refused ${refused} (outside prefix), failed ${failed}`,
  );
};
