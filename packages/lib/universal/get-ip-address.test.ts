import { describe, expect, it } from 'vitest';

import { getTrustedIpAddress } from './get-ip-address';

const req = (headers: Record<string, string>) => new Request('https://sign.example/', { headers });

describe('getTrustedIpAddress', () => {
  it('prefers X-Real-IP over a client-supplied X-Forwarded-For', () => {
    expect(getTrustedIpAddress(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('uses the proxy-appended LAST X-Forwarded-For entry, never the spoofable first', () => {
    expect(getTrustedIpAddress(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores headers that are not valid IPs', () => {
    expect(getTrustedIpAddress(req({ 'x-real-ip': 'garbage', 'x-forwarded-for': 'also-garbage' }))).toBeUndefined();
    expect(getTrustedIpAddress(req({}))).toBeUndefined();
  });
});
