import { z } from 'zod';

export const getIpAddress = (req: Request) => {
  // Check for forwarded headers first (common in proxy setups)
  const forwarded = req.headers.get('x-forwarded-for');

  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, take the first one
    return forwarded.split(',')[0].trim();
  }

  // Check for real IP header (used by some proxies)
  const realIp = req.headers.get('x-real-ip');

  if (realIp) {
    return realIp;
  }

  // Check for client IP header
  const clientIp = req.headers.get('x-client-ip');

  if (clientIp) {
    return clientIp;
  }

  // Check for CF-Connecting-IP (Cloudflare)
  const cfConnectingIp = req.headers.get('cf-connecting-ip');

  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Check for True-Client-IP (Akamai and Cloudflare)
  const trueClientIp = req.headers.get('true-client-ip');

  if (trueClientIp) {
    return trueClientIp;
  }

  throw new Error('No IP address found');
};

const ZTrustedIpSchema = z.string().ip();

/**
 * Client IP for abuse controls (rate limits), where a spoofable key is a
 * bypass. Unlike `getIpAddress`, it never reads the FIRST X-Forwarded-For
 * entry: proxies append to a client-supplied header, so that entry is
 * whatever the client sent.
 *
 * - X-Real-IP first: the production nginx sets it to `$remote_addr`,
 *   overwriting any client value (deploy/nginx/sign.meetreeve.com.conf), and
 *   the app port is bound to 127.0.0.1, so nothing reaches it unproxied.
 * - Else the LAST X-Forwarded-For entry, the one the nearest proxy appended.
 *
 * Returns undefined when neither is a valid IP.
 */
export const getTrustedIpAddress = (req: Request): string | undefined => {
  const realIp = ZTrustedIpSchema.safeParse(req.headers.get('x-real-ip')?.trim());

  if (realIp.success) {
    return realIp.data;
  }

  const lastForwarded = req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  const forwarded = ZTrustedIpSchema.safeParse(lastForwarded);

  return forwarded.success ? forwarded.data : undefined;
};
