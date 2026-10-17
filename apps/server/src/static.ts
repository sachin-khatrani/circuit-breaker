import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built client (apps/client/dist) so production is one process and one origin.
 * Hashed assets are cached for a year; the page itself never is. Unknown paths without an
 * extension get the page (the game handles its own `?room=` invite links).
 */
export function createStaticHandler(root: string) {
  const base = resolve(root);
  const exists = existsSync(join(base, 'index.html'));

  return function serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (!exists || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      return false;
    }
    const target = normalize(join(base, path));
    if (target !== base && !target.startsWith(base + sep)) return false;
    let file = target;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path) !== '') return false;
      file = join(base, 'index.html');
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const hashed = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}
