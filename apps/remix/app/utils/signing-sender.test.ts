import { describe, expect, it } from 'vitest';

import { getSigningPageSender } from './signing-sender';

const user = { name: 'Matt Rhodes', email: 'matt@example.com' };

describe('getSigningPageSender (DEV-14926)', () => {
  it('names the owner, not the team, when sender details are included', () => {
    expect(
      getSigningPageSender({ user, team: { name: 'MindFortress', teamEmail: null }, includeSenderDetails: true }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '' });
  });

  it('shows the team email beside the owner when the team has one', () => {
    expect(
      getSigningPageSender({
        user,
        team: { name: 'MindFortress', teamEmail: { email: 'team@example.com' } },
        includeSenderDetails: true,
      }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '(team@example.com)' });
  });

  it('shows the owner and their email when sender details are off', () => {
    expect(
      getSigningPageSender({ user, team: { name: 'MindFortress', teamEmail: null }, includeSenderDetails: false }),
    ).toEqual({ senderName: 'Matt Rhodes', senderEmail: '(matt@example.com)' });
  });

  it('renders an empty name for an owner without one', () => {
    expect(
      getSigningPageSender({ user: { name: null, email: user.email }, team: null, includeSenderDetails: true }),
    ).toEqual({ senderName: '', senderEmail: '' });
  });
});
