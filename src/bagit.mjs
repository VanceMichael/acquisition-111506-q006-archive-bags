// BagIt 1.0（RFC 8493）薄袋解析与验收逻辑。
// 本模块只做纯解析与校验，不发起网络请求、不写文件，字节通过注入的 read 回查。

import { createHash } from 'node:crypto';

export const HEX_LENGTH = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
export const KNOWN_ALGORITHMS = new Set(Object.keys(HEX_LENGTH));

const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code: 'BAGIT_INVALID', status: 422, issue: { code, message, ...extra } });
};

// RFC 8493 2.2.3：清单与 fetch.txt 的路径只转义 LF、CR、百分号本身。
// 其它百分号序列（如 %2f、%41）一律按字面保留，不做 URL 解码，更不能反复解码。
export function decodeBagPath(value) {
  return value.replace(/%[0-9A-Fa-f]{2}/g, token => {
    switch (token.toUpperCase()) {
      case '%0A': return '\n';
      case '%0D': return '\r';
      case '%25': return '%';
      default: return token;
    }
  });
}

// 袋相对路径解释：拒绝绝对路径、反斜杠、NUL、空段、. 与 .. 段。
// 返回按斜线切分的段，供调用方再次做目录包含检查。
export function validateBagPath(path) {
  if (typeof path !== 'string' || path.length === 0) fail('invalidPath', '袋内路径不能为空');
  if (path.includes('\0')) fail('invalidPath', '袋内路径不能包含 NUL', { path });
  if (path.includes('\\')) fail('invalidPath', '袋内路径必须使用正斜线，不能包含反斜杠', { path });
  if (path.startsWith('/')) fail('invalidPath', '袋内路径不能是绝对路径', { path });
  const segments = path.split('/');
  if (segments.some(segment => segment === '')) fail('invalidPath', '袋内路径不能包含空段', { path });
  if (segments.some(segment => segment === '.' || segment === '..')) {
    fail('pathTraversal', '袋内路径不能包含 . 或 .. 段', { path });
  }
  return segments;
}

export function manifestKind(fileName) {
  const match = /^(tag)?manifest-([a-z0-9]+)\.txt$/.exec(fileName);
  if (!match) return null;
  return { algorithm: match[2], kind: match[1] ? 'tag' : 'payload' };
}

// 解析一份清单。同一份清单内同一路径出现多个条目即冲突，绝不以后出现的覆盖先出现的。
// 字面不同但归一化后同名的条目放行到 evaluateBag，作为编码等价冲突单独上报。
export function parseManifest(text, { fileName, algorithm, kind }) {
  if (!KNOWN_ALGORITHMS.has(algorithm)) fail('unknownAlgorithm', `不支持的摘要算法：${algorithm}`, { fileName });
  const entries = [];
  const seen = new Map();
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') return;
    const match = /^(\S+)[ \t]+(.+)$/.exec(line);
    if (!match) fail('malformedLine', `清单第 ${index + 1} 行格式无效`, { fileName, line: index + 1 });
    const [, digestRaw, rawPath] = match;
    const digest = digestRaw.toLowerCase();
    if (!/^[0-9a-f]+$/.test(digest) || digest.length !== HEX_LENGTH[algorithm]) {
      fail('badDigest', `摘要必须是 ${algorithm} 对应的十六进制摘要`, { fileName, line: index + 1 });
    }
    const path = decodeBagPath(rawPath);
    validateBagPath(path);
    if (kind === 'payload' && !path.startsWith('data/')) {
      fail('payloadOutsideData', 'payload 清单条目必须位于 data/ 之下', { fileName, path });
    }
    if (kind === 'tag' && (path.startsWith('data/') || /^tagmanifest-[a-z0-9]+\.txt$/.test(path))) {
      fail('badTagEntry', 'tagmanifest 只能覆盖非 payload、非 tagmanifest 的标签文件', { fileName, path });
    }
    if (seen.has(path) && seen.get(path) !== digest) {
      fail('duplicateEntry', '同一份清单中同一路径出现冲突条目，不能覆盖', { fileName, path });
    }
    seen.set(path, digest);
    entries.push({ digest, path, line: index + 1 });
  });
  return entries;
}

