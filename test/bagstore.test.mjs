import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startProvider } from '../provider/source.mjs';
import { startApplication } from '../src/server.mjs';
import { openBagStore, digest } from '../src/bagstore.mjs';

const md5 = value => createHash('md5').update(value).digest('hex');
const temp = async prefix => mkdtemp(join(tmpdir(), prefix));

test('薄袋端到端：登记即缺件，补件重试后具备交接条件，原件与报告分别保留', async () => {
  const directory = await temp('bag-e2e-');
  const source = await startProvider();
  let application = await startApplication({ directory });
  try {
    const register = await fetch(`${application.url}/api/bags`, {
      method: 'POST',
      body: JSON.stringify({ sourceBaseUrl: source.url }),
    });
    assert.equal(register.status, 201);
    const registered = await register.json();
    const bagId = registered.bagId;
    assert.equal(registered.report.status, 'incomplete');
    assert.match(registered.report.summary, /缺件/);
    // payload 与 tag 是两类证明：缺正文时 tag 已全部通过，也不能判整袋通过。
    assert.equal(registered.report.payload.md5.find(row => row.path === 'data/images/map.bin').state, 'missing');
    for (const algorithm of ['md5', 'sha256']) {
      assert.ok(registered.report.tag.manifests[algorithm].every(row => row.state === 'ok'));
    }
    // 报告记录了当时依据的清单摘要，可复核。
    assert.match(registered.report.basis.tagManifests['tagmanifest-sha256.txt'], /^[a-f0-9]{64}$/);
    assert.match(registered.report.basis.payloadManifests['manifest-md5.txt'], /^[a-f0-9]{64}$/);

    // 来源第一次返回 503：补件失败但有记录，袋仍缺件。
    const first = await fetch(`${application.url}/api/bags/${bagId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(first.status, 200);
    const firstReport = await first.json();
    assert.equal(firstReport.status, 'incomplete');
    assert.equal(firstReport.attempts[0].outcome, 'fetch-failed');
    assert.equal(firstReport.attempts[0].error, '来源返回 503');

    // 重试成功：暂存文件提升进袋目录，整袋具备交接条件。
    const second = await fetch(`${application.url}/api/bags/${bagId}/complete`, { method: 'POST', body: JSON.stringify({ reason: 'retry-after-503' }) });
    assert.equal(second.status, 200);
    const finalReport = await second.json();
    assert.equal(finalReport.status, 'ready');
    assert.match(finalReport.summary, /具备交接条件/);
    assert.equal(finalReport.attempts[0].outcome, 'promoted');
    assert.equal(finalReport.attempts[0].bytes, 11);
    assert.equal(finalReport.reason, 'retry-after-503');

    // 历次报告都在，早期缺件结论不被覆盖。
    const reports = await (await fetch(`${application.url}/api/bags/${bagId}/reports`)).json();
    assert.ok(reports.length >= 4);
    assert.equal(reports[0].reason, 'registration');
    assert.equal(reports.at(-1).status, 'ready');
    assert.ok(reports.some(report => report.status === 'incomplete'));
    // 每份报告都携带当时清单依据。
    for (const report of reports) {
      assert.ok(report.basis.payloadManifests['manifest-md5.txt']);
      assert.ok(report.basis.tagManifests['tagmanifest-md5.txt']);
      assert.ok(report.basis.fetch);
    }

    // 补齐的正文可取回，且与 payload 清单一致。
    const delivered = await fetch(`${application.url}/api/bags/${bagId}/file/data/images/map.bin`);
    assert.equal(delivered.status, 200);
    const deliveredBytes = Buffer.from(await delivered.arrayBuffer());
    const manifest = await (await fetch(`${application.url}/api/bags/${bagId}/file/manifest-md5.txt`)).text();
    const expected = manifest.split('\n').find(line => line.endsWith('data/images/map.bin')).split(/\s+/)[0];
    assert.equal(md5(deliveredBytes), expected);

    // 暂存区与交付内容分开：成功后暂存区没有残留 .part。
    const staging = await readdir(join(directory, 'bags', bagId, 'staging'));
    assert.deepEqual(staging, []);

    // 合作方原件未被回填或修改。
    assert.equal((await fetch(`${source.url}/bags/demo/data/images/map.bin`)).status, 404);
    const sourceFetch = await (await fetch(`${source.url}/bags/demo/fetch.txt`)).text();
    assert.match(sourceFetch, /^http:\/\//);

    // 列表与单袋查询反映最新状态。
    const listed = await (await fetch(`${application.url}/api/bags`)).json();
    assert.equal(listed.find(item => item.bagId === bagId).status, 'ready');
    const detail = await (await fetch(`${application.url}/api/bags/${bagId}`)).json();
    assert.equal(detail.latest.status, 'ready');

    // 已完整后再次补件是幂等复核：没有新的下载尝试，状态保持 ready，不会误报内联冲突。
    const recheck = await fetch(`${application.url}/api/bags/${bagId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(recheck.status, 200);
    const recheckReport = await recheck.json();
    assert.equal(recheckReport.status, 'ready');
    assert.deepEqual(recheckReport.attempts, []);
    assert.ok(!recheckReport.structural.some(item => item.code === 'fetchAndInlineConflict'));

    // 重开收件柜后报告与状态仍可复核（含上面幂等复核新增的报告）。
    const expectedCount = (await (await fetch(`${application.url}/api/bags/${bagId}/reports`)).json()).length;
    await application.close();
    application = null;
    const reopenedApp = await startApplication({ directory });
    const reopened = await (await fetch(`${reopenedApp.url}/api/bags/${bagId}/reports`)).json();
    assert.equal(reopened.length, expectedCount);
    assert.equal(reopened.at(-1).status, 'ready');
    await reopenedApp.close();
  } finally {
    if (application) await application.close().catch(() => {});
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('路径越界与非法袋标识在 HTTP 边界被拒绝', async () => {
  const directory = await temp('bag-path-');
  const source = await startProvider();
  const application = await startApplication({ directory });
  try {
    const registered = await (await fetch(`${application.url}/api/bags`, {
      method: 'POST', body: JSON.stringify({ sourceBaseUrl: source.url }),
    })).json();
    const bagId = registered.bagId;
    const traversal = await fetch(`${application.url}/api/bags/${bagId}/file/${encodeURIComponent('../bag-journal.jsonl')}`);
    assert.equal(traversal.status, 422);
    // %2F 按袋格式保持字面、不解码成斜线：该字面文件不存在，而不是被解释成另一条路径。
    const encodedSlash = await fetch(`${application.url}/api/bags/${bagId}/file/${encodeURIComponent('data/..%2Fsecret')}`);
    assert.equal(encodedSlash.status, 404);
    assert.equal((await fetch(`${application.url}/api/bags/unknown-bag`)).status, 404);
    const badId = await fetch(`${application.url}/api/bags`, {
      method: 'POST', body: JSON.stringify({ sourceBaseUrl: source.url, bagId: 'BAD ID' }),
    });
    assert.equal(badId.status, 422);
    const noSource = await fetch(`${application.url}/api/bags`, { method: 'POST', body: '{}' });
    assert.equal(noSource.status, 422);
    // 空请求体可接受（complete 的 body 可选），畸形 JSON 仍被拒绝。
    const emptyBody = await fetch(`${application.url}/api/bags/${bagId}/complete`, { method: 'POST' });
    assert.equal(emptyBody.status, 200);
    const malformed = await fetch(`${application.url}/api/bags`, { method: 'POST', body: '{不是json' });
    assert.equal(malformed.status, 400);
    const badPercent = await fetch(`${application.url}/api/bags/${bagId}/file/data/%E0%A4`);
    assert.equal(badPercent.status, 400);
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// 构造只服务内存袋文件的 fetch 实现，用于异常袋场景。
function mockFetch(baseUrl, files, { overrides = new Map() } = {}) {
  return async (url, init) => {
    if (overrides.has(url)) return overrides.get(url)(url, init);
    if (url === `${baseUrl}/bags/demo`) {
      return new Response(JSON.stringify({ version: '1.0', directory: 'demo', files: [...files.keys()] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const prefix = `${baseUrl}/bags/demo/`;
    if (url.startsWith(prefix)) {
      const name = decodeURIComponent(url.slice(prefix.length));
      if (files.has(name)) return new Response(files.get(name));
    }
    return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
  };
}

const BAGIT = Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n');

function bagFiles(extra = {}) {
  const payload = Buffer.from('image-data\0');
  const manifest = Buffer.from(`${md5(payload)}  data/images/map.bin\n`);
  const fetchTxt = Buffer.from('http://mock.local/payload/data/images/map.bin  11  data/images/map.bin\n');
  const tagmanifest = Buffer.from(
    `${md5(BAGIT)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n${md5(fetchTxt)}  fetch.txt\n`);
  return {
    files: new Map(Object.entries({
      'bagit.txt': BAGIT,
      'manifest-md5.txt': manifest,
      'fetch.txt': fetchTxt,
      'tagmanifest-md5.txt': tagmanifest,
      ...extra,
    })),
    payload,
    manifest,
    fetchTxt,
  };
}

test('下载内容与清单不符：判校验失败，失败字节留在暂存区，不进袋目录', async () => {
  const directory = await temp('bag-bad-');
  const baseUrl = 'http://mock.local';
  const { files } = bagFiles();
  const overrides = new Map([
    ['http://mock.local/payload/data/images/map.bin', () => new Response(Buffer.from('CORRUPTED!!'))],
  ]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files, { overrides }) });
  try {
    const { bagId } = await store.registerBag({ sourceBaseUrl: baseUrl });
    const report = await store.completeBag(bagId);
    assert.equal(report.status, 'failed');
    assert.match(report.summary, /校验失败/);
    assert.equal(report.attempts[0].outcome, 'digest-mismatch');
    assert.equal(report.attempts[0].mismatches[0].algorithm, 'md5');
    // 失败证据保留在暂存区，正文没有被写进袋目录。
    const staging = await readdir(join(directory, 'bags', bagId, 'staging'));
    assert.equal(staging.length, 1);
    assert.match(staging[0], /^failed-.*\.part$/);
    await assert.rejects(access(join(directory, 'bags', bagId, 'bag', 'data', 'images', 'map.bin')));
    // 再次补件仍会重新下载与复核，不会把暂存失败件当作交付内容。
    const again = await store.completeBag(bagId);
    assert.equal(again.status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('长度与 fetch.txt 声明不符时拒绝提升', async () => {
  const directory = await temp('bag-len-');
  const baseUrl = 'http://mock.local';
  const { files } = bagFiles();
  const overrides = new Map([
    ['http://mock.local/payload/data/images/map.bin', () => new Response(Buffer.from('short'))],
  ]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files, { overrides }) });
  try {
    const { bagId } = await store.registerBag({ sourceBaseUrl: baseUrl });
    const report = await store.completeBag(bagId);
    assert.equal(report.status, 'failed');
    assert.equal(report.attempts[0].outcome, 'length-mismatch');
    assert.equal(report.attempts[0].expectedLength, 11);
    assert.equal(report.attempts[0].actualLength, 5);
    // 长度不符的字节也保留在暂存区，未进袋目录。
    const staging = await readdir(join(directory, 'bags', bagId, 'staging'));
    assert.equal(staging.length, 1);
    assert.match(staging[0], /^failed-.*\.part$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('补件地址必须在获准清单内，未授权来源不发起下载', async () => {
  const directory = await temp('bag-origin-');
  const baseUrl = 'http://mock.local';
  const foreignUrl = 'http://foreign.example/payload/data/images/map.bin';
  const foreignFetch = Buffer.from(`${foreignUrl}  11  data/images/map.bin\n`);
  const { files, payload, manifest } = bagFiles();
  files.set('fetch.txt', foreignFetch);
  files.set('tagmanifest-md5.txt', Buffer.from(
    `${md5(BAGIT)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n${md5(foreignFetch)}  fetch.txt\n`));
  let foreignHits = 0;
  const overrides = new Map([[foreignUrl, () => { foreignHits += 1; return new Response(Buffer.from(payload)); }]]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files, { overrides }) });
  try {
    const { bagId } = await store.registerBag({ sourceBaseUrl: baseUrl });
    await assert.rejects(store.completeBag(bagId), error => error.status === 422 && /未获授权/.test(error.message));
    assert.equal(foreignHits, 0);
    // 显式加入获准来源后可以补齐。
    const directory2 = await temp('bag-origin2-');
    const store2 = await openBagStore(directory2, {
      fetchImpl: mockFetch(baseUrl, new Map(files), { overrides }),
    });
    try {
      const registered = await store2.registerBag({
        sourceBaseUrl: baseUrl, allowedOrigins: ['http://foreign.example'],
      });
      const report = await store2.completeBag(registered.bagId);
      assert.equal(foreignHits, 1);
      assert.equal(report.status, 'ready');
    } finally {
      await rm(directory2, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('标签证明失败独立上报：payload 完整但 tagmanifest 不符时整袋不通过', async () => {
  const directory = await temp('bag-tag-');
  const baseUrl = 'http://mock.local';
  const payload = Buffer.from('image-data\0');
  const manifest = Buffer.from(`${md5(payload)}  data/images/map.bin\n`);
  const badTagmanifest = Buffer.from(`${'a'.repeat(32)}  bagit.txt\n`);
  const files = new Map([
    ['bagit.txt', BAGIT],
    ['manifest-md5.txt', manifest],
    ['data/images/map.bin', payload], // 正文已在袋目录，无需 fetch
    ['tagmanifest-md5.txt', badTagmanifest],
  ]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files) });
  try {
    const { report, bagId } = await store.registerBag({ sourceBaseUrl: baseUrl });
    assert.equal(report.status, 'failed');
    assert.equal(report.payload.md5[0].state, 'ok');
    assert.equal(report.tag.manifests.md5[0].state, 'mismatch');
    const detail = await store.getBag(bagId);
    assert.equal(detail.latest.tag.manifests.md5[0].state, 'mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('编码差异造成的同名对象被拒绝，不静默合并为一个文件', async () => {
  const directory = await temp('bag-enc-');
  const baseUrl = 'http://mock.local';
  // 预组合 é 与 e + 组合重音：字面不同，NFC 归一化后同名。
  const composed = 'data/café.txt';
  const decomposed = 'data/café.txt';
  assert.notEqual(composed, decomposed);
  assert.equal(composed.normalize('NFC'), decomposed.normalize('NFC'));
  const payload = Buffer.from('x');
  const manifest = Buffer.from(`${md5(payload)}  ${composed}\n${md5(payload)}  ${decomposed}\n`);
  const tagmanifest = Buffer.from(`${md5(BAGIT)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n`);
  const files = new Map([
    ['bagit.txt', BAGIT],
    ['manifest-md5.txt', manifest],
    ['tagmanifest-md5.txt', tagmanifest],
    [composed, payload],
    [decomposed, Buffer.from('y')],
  ]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files) });
  try {
    const { report } = await store.registerBag({ sourceBaseUrl: baseUrl });
    assert.equal(report.status, 'failed');
    assert.ok(report.structural.some(item => item.code === 'encodingCollision'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fetch.txt 中的越界路径与缺失 payload 清单在登记时被拒绝', async () => {
  const directory = await temp('bag-struct-');
  const baseUrl = 'http://mock.local';
  const evilFetch = Buffer.from('http://mock.local/x  1  data/../escape.txt\n');
  const files = new Map([
    ['bagit.txt', BAGIT],
    ['manifest-md5.txt', Buffer.from(`${md5(Buffer.from('x'))}  data/x.txt\n`)],
    ['fetch.txt', evilFetch],
  ]);
  const store = await openBagStore(directory, { fetchImpl: mockFetch(baseUrl, files) });
  try {
    await assert.rejects(store.registerBag({ sourceBaseUrl: baseUrl }), error => error.status === 422);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('同一袋标识重复登记被拒，已登记袋的原始字节进入内容寻址库', async () => {
  const directory = await temp('bag-dup-');
  const source = await startProvider();
  const store = await openBagStore(directory);
  try {
    const first = await store.registerBag({ sourceBaseUrl: source.url, bagId: 'fixed-bag' });
    assert.equal(first.bagId, 'fixed-bag');
    await assert.rejects(
      store.registerBag({ sourceBaseUrl: source.url, bagId: 'fixed-bag' }),
      error => error.status === 409);
    const manifestBytes = await readFile(join(directory, 'bags', 'fixed-bag', 'bag', 'manifest-md5.txt'));
    await access(join(directory, 'blobs', digest(manifestBytes)));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
