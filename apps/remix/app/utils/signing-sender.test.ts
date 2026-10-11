import { OrganisationType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getSigningPageSender } from './signing-sender';

const user = { name: 'Matt Rhodes', email: 'matt@example.com' };
const organisationType = OrganisationType.ORGANISATION;

describe('getSigningPageSender (DEV-14926)', () => {
  it('names the owner, not the team, when sender details are included', () => {
    expect(
      getSigningPageSender({
        user,
        team: { name: 'MindFortress', teamEmail: null },
        organisationType,
        includeSenderDetails: true,
      }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '', onBehalfOf: true });
  });

  it('shows the team email beside the owner when the team has one', () => {
    expect(
      getSigningPageSender({
        user,
        team: { name: 'MindFortress', teamEmail: { email: 'team@example.com' } },
        organisationType,
        includeSenderDetails: true,
      }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '(team@example.com)', onBehalfOf: true });
  });

  it('shows the owner and their email when sender details are off', () => {
    expect(
      getSigningPageSender({
        user,
        team: { name: 'MindFortress', teamEmail: null },
        organisationType,
        includeSenderDetails: false,
      }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '(matt@example.com)', onBehalfOf: false });
  });

  it('renders an empty name for an owner without one', () => {
    expect(
      getSigningPageSender({
        user: { name: null, email: user.email },
        team: null,
        organisationType,
        includeSenderDetails: true,
      }),
    ).toEqual({ senderName: '', senderEmail: '', onBehalfOf: true });
  });
});

describe('getSigningPageSender in a personal org (DEV-15103)', () => {
  it('drops on-behalf-of and shows the owner email, as the invite email does', () => {
    expect(
      getSigningPageSender({
        user,
        team: { name: 'Personal Team', teamEmail: { email: 'team@example.com' } },
        organisationType: OrganisationType.PERSONAL,
        includeSenderDetails: true,
      }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '(matt@example.com)', onBehalfOf: false });
  });
});
