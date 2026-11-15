
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serve, json, bytes } from './http.mjs';
const bag = JSON.parse(await readFile(new URL('../fixtures/bag.json', import.meta.url)));
const files = JSON.parse(await readFile(new URL('../fixtures/objects.json', import.meta.url)));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    const origin = `http://${request.headers.host}`;
    const fetchText = bag.fetch.replace(/^\S+/, new URL('/payload/data/images/map.bin', origin).href);
    const tagFiles = {
      'bagit.txt': Buffer.from(files['bagit.txt'], 'base64'),
      'bag-info.txt': Buffer.from(files['bag-info.txt'], 'base64'),
      'tag-audit.txt': Buffer.from(files['tag-audit.txt'], 'base64'),
      'manifest-md5.txt': Buffer.from(bag.payloadManifest),
      'fetch.txt': Buffer.from(fetchText)
    };
    const manifests = Object.fromEntries(['md5', 'sha256'].map(algorithm => [
      `tagmanifest-${algorithm}.txt`,
      Buffer.from(Object.entries(tagFiles).map(([name, content]) =>
        `${createHash(algorithm).update(content).digest('hex')}  ${name}\n`).join(''))
    ]));
    const inlineFiles = Object.fromEntries(Object.entries(bag.inline).map(([name, content]) => [name, Buffer.from(content)]));
    const presentFiles = { ...tagFiles, ...manifests, ...inlineFiles };
    if (url.pathname === '/bags/demo') return json(response, { version: '1.0', directory: 'demo', files: Object.keys(presentFiles) });
    if (url.pathname.startsWith('/bags/demo/')) {
      const path = decodeURIComponent(url.pathname.slice('/bags/demo/'.length));
      if (Object.hasOwn(presentFiles, path)) return bytes(response, presentFiles[path], path.endsWith('.txt') ? 'text/plain' : 'application/octet-stream');
      return json(response, { error: 'missing' }, 404);
    }
    if (url.pathname.startsWith('/payload/')) {
      const path = decodeURIComponent(url.pathname.slice('/payload/'.length));
      if (path.includes('..')) return json(response, { error: 'invalid_path' }, 400);
      state.fetches ??= {};
      state.fetches[path] = (state.fetches[path] ?? 0) + 1;
      if (path === 'data/images/map.bin' && state.fetches[path] === 1) return json(response, { error: 'temporarily_unavailable' }, 503);
      if (!files[path]) return json(response, { error: 'missing' }, 404);
      return bytes(response, Buffer.from(files[path], 'base64'));
    }
    return false;
  }, options);
}
