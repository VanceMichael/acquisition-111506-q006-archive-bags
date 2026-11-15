import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const fetchFile = await (await fetch(`${source.url}/bags/demo/fetch.txt`)).text();
    const [location, length, path] = fetchFile.trim().split(/\s+/, 3);
    assert.equal(location, `${source.url}/payload/data/images/map.bin`);
    assert.equal(length, '11');
    assert.equal(path, 'data/images/map.bin');
    const first = await fetch(location);
    assert.equal(first.status, 503);
    const second = await fetch(location);
    assert.equal(second.status, 200);
    assert.equal((await second.arrayBuffer()).byteLength, 11);
    assert.equal((await fetch(`${source.url}/payload/..%2Fescape`)).status, 400);
    const tag = await (await fetch(`${source.url}/bags/demo/tagmanifest-sha256.txt`)).text();
    assert.match(tag, /^[a-f0-9]{64}/);
  } finally { await source.close(); }
});

test('薄袋公开目录与两种标签清单覆盖实际返回字节，补件不改来源袋', async () => {
  const source = await startProvider();
  try {
    const directory = await (await fetch(`${source.url}/bags/demo`)).json();
    assert.equal(directory.version, '1.0');
    assert.ok(directory.files.includes('bagit.txt'));
    assert.ok(directory.files.includes('data/catalog.txt'));
    assert.ok(!directory.files.includes('data/images/map.bin'));
    const contents = new Map();
    for (const name of directory.files) {
      const response = await fetch(`${source.url}/bags/demo/${name}`);
      assert.equal(response.status, 200, name);
      contents.set(name, Buffer.from(await response.arrayBuffer()));
    }
    const expectedTags = directory.files.filter(name => !name.startsWith('data/') && !name.startsWith('tagmanifest-')).sort();
    for (const algorithm of ['md5', 'sha256']) {
      const covered = [];
      for (const line of contents.get(`tagmanifest-${algorithm}.txt`).toString().trim().split('\n')) {
        const [, digest, name] = /^(\S+)\s+(.+)$/.exec(line);
        covered.push(name);
        assert.equal(createHash(algorithm).update(contents.get(name)).digest('hex'), digest, name);
      }
      assert.deepEqual(covered.sort(), expectedTags);
    }
    const manifest = contents.get('manifest-md5.txt').toString();
    for (const line of manifest.trim().split('\n')) {
      const [, digest, name] = /^(\S+)\s+(.+)$/.exec(line);
      if (contents.has(name)) assert.equal(createHash('md5').update(contents.get(name)).digest('hex'), digest);
    }
    const location = contents.get('fetch.txt').toString().split(/\s+/)[0];
    assert.equal((await fetch(location)).status, 503);
    const payload = Buffer.from(await (await fetch(location)).arrayBuffer());
    const expected = manifest.split('\n').find(line => line.endsWith('data/images/map.bin')).split(/\s+/)[0];
    assert.equal(createHash('md5').update(payload).digest('hex'), expected);
    assert.equal((await fetch(`${source.url}/bags/demo/data/images/map.bin`)).status, 404);
    assert.equal((await fetch(`${source.url}/bags/demo/fetch.txt`)).status, 200);
  } finally { await source.close(); }
});
