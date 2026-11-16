import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { serve, json, bytes } from '../provider/http.mjs';
import { decodeBagPath, parseFetchTxt, parseManifest, findEncodingCollisions } from '../src/bagit.mjs';

const sha256 = content => createHash('sha256').update(content).digest('hex');

async function startIntake() {
  const directory = await mkdtemp(join(tmpdir(), 'bagit-'));
  const application = await startApplication({ directory });
  return {
    directory,
    application,
    async close() {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const collect = (application, body = {}) => fetch(`${application.url}/api/collect`, { method: 'POST', body: JSON.stringify(body) });

// 本地合成一个可控的 BagIt 薄袋来源：目录清单、标签文件、各算法清单与 fetch 路由都可定制。
function stubBagHandler({
  payloads = {},
  fetchFiles = [],
  payloadAlgorithms = ['md5'],
  tagAlgorithms = ['md5', 'sha256'],
  extraTags = {},
  identifier = 'stub-bag',
  corruptBeforeTagmanifest = {},
  corrupt = {},
} = {}) {
  return async ({ request, response, url, state }) => {
    const origin = `http://${request.headers.host}`;
    const files = new Map();
    files.set('bagit.txt', Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n'));
    files.set('bag-info.txt', Buffer.from(`External-Identifier: ${identifier}\n`));
    for (const [name, content] of Object.entries(extraTags)) files.set(name, Buffer.from(content));
    if (fetchFiles.length) {
      files.set('fetch.txt', Buffer.from(fetchFiles.map(file =>
        `${file.absoluteUrl ?? origin + file.route}  ${file.length ?? '-'}  ${file.rawPath ?? file.path}\n`).join('')));
    }
    for (const algorithm of payloadAlgorithms) {
      files.set(`manifest-${algorithm}.txt`, Buffer.from(Object.entries(payloads)
        .map(([path, content]) => `${createHash(algorithm).update(Buffer.from(content)).digest('hex')}  ${path}\n`).join('')));
    }
    const present = new Map(files);
    const fetchedPaths = new Set(fetchFiles.filter(file => !file.keepInline).map(file => file.path));
    for (const [path, content] of Object.entries(payloads)) {
      if (!fetchedPaths.has(path)) present.set(path, Buffer.from(content));
    }
    for (const [name, fn] of Object.entries(corruptBeforeTagmanifest)) present.set(name, fn(present.get(name)));
    const tagNames = [...present.keys()].filter(name => !name.startsWith('data/') && !name.startsWith('tagmanifest-')).sort();
    for (const algorithm of tagAlgorithms) {
      present.set(`tagmanifest-${algorithm}.txt`, Buffer.from(tagNames
        .map(name => `${createHash(algorithm).update(present.get(name)).digest('hex')}  ${name}\n`).join('')));
    }
    for (const [name, fn] of Object.entries(corrupt)) present.set(name, fn(present.get(name)));
    if (url.pathname === '/bags/demo') return json(response, { version: '1.0', directory: 'stub', files: [...present.keys()] });
    if (url.pathname.startsWith('/bags/demo/')) {
      const path = decodeURIComponent(url.pathname.slice('/bags/demo/'.length));
      if (present.has(path)) return bytes(response, present.get(path), 'text/plain');
      return json(response, { error: 'missing' }, 404);
    }
    const fetchFile = fetchFiles.find(file => file.route && file.route === url.pathname);
    if (fetchFile) {
      state.counts ??= {};
      state.counts[fetchFile.route] = (state.counts[fetchFile.route] ?? 0) + 1;
      const content = Buffer.from(fetchFile.content ?? '');
      if (fetchFile.behavior) return fetchFile.behavior({ response, state, content });
      return bytes(response, content);
    }
    return false;
  };
}

const replaceDigest = (pattern, replacement) => content =>
  Buffer.from(content.toString().replace(pattern, match => replacement + match.slice(match.indexOf('  '))));

test('单元：袋内路径按交接格式解码一次，拒绝危险形式', () => {
  assert.equal(decodeBagPath('data/images/map.bin'), 'data/images/map.bin');
  assert.equal(decodeBagPath('data/100%25.txt'), 'data/100%.txt');
  assert.equal(decodeBagPath('data/a%2520b.txt'), 'data/a%20b.txt');
  assert.equal(decodeBagPath('data/my file.txt'), 'data/my file.txt');
  assert.throws(() => decodeBagPath('../escape.txt'), /相对分段/);
  assert.throws(() => decodeBagPath('..%2F..%2Fescape'), /相对分段/);
  assert.throws(() => decodeBagPath('%2e%2e%2fescape'), /相对分段/);
  assert.throws(() => decodeBagPath('/abs/path'), /绝对路径/);
  assert.throws(() => decodeBagPath('data//double'), /空分段/);
  assert.throws(() => decodeBagPath('data\\back'), /反斜线/);
  assert.throws(() => decodeBagPath('bad%ffutf8'), /UTF-8/);
  assert.throws(() => decodeBagPath('truncated%2'), /转义不完整/);
  assert.throws(() => decodeBagPath('ctrl%0Achar'), /控制字符/);
});

test('单元：fetch.txt 与清单解析，同路径冲突被记录而不是覆盖', () => {
  const fetch = parseFetchTxt('http://a/b  11  data/images/map.bin\nhttp://c/d  -  data/my file.txt\nbad-line\n');
  assert.equal(fetch.entries.length, 2);
  assert.deepEqual(fetch.entries[0], { url: 'http://a/b', length: 11, path: 'data/images/map.bin', line: 1 });
  assert.equal(fetch.entries[1].length, null);
  assert.equal(fetch.entries[1].path, 'data/my file.txt');
  assert.equal(fetch.problems.length, 1);
  assert.equal(fetch.problems[0].reason, 'fetch_line_malformed');
  const manifest = parseManifest(`${'a'.repeat(32)}  data/x.txt\n${'b'.repeat(32)}  data/x.txt\n${'c'.repeat(32)} *data/y.txt\n`, 'manifest-md5.txt');
  assert.equal(manifest.entries.get('data/x.txt'), 'a'.repeat(32));
  assert.equal(manifest.conflicts.length, 1);
  assert.equal(manifest.conflicts[0].reason, 'manifest_digest_conflict');
  assert.equal(manifest.conflicts[0].rejected, 'b'.repeat(32));
  assert.equal(manifest.entries.get('data/y.txt'), 'c'.repeat(32));
  const collisions = findEncodingCollisions(['café.txt', 'café.txt', 'other.txt']);
  assert.equal(collisions.length, 1);
  assert.deepEqual([...collisions[0]].sort(), ['café.txt', 'café.txt'].sort());
});

test('薄袋端到端：补件、分项验收、正文与依据回查、同件幂等', async () => {
  const intake = await startIntake();
  const source = await startProvider();
  try {
    assert.equal((await fetch(`${intake.application.url}/api/bags/status?key=loan-17`)).status, 404);
    const first = await collect(intake.application, { source: source.url });
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.equal(receipt.key, 'loan-17');
    assert.equal(receipt.record.verification.status, 'complete');
    assert.equal(receipt.record.verification.payload.status, 'pass');
    assert.equal(receipt.record.verification.tag.status, 'pass');
    assert.deepEqual(Object.keys(receipt.record.verification.tag.algorithms).sort(), ['md5', 'sha256']);
    const map = receipt.record.payloads.find(item => item.path === 'data/images/map.bin');
    assert.equal(map.state, 'fetched');
    assert.equal(map.size, 11);
    const file = await fetch(`${intake.application.url}/api/bags/files?key=loan-17&path=${encodeURIComponent('data/images/map.bin')}`);
    assert.equal(file.status, 200);
    const body = Buffer.from(await file.arrayBuffer());
    assert.equal(body.length, 11);
    assert.equal(sha256(body), map.sha256);
    const listing = await (await fetch(`${intake.application.url}/api/bags/files?key=loan-17`)).json();
    assert.ok(listing.files.includes('data/images/map.bin'));
    assert.ok(listing.files.includes('manifest-md5.txt'));
    const status = await (await fetch(`${intake.application.url}/api/bags/status?key=loan-17`)).json();
    assert.equal(status.status, 'complete');
    assert.equal(status.statusLabel, '具备交接条件');
    const used = receipt.record.automation.manifests.find(item => item.path === 'manifest-md5.txt');
    const evidenceBytes = await (await fetch(`${intake.application.url}/api/evidence/${used.sha256}`)).text();
    const served = await (await fetch(`${source.url}/bags/demo/manifest-md5.txt`)).text();
    assert.equal(evidenceBytes, served);
    assert.deepEqual(await readdir(join(intake.directory, 'staging')), []);
    assert.equal((await readdir(join(intake.directory, 'bags'))).length, 1);
    const again = await collect(intake.application, { source: source.url });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    const history = await (await fetch(`${intake.application.url}/api/history?key=loan-17`)).json();
    assert.equal(history.length, 1);
  } finally {
    await intake.close();
    await source.close();
  }
});

test('缺件状态与补件重试：历史版本与当时依据都可复核', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'A', 'data/big.bin': 'BIG-CONTENT' },
    fetchFiles: [{
      route: '/dl/big.bin',
      path: 'data/big.bin',
      content: 'BIG-CONTENT',
      length: 11,
      behavior: ({ response, state, content }) => (state.down ? json(response, { error: 'temporarily_unavailable' }, 503) : bytes(response, content)),
    }],
  }));
  source.state.down = true;
  try {
    const first = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(first.record.verification.status, 'incomplete');
    assert.equal(first.record.verification.payload.status, 'incomplete');
    assert.deepEqual(first.record.verification.payload.missing, [{ path: 'data/big.bin', reason: 'fetch_failed' }]);
    assert.equal(first.record.verification.tag.status, 'pass');
    const missingFile = await fetch(`${intake.application.url}/api/bags/files?key=stub-bag&path=${encodeURIComponent('data/big.bin')}`);
    assert.equal(missingFile.status, 404);
    source.state.down = false;
    const second = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(second.record.verification.status, 'complete');
    const history = await (await fetch(`${intake.application.url}/api/history?key=stub-bag`)).json();
    assert.equal(history.length, 2);
    const firstManifest = first.record.automation.manifests.find(item => item.path === 'manifest-md5.txt');
    const evidence = await fetch(`${intake.application.url}/api/evidence/${firstManifest.sha256}`);
    assert.equal(evidence.status, 200);
    assert.ok((await evidence.text()).includes('data/big.bin'));
    const status = await (await fetch(`${intake.application.url}/api/bags/status?key=stub-bag`)).json();
    assert.equal(status.status, 'complete');
    assert.equal(status.sequence, 2);
  } finally {
    await intake.close();
    await source.close();
  }
});

