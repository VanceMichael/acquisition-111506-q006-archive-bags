
import { readFile } from 'node:fs/promises';
import { serve, json, bytes } from './http.mjs';
const bag = JSON.parse(await readFile(new URL('../fixtures/bag.json', import.meta.url)));
const files = JSON.parse(await readFile(new URL('../fixtures/objects.json', import.meta.url)));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/bags/demo/manifest-md5.txt') return bytes(response, bag.payloadManifest, 'text/plain');
    if (url.pathname.startsWith('/bags/demo/tagmanifest-')) {
      const algorithm = url.pathname.includes('sha256') ? 'sha256' : 'md5';
      const index = algorithm === 'sha256' ? 1 : 0;
      return bytes(response, bag.tagManifests[index], 'text/plain');
    }
    if (url.pathname === '/bags/demo/fetch.txt') return bytes(response, bag.fetch, 'text/plain');
    if (url.pathname.startsWith('/payload/')) {
      const path = decodeURIComponent(url.pathname.slice('/payload/'.length));
      if (path.includes('..')) return json(response, { error: 'invalid_path' }, 400);
      state.fetches ??= {};
      state.fetches[path] = (state.fetches[path] ?? 0) + 1;
      if (path === 'data/images/map.bin' && state.fetches[path] === 1) return json(response, { error: 'temporarily_unavailable' }, 503);
      if (!files[path]) return json(response, { error: 'missing' }, 404);
      return bytes(response, Buffer.from(files[path], 'base64'));
    }
    if (url.pathname === '/bags/demo') return json(response, { version: '1.0', directory: 'demo' });
    return false;
  }, options);
}
