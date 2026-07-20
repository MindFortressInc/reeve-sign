/* eslint-disable turbo/no-undeclared-env-vars */
import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';

export const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    return '';
  }

  // Always a URL or a loud throw in production: the localhost default and the
  // production guard both live in `NEXT_PUBLIC_WEBAPP_URL`, so there is no
  // second silent fallback to apply here.
  return NEXT_PUBLIC_WEBAPP_URL();
};
