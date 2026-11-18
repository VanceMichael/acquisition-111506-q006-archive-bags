import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeBagPath, validateBagPath, parseManifest, parseFetch, validateBagIt, evaluateBag, manifestKind,
} from '../src/bagit.mjs';

test('袋路径只按 RFC8493 转义 LF/CR/百分号，普通百分号序列保持字面，不做 URL 解码', () => {
  assert.equal(decodeBagPath('data/a%0Ab.txt'), 'data/a\nb.txt');
  assert.equal(decodeBagPath('data/a%0Db.txt'), 'data/a\rb.txt');
  assert.equal(decodeBagPath('data/100%25.txt'), 'data/100%.txt');
  // %2F 是编码差异，不能解码成斜线，更不能反复解码（%252F -> %2F 而非 /）。
  assert.equal(decodeBagPath('data/a%2Fb'), 'data/a%2Fb');
  assert.equal(decodeBagPath('data/a%252Fb'), 'data/a%2Fb');
  assert.equal(decodeBagPath('data/%41.txt'), 'data/%41.txt');
});

test('袋路径拒绝绝对路径、反斜杠、空段与点段', () => {
  assert.throws(() => validateBagPath('/etc/passwd'), { status: 422 });
  assert.throws(() => validateBagPath('data/../escape'), { status: 422 });
  assert.throws(() => validateBagPath('data/./x'), { status: 422 });
  assert.throws(() => validateBagPath('data//x'), { status: 422 });
  assert.throws(() => validateBagPath('data\\x'), { status: 422 });
  assert.throws(() => validateBagPath('data/a\0'), { status: 422 });
  assert.deepEqual(validateBagPath('data/images/map.bin'), ['data', 'images', 'map.bin']);
});

test('清单文件名区分 payload 与 tag 两类证明对象', () => {
  assert.deepEqual(manifestKind('manifest-md5.txt'), { algorithm: 'md5', kind: 'payload' });
  assert.deepEqual(manifestKind('tagmanifest-sha256.txt'), { algorithm: 'sha256', kind: 'tag' });
  assert.equal(manifestKind('fetch.txt'), null);
});