test('正文内容校验失败：tagmanifest 通过不能代替整袋通过', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'A', 'data/big.bin': 'EXPECTED!!!' },
    fetchFiles: [{ route: '/dl/big.bin', path: 'data/big.bin', content: 'CORRUPTED!!', length: 11 }],
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.status, 'failed');
    assert.equal(receipt.record.verification.payload.status, 'fail');
    assert.deepEqual(receipt.record.verification.payload.algorithms.md5.mismatches, ['data/big.bin']);
    assert.equal(receipt.record.verification.tag.status, 'pass');
    const file = await fetch(`${intake.application.url}/api/bags/files?key=stub-bag&path=${encodeURIComponent('data/big.bin')}`);
    assert.equal(file.status, 404);
    const listing = await (await fetch(`${intake.application.url}/api/bags/files?key=stub-bag`)).json();
    assert.ok(listing.files.includes('data/a.txt'));
    assert.ok(!listing.files.includes('data/big.bin'));
  } finally {
    await intake.close();
    await source.close();
  }
});

test('tagmanifest 校验失败独立于 payload，多个 tagmanifest 不互相覆盖', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'A' },
    corrupt: {
      'tagmanifest-md5.txt': replaceDigest(/^([0-9a-f]{32})( {2}bag-info\.txt)$/m, '0'.repeat(32)),
    },
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.tag.algorithms.md5.status, 'fail');
    assert.deepEqual(receipt.record.verification.tag.algorithms.md5.mismatches, ['bag-info.txt']);
    assert.equal(receipt.record.verification.tag.algorithms.sha256.status, 'pass');
    assert.equal(receipt.record.verification.payload.status, 'pass');
    assert.equal(receipt.record.verification.status, 'failed');
  } finally {
    await intake.close();
    await source.close();
  }
});