// 解析 fetch.txt：URL、十进制长度或 -、袋内相对路径。
export function parseFetch(text, { fileName = 'fetch.txt' } = {}) {
  const entries = [];
  const seen = new Set();
  text.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') return;
    const match = /^(\S+)[ \t]+(\d+|-)[ \t]+(.+)$/.exec(line);
    if (!match) fail('malformedLine', `fetch.txt 第 ${index + 1} 行格式无效`, { fileName, line: index + 1 });
    const [, urlText, lengthText, rawPath] = match;
    let url;
    try { url = new URL(urlText); } catch { fail('badUrl', 'fetch.txt 中的 URL 无效', { fileName, line: index + 1 }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail('badUrl', '只允许 http/https 补件地址', { fileName, url: urlText });
    }
    const path = decodeBagPath(rawPath);
    validateBagPath(path);
    if (!path.startsWith('data/')) fail('fetchOutsideData', 'fetch.txt 只能补齐 data/ 下的正文', { fileName, path });
    if (seen.has(path)) fail('duplicateEntry', 'fetch.txt 中同一路径出现多个补件地址', { fileName, path });
    seen.add(path);
    entries.push({ url: urlText, origin: url.origin, length: lengthText === '-' ? null : Number(lengthText), path });
  });
  return entries;
}

// bagit.txt 必须声明 BagIt 1.0 与 UTF-8。
export function validateBagIt(bytes) {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r\n|\r|\n/);
  const hasVersion = lines.some(line => /^BagIt-Version[ \t]*:[ \t]*1\.0[ \t]*$/.test(line));
  const hasEncoding = lines.some(line => /^Tag-File-Character-Encoding[ \t]*:[ \t]*UTF-8[ \t]*$/.test(line));
  if (!hasVersion || !hasEncoding) {
    fail('badBagIt', 'bagit.txt 未声明 BagIt-Version: 1.0 与 Tag-File-Character-Encoding: UTF-8');
  }
}

const hashOf = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

// 检测编码差异造成的同名对象：字面不同但 NFC 归一化后相同的路径必须报错，不能静默合并。
function findEncodingCollisions(groups) {
  const byNormalized = new Map();
  for (const path of groups) {
    const normalized = path.normalize('NFC');
    const earlier = byNormalized.get(normalized);
    if (earlier !== undefined && earlier.literal !== path) {
      return { normalized, paths: [earlier.literal, path] };
    }
    byNormalized.set(normalized, { literal: path });
  }
  return null;
}

function rollup(rows) {
  if (rows.some(row => row.state === 'mismatch')) return 'failed';
  if (rows.some(row => row.state === 'missing')) return 'incomplete';
  return 'ready';
}