test('同一清单内重复条目直接报错，不允许后者覆盖前者', () => {
  const text = 'a'.repeat(32) + '  data/x.txt\n' + 'b'.repeat(32) + '  data/x.txt\n';
  assert.throws(() => parseManifest(text, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' }),
    error => error.issue.code === 'duplicateEntry');
});

test('清单行格式与摘要长度严格校验', () => {
  assert.throws(() => parseManifest('not-a-line\n', { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' }),
    error => error.issue.code === 'malformedLine');
  assert.throws(
    () => parseManifest('abc  data/x.txt\n', { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' }),
    error => error.issue.code === 'badDigest');
  assert.throws(
    () => parseManifest('zz  data/x.txt\n', { fileName: 'manifest-sha256.txt', algorithm: 'sha256', kind: 'payload' }),
    error => error.issue.code === 'badDigest');
  const entries = parseManifest(`${'a'.repeat(32)}  data/x.txt\n`, {
    fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload',
  });
  assert.equal(entries[0].path, 'data/x.txt');
});

test('payload 清单条目必须位于 data/ 下，tagmanifest 不能覆盖 data/ 或另一份 tagmanifest', () => {
  assert.throws(
    () => parseManifest(`${'a'.repeat(32)}  bagit.txt\n`, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' }),
    error => error.issue.code === 'payloadOutsideData');
  assert.throws(
    () => parseManifest(`${'a'.repeat(32)}  data/x.txt\n`, { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' }),
    error => error.issue.code === 'badTagEntry');
  assert.throws(
    () => parseManifest(`${'a'.repeat(32)}  tagmanifest-sha256.txt\n`, { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' }),
    error => error.issue.code === 'badTagEntry');
  // payload manifest 本身是合法的标签文件，可以被 tagmanifest 证明。
  assert.doesNotThrow(() => parseManifest(`${'a'.repeat(32)}  manifest-md5.txt\n`, {
    fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag',
  }));
});

test('fetch.txt 解析 URL、长度与袋路径，重复路径与非 http(s) 地址被拒', () => {
  const text = 'https://example.org/a.bin  11  data/a.bin\nhttp://example.org/b  -  data/b.txt\n';
  const entries = parseFetch(text);
  assert.equal(entries[0].origin, 'https://example.org');
  assert.equal(entries[0].length, 11);
  assert.equal(entries[1].length, null);
  assert.throws(() => parseFetch('ftp://x/a 1 data/a.bin\n'), error => error.issue.code === 'badUrl');
  assert.throws(() => parseFetch('http://x/a 11 data/a.bin\nhttp://x/b 12 data/a.bin\n'),
    error => error.issue.code === 'duplicateEntry');
  assert.throws(() => parseFetch('http://x/a 11 bagit.txt\n'), error => error.issue.code === 'fetchOutsideData');
});

test('bagit.txt 必须声明 1.0 与 UTF-8', () => {
  assert.throws(() => validateBagIt(Buffer.from('BagIt-Version: 0.97\nTag-File-Character-Encoding: UTF-8\n')),
    error => error.issue.code === 'badBagIt');
  assert.doesNotThrow(() => validateBagIt(Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n')));
});

function makeReader(files) {
  return async path => Object.hasOwn(files, path) ? files[path] : null;
}

const md5 = value => createHash('md5').update(value).digest('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('验收分别报告 payload 与 tag，tag 通过不代表整袋通过', async () => {
  const payload = Buffer.from('hello');
  const bagit = Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n');
  const manifestText = `${md5(payload)}  data/p.txt\n`;
  const manifest = Buffer.from(manifestText);
  const tagManifest = Buffer.from(`${md5(bagit)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n`);
  const base = {
    payloadManifests: new Map([['md5', parseManifest(manifestText, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' })]]),
    tagManifests: new Map([['md5', parseManifest(tagManifest.toString(), { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' })]]),
    fetchEntries: [],
    presentTagFiles: ['bagit.txt', 'manifest-md5.txt'],
  };
  // 正文缺失：tag 全部通过，但整袋仍是缺件。
  const missing = await evaluateBag({ ...base, read: makeReader({ 'bagit.txt': bagit, 'manifest-md5.txt': manifest }) });
  assert.equal(missing.status, 'incomplete');
  assert.equal(missing.payload.md5[0].state, 'missing');
  assert.deepEqual(missing.tag.manifests.md5.map(row => row.state), ['ok', 'ok']);
  // 正文补齐后整袋才具备交接条件。
  const ready = await evaluateBag({ ...base, read: makeReader({ 'bagit.txt': bagit, 'manifest-md5.txt': manifest, 'data/p.txt': payload }) });
  assert.equal(ready.status, 'ready');
});

test('正文内容与清单不符判为校验失败，优先级高于缺件', async () => {
  const payload = Buffer.from('hello');
  const wrong = Buffer.from('HELLO');
  const manifestText = `${md5(payload)}  data/p.txt\n`;
  const manifest = Buffer.from(manifestText);
  const bagit = Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n');
  const tagManifest = Buffer.from(`${md5(bagit)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n`);
  const result = await evaluateBag({
    payloadManifests: new Map([['md5', parseManifest(manifestText, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' })]]),
    tagManifests: new Map([['md5', parseManifest(tagManifest.toString(), { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' })]]),
    fetchEntries: [],
    presentTagFiles: ['bagit.txt', 'manifest-md5.txt'],
    read: makeReader({ 'bagit.txt': bagit, 'manifest-md5.txt': manifest, 'data/p.txt': wrong }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.payload.md5[0].state, 'mismatch');
  assert.match(result.summary, /校验失败/);
});

test('同一正文出现在多个算法清单且结论冲突时显式上报，不被任一清单覆盖', async () => {
  const payload = Buffer.from('payload-bytes');
  const manifestMd5Text = `${md5(payload)}  data/p.txt\n`;
  // 伪造 sha256 清单，使同一正文在 sha256 下不符。
  const manifestShaText = `${'f'.repeat(64)}  data/p.txt\n`;
  const bagit = Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n');
  const tagMd5 = Buffer.from(`${md5(bagit)}  bagit.txt\n`);
  const tagSha = Buffer.from(`${sha256(bagit)}  bagit.txt\n`);
  const result = await evaluateBag({
    payloadManifests: new Map([
      ['md5', parseManifest(manifestMd5Text, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' })],
      ['sha256', parseManifest(manifestShaText, { fileName: 'manifest-sha256.txt', algorithm: 'sha256', kind: 'payload' })],
    ]),
    tagManifests: new Map([
      ['md5', parseManifest(tagMd5.toString(), { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' })],
      ['sha256', parseManifest(tagSha.toString(), { fileName: 'tagmanifest-sha256.txt', algorithm: 'sha256', kind: 'tag' })],
    ]),
    fetchEntries: [],
    presentTagFiles: ['bagit.txt'],
    read: makeReader({ 'bagit.txt': bagit, 'data/p.txt': payload }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.payload.md5[0].state, 'ok');
  assert.equal(result.payload.sha256[0].state, 'mismatch');
  assert.ok(result.structural.some(item => item.code === 'manifestConflict'));
});

test('编码差异造成的同名对象被检测，不静默合并；fetch 条目必须在清单内', async () => {
  const payload = Buffer.from('x');
  // 两个字面不同、NFC 归一化后相同的路径。
  const composed = 'data/café.txt';
  const decomposed = 'data/café.txt';
  assert.notEqual(composed, decomposed);
  assert.equal(composed.normalize('NFC'), decomposed.normalize('NFC'));
  const manifestText = `${md5(payload)}  ${composed}\n${md5(payload)}  ${decomposed}\n`;
  const result = await evaluateBag({
    payloadManifests: new Map([['md5', parseManifest(manifestText, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' })]]),
    tagManifests: new Map(),
    fetchEntries: parseFetch('http://example.org/x 1 data/other.bin\n'),
    presentTagFiles: [],
    read: makeReader({ [composed]: payload }),
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.structural.some(item => item.code === 'encodingCollision'));
  assert.ok(result.structural.some(item => item.code === 'fetchNotInManifest'));
});

test('fetch.txt 列出的正文已内联时：字节正确视为已补齐，字节错误判结构冲突', async () => {
  const payload = Buffer.from('hello');
  const manifestText = `${md5(payload)}  data/p.txt\n`;
  const manifest = Buffer.from(manifestText);
  const bagit = Buffer.from('BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n');
  const tagManifest = Buffer.from(`${md5(bagit)}  bagit.txt\n${md5(manifest)}  manifest-md5.txt\n`);
  const base = {
    payloadManifests: new Map([['md5', parseManifest(manifestText, { fileName: 'manifest-md5.txt', algorithm: 'md5', kind: 'payload' })]]),
    tagManifests: new Map([['md5', parseManifest(tagManifest.toString(), { fileName: 'tagmanifest-md5.txt', algorithm: 'md5', kind: 'tag' })]]),
    fetchEntries: parseFetch('http://example.org/p 5 data/p.txt\n'),
    presentTagFiles: ['bagit.txt', 'manifest-md5.txt'],
  };
  // 内联字节与清单一致：相当于补件已完成（重启后复核也是同样结论），整袋通过。
  const completed = await evaluateBag({
    ...base, presentPaths: new Set(['data/p.txt']),
    read: makeReader({ 'bagit.txt': bagit, 'manifest-md5.txt': manifest, 'data/p.txt': payload }),
  });
  assert.equal(completed.status, 'ready');
  // 内联字节与清单不符：来源自相矛盾，判结构冲突。
  const conflict = await evaluateBag({
    ...base, presentPaths: new Set(['data/p.txt']),
    read: makeReader({ 'bagit.txt': bagit, 'manifest-md5.txt': manifest, 'data/p.txt': Buffer.from('HELLO') }),
  });
  assert.equal(conflict.status, 'failed');
  assert.ok(conflict.structural.some(item => item.code === 'fetchAndInlineConflict'));
});
