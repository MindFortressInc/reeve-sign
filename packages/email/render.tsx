import config from '@documenso/tailwind-config';
import type { I18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import * as ReactEmail from '@react-email/render';

import { emailBrandColors } from './brand-colors';
import { Tailwind } from './components';
import { BrandingProvider, type BrandingSettings } from './providers/branding';

export type RenderOptions = ReactEmail.Options & {
  branding?: BrandingSettings;
  i18n?: I18n;
};

// The shared config's `brand` token resolves through CSS variables (which
// email clients cannot evaluate), so it is replaced with the concrete
// email-safe hex ramp — see brand-colors.ts (DEV-5616).
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const colors = {
  ...(config.theme?.extend?.colors || {}),
  brand: emailBrandColors,
} as Record<string, string | Record<string, string>>;

export const render = async (element: React.ReactNode, options?: RenderOptions) => {
  const { branding, ...otherOptions } = options ?? {};

  return ReactEmail.render(
    <BrandingProvider branding={branding}>
      <Tailwind
        config={{
          theme: {
            extend: {
              colors,
            },
          },
        }}
      >
        {element}
      </Tailwind>
    </BrandingProvider>,
    otherOptions,
  );
};

export const renderWithI18N = async (element: React.ReactNode, options?: RenderOptions) => {
  const { branding, i18n, ...otherOptions } = options ?? {};

  if (!i18n) {
    throw new Error('i18n is required');
  }

  return ReactEmail.render(
    <I18nProvider i18n={i18n}>
      <BrandingProvider branding={branding}>
        <Tailwind
          config={{
            theme: {
              extend: {
                colors,
              },
            },
          }}
        >
          {element}
        </Tailwind>
      </BrandingProvider>
    </I18nProvider>,
    otherOptions,
  );
};
