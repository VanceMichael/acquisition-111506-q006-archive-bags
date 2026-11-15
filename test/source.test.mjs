import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const fetchFile = await (await fetch(`${source.url}/bags/demo/fetch.txt`)).text();
    assert.match(fetchFile, /data%2Fimages%2Fmap.bin/);
    const first = await fetch(`${source.url}/payload/data/images/map.bin`);
    assert.equal(first.status, 503);
    const second = await fetch(`${source.url}/payload/data/images/map.bin`);
    assert.equal(second.status, 200);
    assert.equal((await second.arrayBuffer()).byteLength, 11);
    assert.equal((await fetch(`${source.url}/payload/..%2Fescape`)).status, 400);
    const tag = await (await fetch(`${source.url}/bags/demo/tagmanifest-sha256.txt`)).text();
    assert.match(tag, /^[a-f0-9]{64}/);
  } finally { await source.close(); }
});