// 汇总整袋验收结论。payload 清单与 tagmanifest 分别出报告，互不替代；
// 同一正文在多个算法清单中的结果按 (算法, 路径) 独立保留，冲突显式上报。
export async function evaluateBag({ payloadManifests, tagManifests, fetchEntries, presentTagFiles, presentPaths = new Set(), read }) {
  const structural = [];
  const pushStructural = (code, message, extra = {}) => structural.push({ code, message, ...extra });

  if (payloadManifests.size === 0) pushStructural('missingPayloadManifest', '袋内没有 payload manifest');
  if (tagManifests.size === 0) pushStructural('missingTagManifest', '袋内没有 tagmanifest');

  const allPaths = [...new Set([
    ...[...payloadManifests.values()].flat().map(entry => entry.path),
    ...fetchEntries.map(entry => entry.path),
    ...[...tagManifests.values()].flat().map(entry => entry.path),
  ])];
  const collision = findEncodingCollisions(allPaths);
  if (collision) {
    pushStructural('encodingCollision', '存在编码差异导致的同名对象，不能静默合并', collision);
  }

  const fetchByPath = new Map(fetchEntries.map(entry => [entry.path, entry]));
  for (const entry of fetchEntries) {
    const listed = [...payloadManifests.values()].some(rows => rows.some(row => row.path === entry.path));
    if (!listed) pushStructural('fetchNotInManifest', 'fetch.txt 条目没有出现在任何 payload 清单中', { path: entry.path });
  }

  // payload 验收：按算法分别保留每个条目的结论。
  const payload = {};
  for (const [algorithm, entries] of payloadManifests) {
    payload[algorithm] = [];
    for (const entry of entries) {
      const row = { path: entry.path, expectedDigest: entry.digest, state: 'missing', fetchable: fetchByPath.has(entry.path) };
      const bytes = await read(entry.path);
      if (bytes) {
        const actualDigest = hashOf(algorithm, bytes);
        row.actualDigest = actualDigest;
        row.state = actualDigest === entry.digest ? 'ok' : 'mismatch';
      }
      payload[algorithm].push(row);
    }
  }

  // fetch.txt 列出的正文若已在袋目录，必须与所有 payload 清单吻合才算“已补齐”；
  // 若字节与任一清单不符，则来源同时内联了一个错误正文，属于结构冲突而非普通缺件。
  for (const entry of fetchEntries) {
    if (!presentPaths.has(entry.path)) continue;
    const rowsForPath = Object.values(payload).flat().filter(row => row.path === entry.path);
    if (rowsForPath.length === 0) continue; // fetchNotInManifest 已记录
    if (rowsForPath.some(row => row.state !== 'ok')) {
      pushStructural('fetchAndInlineConflict', 'fetch.txt 列出的正文已内联在袋目录，但与 payload 清单不符', { path: entry.path });
    }
  }

  // 同一正文出现在多个算法清单时，任一算法不通过即整袋不通过，并记录跨清单冲突。
  const pathAlgorithms = new Map();
  for (const [algorithm, rows] of Object.entries(payload)) {
    for (const row of rows) {
      if (!pathAlgorithms.has(row.path)) pathAlgorithms.set(row.path, []);
      pathAlgorithms.get(row.path).push({ algorithm, state: row.state });
    }
  }
  for (const [path, rows] of pathAlgorithms) {
    const states = new Set(rows.map(row => row.state));
    if (states.has('mismatch') && (states.has('ok') || states.has('missing'))) {
      pushStructural('manifestConflict', '同一正文在不同算法清单中的结论冲突，不能以任一清单代替整袋', {
        path, algorithms: rows,
      });
    }
  }

  // tag 验收：每份 tagmanifest 独立证明标签文件，缺失或不符都是标签证明失败。
  const tag = { manifests: {}, uncovered: [] };
  const coveredTagFiles = new Set();
  for (const [algorithm, entries] of tagManifests) {
    tag.manifests[algorithm] = [];
    for (const entry of entries) {
      coveredTagFiles.add(entry.path);
      const row = { path: entry.path, expectedDigest: entry.digest, state: 'missing' };
      const bytes = await read(entry.path);
      if (bytes) {
        const actualDigest = hashOf(algorithm, bytes);
        row.actualDigest = actualDigest;
        row.state = actualDigest === entry.digest ? 'ok' : 'mismatch';
      }
      tag.manifests[algorithm].push(row);
    }
  }
  for (const name of presentTagFiles) tag.uncovered.push(name);
  tag.uncovered = tag.uncovered.filter(name => !coveredTagFiles.has(name));
  if (tag.uncovered.length > 0) {
    pushStructural('uncoveredTagFile', '存在未被任何 tagmanifest 覆盖的标签文件', { paths: tag.uncovered });
  }

  const payloadRows = Object.values(payload).flat();
  const tagRows = Object.values(tag.manifests).flat();
  const payloadStatus = rollup(payloadRows);
  const tagStatus = rollup(tagRows);

  let status;
  if (structural.length > 0 || payloadStatus === 'failed' || tagStatus === 'failed') {
    status = 'failed';
  } else if (payloadStatus === 'incomplete' || tagStatus === 'incomplete') {
    status = 'incomplete';
  } else {
    status = 'ready';
  }
  const summary = {
    incomplete: '缺件：仍有正文或标签文件未补齐，尚不具备交接条件',
    failed: '内容校验失败：清单与实物不符或结构不合规，不能交接',
    ready: '具备交接条件：payload 与标签证明分别验收通过',
  }[status];

  return { status, summary, structural, payload, tag, fetch: [...fetchByPath.keys()] };
}
