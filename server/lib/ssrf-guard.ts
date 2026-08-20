import { lookup } from 'dns/promises';
import net from 'net';
import { z } from 'zod';

const FIVE_SECONDS_MS = 5_000;
const DEFAULT_ALLOWED_DOMAINS = (process.env.SSRF_ALLOWED_DOMAINS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const externalUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === 'https:', 'Only HTTPS URLs are allowed.');

function normalizeIpv6(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    normalized.startsWith('fe80:')
  );
}

export function isPrivateAddress(address: string): boolean {
  const normalized = normalizeIpv6(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return true;
}

function isAllowedHostname(hostname: string, allowedDomains = DEFAULT_ALLOWED_DOMAINS): boolean {
  if (allowedDomains.length === 0) return false;
  const normalized = hostname.toLowerCase();
  return allowedDomains.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

export async function assertSafeExternalUrl(
  input: string,
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
): Promise<URL> {
  const parsed = externalUrlSchema.parse(input);
  if (!isAllowedHostname(parsed.hostname, allowedDomains)) {
    throw new Error('Hostname is not in the outbound allowlist.');
  }

  const records = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error('Hostname did not resolve.');
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error('Hostname resolves to a private or loopback address.');
    }
  }

  return parsed;
}

export async function fetchAllowedExternalUrl(
  input: string,
  init: RequestInit = {},
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
): Promise<Response> {
  const parsed = await assertSafeExternalUrl(input, allowedDomains);
  return fetch(parsed, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(FIVE_SECONDS_MS),
  });
}