test('同一正文出现在多个算法清单：一种算法失败不被另一种覆盖', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'AAA' },
    payloadAlgorithms: ['md5', 'sha256'],
    corruptBeforeTagmanifest: {
      'manifest-sha256.txt': replaceDigest(/^([0-9a-f]{64})( {2}data\/a\.txt)$/m, 'f'.repeat(64)),
    },
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.payload.algorithms.md5.status, 'pass');
    assert.equal(receipt.record.verification.payload.algorithms.sha256.status, 'fail');
    assert.deepEqual(receipt.record.verification.payload.algorithms.sha256.mismatches, ['data/a.txt']);
    assert.equal(receipt.record.verification.tag.status, 'pass');
    assert.equal(receipt.record.verification.status, 'failed');
  } finally {
    await intake.close();
    await source.close();
  }
});

test('fetch.txt 危险路径被拒绝，不会写出袋目录', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'A' },
    fetchFiles: [
      { route: '/dl/escape', path: 'escape.txt', rawPath: '..%2Fescape.txt', content: 'X' },
      { route: '/dl/abs', path: 'abs', rawPath: '%2Fetc%2Fpasswd', content: 'Y' },
    ],
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.status, 'failed');
    const invalids = receipt.record.verification.problems.filter(problem => problem.reason === 'invalid_path');
    assert.equal(invalids.length, 2);
    assert.equal(source.state.counts, undefined);
    const top = await readdir(intake.directory);
    assert.ok(!top.includes('escape.txt'));
    assert.deepEqual(await readdir(join(intake.directory, 'staging')), []);
    const listing = await (await fetch(`${intake.application.url}/api/bags/files?key=stub-bag`)).json();
    assert.ok(!listing.files.some(file => file.includes('escape') || file.includes('passwd')));
  } finally {
    await intake.close();
    await source.close();
  }
});

