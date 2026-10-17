import type { IncomingHttpHeaders } from 'node:http';

/**
 * Whether a request comes from this site's own page, or from the one other client origin the
 * server was configured for. Browsers send Origin with every WebSocket handshake and every
 * cross-site write, and a page cannot change it, so this stops other sites from using their
 * visitors' browsers against this server. A request with no Origin is not from a web page (a
 * test, a bot, a tool): it is let through, since it carries no browser's authority anyway.
 */
export function fromOwnPage(headers: IncomingHttpHeaders, allowedOrigin?: string): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  if (allowedOrigin && origin === allowedOrigin) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}
