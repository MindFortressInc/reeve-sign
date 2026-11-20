import type { TCachedLicense } from '@documenso/lib/types/license';
import { cn } from '@documenso/ui/lib/utils';
import { Trans } from '@lingui/react/macro';
import { AlertTriangleIcon } from 'lucide-react';
import { match } from 'ts-pattern';

export type AdminLicenseStatusBannerProps = {
  license: TCachedLicense | null;
};

export const AdminLicenseStatusBanner = ({ license }: AdminLicenseStatusBannerProps) => {
  const licenseStatus = license?.derivedStatus;

  if (!license || licenseStatus === 'ACTIVE' || licenseStatus === 'NOT_FOUND') {
    return null;
  }

  return (
    <div
      className={cn('mb-8 rounded-lg bg-yellow-200 text-yellow-900 dark:bg-yellow-400', {
        'bg-destructive text-destructive-foreground': licenseStatus === 'EXPIRED' || licenseStatus === 'UNAUTHORIZED',
      })}
    >
      <div className="flex items-center justify-between gap-x-4 px-4 py-3 font-medium text-sm">
        <div className="flex items-center">
          <AlertTriangleIcon className="mr-2.5 h-5 w-5" />

          {match(licenseStatus)
            .with('PAST_DUE', () => (
              <Trans>License Payment Overdue - Please update your payment to avoid service disruptions.</Trans>
            ))
            .with('EXPIRED', () => (
              <Trans>License Expired - Please renew your license to continue using enterprise features.</Trans>
            ))
            .with('UNAUTHORIZED', () =>
              license ? (
                <Trans>
                  Invalid License Type - Your Reeve.Sign instance is using features that are not part of your license.
                </Trans>
              ) : (
                <Trans>Missing License - Your Reeve.Sign instance is using features that require a license.</Trans>
              ),
            )
            .otherwise(() => null)}
        </div>
      </div>
    </div>
  );
};
