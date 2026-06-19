import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { i18n, type MessageDescriptor } from '@lingui/core';

export const appMetaTags = (title?: MessageDescriptor) => {
  const description = 'Reeve.Sign — fast, secure document signing.';

  return [
    {
      title: title ? `${i18n._(title)} - Reeve.Sign` : 'Reeve.Sign',
    },
    {
      name: 'description',
      content: description,
    },
    {
      name: 'keywords',
      content: 'Reeve.Sign, document signing, e-signature, electronic signature, sign documents, secure signing',
    },
    {
      name: 'author',
      content: 'Reeve',
    },
    {
      name: 'robots',
      content: 'index, follow',
    },
    {
      property: 'og:title',
      content: 'Reeve.Sign',
    },
    {
      property: 'og:description',
      content: description,
    },
    {
      property: 'og:image',
      content: `${NEXT_PUBLIC_WEBAPP_URL()}/opengraph-image.jpg`,
    },
    {
      property: 'og:type',
      content: 'website',
    },
    {
      name: 'twitter:card',
      content: 'summary_large_image',
    },
    {
      name: 'twitter:site',
      content: '@meetreeve',
    },
    {
      name: 'twitter:description',
      content: description,
    },
    {
      name: 'twitter:image',
      content: `${NEXT_PUBLIC_WEBAPP_URL()}/opengraph-image.jpg`,
    },
  ];
};