test('编码差异造成的同名对象被检测为冲突，而不是静默合并', async () => {
  const intake = await startIntake();
  const source = await serve(stubBagHandler({
    payloads: { 'data/images/map.bin': 'INLINE-CONTENT' },
    fetchFiles: [{
      route: '/dl/map.bin',
      path: 'data/images/map.bin',
      rawPath: 'data/images/%6dap.bin',
      content: 'FETCHED-CONTENT!',
      keepInline: true,
    }],
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.status, 'failed');
    const conflict = receipt.record.verification.problems.find(problem => problem.reason === 'duplicate_source');
    assert.equal(conflict.path, 'data/images/map.bin');
    assert.equal(source.state.counts, undefined);
    const file = await fetch(`${intake.application.url}/api/bags/files?key=stub-bag&path=${encodeURIComponent('data/images/map.bin')}`);
    assert.equal(await file.text(), 'INLINE-CONTENT');
  } finally {
    await intake.close();
    await source.close();
  }
});

test('fetch.txt 只从获准地址补件，其他地址不发起请求', async () => {
  const intake = await startIntake();
  const evil = await serve(() => false);
  const source = await serve(stubBagHandler({
    payloads: { 'data/a.txt': 'A', 'data/ext.bin': 'EXT' },
    fetchFiles: [
      { absoluteUrl: `${evil.url}/dl/ext.bin`, path: 'data/ext.bin', content: 'EXT' },
      { absoluteUrl: 'file:///etc/passwd', path: 'data/passwd', content: 'X' },
    ],
  }));
  try {
    const receipt = await (await collect(intake.application, { source: source.url })).json();
    assert.equal(receipt.record.verification.status, 'incomplete');
    assert.deepEqual(receipt.record.verification.payload.missing, [{ path: 'data/ext.bin', reason: 'fetch_rejected' }]);
    const fetches = receipt.record.automation.fetch;
    assert.equal(fetches.find(item => item.path === 'data/ext.bin').reason, 'origin_not_approved');
    assert.equal(fetches.find(item => item.path === 'data/passwd').reason, 'scheme_not_allowed');
    assert.equal(evil.events.length, 0);
  } finally {
    await intake.close();
    await source.close();
    await evil.close();
  }
});

test('来源不可达与非法输入的边界', async () => {
  const intake = await startIntake();
  try {
    assert.equal((await collect(intake.application, { source: 'ftp://example' })).status, 400);
    assert.equal((await collect(intake.application, { source: 'http://127.0.0.1:1' })).status, 502);
    assert.equal((await collect(intake.application, { bagPath: '../escape' })).status, 400);
    assert.equal((await collect(intake.application, { source: 42 })).status, 400);
  } finally {
    await intake.close();
  }
});
