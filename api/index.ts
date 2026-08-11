/**
 * Vercel serverless adapter.
 * Imports the pre-built CommonJS server bundle produced by `npm run build`.
 * This avoids ERR_MODULE_NOT_FOUND for the large server.ts source tree.
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function handler(req: any, res: any) {
  // Prefer the esbuild CJS bundle (created by npm run build)
  let appPromise: any;
  try {
    // When packaged, dist/server.cjs is next to the function or at project root relative
    const candidates = [
      path.join(__dirname, '..', 'dist', 'server.cjs'),
      path.join(process.cwd(), 'dist', 'server.cjs'),
      path.join('/var/task', 'dist', 'server.cjs'),
      path.join('/var/task', 'server.cjs'),
    ];
    let loaded = false;
    for (const p of candidates) {
      try {
        appPromise = require(p);
        if (appPromise) { loaded = true; break; }
      } catch (_) {}
    }
    if (!loaded) {
      // Fallback: dynamic import of source (requires includeFiles)
      const mod = await import('../server.ts');
      appPromise = mod.default;
    }
  } catch (e: any) {
    console.error('[Vercel API] Failed to load server:', e?.message || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server bootstrap failed', detail: String(e?.message || e) }));
    return;
  }

  // Handle both direct default export and { default: ... } interop
  if (appPromise && typeof appPromise === 'object' && 'default' in appPromise) {
    appPromise = appPromise.default;
  }
  const app = await (typeof appPromise === 'function' || (appPromise && typeof appPromise.then === 'function') ? appPromise : Promise.resolve(appPromise));
  // Express app is a request handler (callable)
  return app(req, res);
}
