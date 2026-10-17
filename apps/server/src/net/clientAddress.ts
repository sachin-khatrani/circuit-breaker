import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/**
 * The address a request came from, for rate limits. Behind `trustedHops` proxies (Render,
 * Railway: 1) it is the entry those proxies appended to X-Forwarded-For, counted from the
 * right: entries further left were written by the client and could be anything.
 */
export function clientAddress(
  headers: IncomingHttpHeaders,
  remote: string | undefined,
  trustedHops: number,
): string {
  if (trustedHops > 0) {
    const header = headers['x-forwarded-for'];
    const list = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const hop = list[list.length - trustedHops];
    if (hop) return hop;
  }
  return remote ?? 'unknown';
}

export function requestAddress(req: IncomingMessage, trustedHops: number): string {
  return clientAddress(req.headers, req.socket.remoteAddress, trustedHops);
}

/** Whether the browser reached us over HTTPS (directly, or through a trusted proxy). */
export function isHttps(req: IncomingMessage, trustedHops: number): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  if (trustedHops === 0) return false;
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : (proto ?? '')).split(',')[0].trim() === 'https';
}
