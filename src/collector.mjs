import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { digest } from './store.mjs';
import { autoKind } from './domain.mjs';
import {
  validateBagPath,
  parseFetchTxt,
  parseManifest,
  parseBagInfo,
  strictText,
  findEncodingCollisions,
  isPayloadPath,
  manifestKind,
} from './bagit.mjs';

const TAG_FILE_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, status) => Object.assign(new Error(message), { status });
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function getListing(bagBase, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(bagBase, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw failure('来源不可达', 502);
  }
  if (response.status !== 200) throw failure(`来源目录不可用（HTTP ${response.status}）`, 502);
  let listing;
  try {
    listing = await response.json();
  } catch {
    throw failure('来源目录不是有效JSON', 502);
  }
  if (!listing || typeof listing !== 'object' || typeof listing.version !== 'string'
      || !Array.isArray(listing.files) || !listing.files.every(name => typeof name === 'string')) {
    throw failure('来源目录格式不符', 502);
  }
  return listing;
}

async function downloadSmall(url, maxBytes, { maxAttempts, retryDelayMs, fetchImpl }) {
  let lastReason = 'network_error';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      lastReason = 'network_error';
    }
    if (response) {
      if (response.status >= 500 || response.status === 429) {
        lastReason = `http_${response.status}`;
        await response.arrayBuffer().catch(() => {});
      } else if (response.status !== 200) {
        return { ok: false, reason: `http_${response.status}`, attempts: attempt };
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) return { ok: false, reason: 'too_large', attempts: attempt };
        return { ok: true, bytes, attempts: attempt };
      }
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
  }
  return { ok: false, reason: lastReason, attempts: maxAttempts };
}

// 流式写入暂存文件并同时计算所需算法摘要；残缺的临时文件只留在暂存区并随即删除。
async function downloadStream(url, dest, algorithms, maxBytes, { maxAttempts, retryDelayMs, fetchImpl }) {
  await mkdir(dirname(dest), { recursive: true });
  let lastReason = 'network_error';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      lastReason = 'network_error';
    }
    if (response) {
      if (response.status >= 500 || response.status === 429) {
        lastReason = `http_${response.status}`;
        await response.arrayBuffer().catch(() => {});
      } else if (response.status !== 200) {
        return { ok: false, reason: `http_${response.status}`, attempts: attempt };
      } else {
        const declared = Number(response.headers.get('content-length') ?? Number.NaN);
        if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large', attempts: attempt };
        const hashes = [...new Set(algorithms)].map(algorithm => [algorithm, createHash(algorithm)]);
        let size = 0;
        let overflow = false;
        const tap = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes) {
              overflow = true;
              callback(new Error('payload_too_large'));
              return;
            }
            for (const [, hash] of hashes) hash.update(chunk);
            callback(null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(dest));
          return { ok: true, size, digests: Object.fromEntries(hashes.map(([algorithm, hash]) => [algorithm, hash.digest('hex')])), attempts: attempt };
        } catch {
          await rm(dest, { force: true });
          if (overflow) return { ok: false, reason: 'too_large', attempts: attempt };
          lastReason = 'stream_error';
        }
      }
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
  }
  return { ok: false, reason: lastReason, attempts: maxAttempts };
}

// fetch.txt 的下载地址必须来自获准来源域，且只允许 http/https，不跟随重定向。
function approvedFetchUrl(urlString, approved) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme_not_allowed';
  if (!approved.has(url.origin)) return 'origin_not_approved';
  return null;
}

export async function collectBag({
  source,
  bagPath = '/bags/demo',
  bagsDir,
  stagingDir,
  allowedOrigins = [],
  maxAttempts = 3,
  retryDelayMs = 25,
  maxPayloadBytes = 2 ** 31,
  fetchImpl = globalThis.fetch,
}) {
  let sourceUrl;
  try {
    sourceUrl = new URL(source);
  } catch {
    throw failure('来源地址无效', 400);
  }
  if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') throw failure('来源地址协议不受支持', 400);
  if (sourceUrl.pathname !== '/' || sourceUrl.search || sourceUrl.hash) throw failure('来源地址只能是协议、主机和端口', 400);
  const approved = new Set([sourceUrl.origin, ...allowedOrigins]);
  const bagBase = `${sourceUrl.origin}${bagPath}`;
  const staging = join(stagingDir, randomUUID());
  const staged = (...parts) => join(staging, ...parts);
  await mkdir(staging, { recursive: true });
  const report = { source: sourceUrl.origin, bagPath, fetches: [], delivered: [] };
  const attemptOptions = { maxAttempts, retryDelayMs, fetchImpl };
  try {
    const listing = await getListing(bagBase, fetchImpl);
    const seen = new Set();
    const listed = [];
    const invalidListed = [];
    for (const name of listing.files) {
      try {
        validateBagPath(name);
      } catch {
        invalidListed.push(name);
        continue;
      }
      if (seen.has(name)) {
        invalidListed.push(`${name}（重复）`);
        continue;
      }
      seen.add(name);
      listed.push(name);
    }
    if (invalidListed.length) throw failure(`来源目录清单包含无效文件名：${invalidListed.join(', ')}`, 502);

    // 先取标签文件（小，入内存并落暂存），再解析清单，最后流式取 payload。
    const tagNames = listed.filter(path => !isPayloadPath(path));
    const payloadNames = listed.filter(isPayloadPath);
    const tagBytes = new Map();
    for (const path of [...tagNames].sort()) {
      const result = await downloadSmall(`${bagBase}/${encodePath(path)}`, TAG_FILE_LIMIT, attemptOptions);
      if (!result.ok) throw failure(`来源标签文件下载失败：${path}（${result.reason}）`, 502);
      tagBytes.set(path, result.bytes);
      const dest = staged('bag', ...path.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, result.bytes);
    }

    const problems = [];
    const textOf = path => {
      try {
        return strictText(tagBytes.get(path));
      } catch {
        problems.push({ path, reason: 'invalid_utf8' });
        return null;
      }
    };
    let declaredVersion = null;
    if (!tagBytes.has('bagit.txt')) {
      problems.push({ path: 'bagit.txt', reason: 'missing_bagit_txt' });
    } else {
      const text = textOf('bagit.txt');
      if (text !== null) {
        const declaration = parseBagInfo(text);
        declaredVersion = declaration.get('BagIt-Version') ?? null;
        if (!declaredVersion || !declaredVersion.startsWith('1.')) {
          problems.push({ path: 'bagit.txt', reason: 'bagit_version_unsupported', detail: declaredVersion ?? '缺失' });
        }
        const encoding = declaration.get('Tag-File-Character-Encoding');
        if (encoding && encoding.toUpperCase() !== 'UTF-8') {
          problems.push({ path: 'bagit.txt', reason: 'tag_encoding_unsupported', detail: encoding });
        }
      }
    }

    const payloadManifests = new Map();
    const tagManifests = new Map();
    const conflictPaths = new Set();
    for (const path of [...tagBytes.keys()].sort()) {
      const kind = manifestKind(path);
      if (!kind) continue;
      try {
        createHash(kind.algorithm);
      } catch {
        problems.push({ path, reason: 'unsupported_algorithm', detail: kind.algorithm });
        continue;
      }
      const text = textOf(path);
      if (text === null) continue;
      const parsed = parseManifest(text, path);
      problems.push(...parsed.problems);
      problems.push(...parsed.conflicts);
      for (const conflict of parsed.conflicts) conflictPaths.add(conflict.path);
      (kind.kind === 'payload' ? payloadManifests : tagManifests).set(kind.algorithm, { path, entries: parsed.entries });
    }
    if (payloadManifests.size === 0) problems.push({ reason: 'missing_payload_manifest' });
    if (tagManifests.size === 0) problems.push({ reason: 'missing_tagmanifest' });

    // fetch.txt：同一路径多个条目、目录已提供的同名对象都记为冲突，不静默合并。
    const fetchByPath = new Map();
    if (tagBytes.has('fetch.txt')) {
      const text = textOf('fetch.txt');
      if (text !== null) {
        const parsed = parseFetchTxt(text);
        problems.push(...parsed.problems.map(problem => ({ path: 'fetch.txt', ...problem })));
        for (const entry of parsed.entries) {
          if (fetchByPath.has(entry.path)) {
            problems.push({ path: entry.path, reason: 'duplicate_fetch_entry' });
            continue;
          }
          fetchByPath.set(entry.path, entry);
        }
      }
    }
    for (const path of listed) {
      if (fetchByPath.has(path)) {
        problems.push({ path, reason: 'duplicate_source', detail: '目录已提供该文件，fetch.txt 又给出同名对象' });
        fetchByPath.delete(path);
      }
    }
    const allPaths = [
      ...listed,
      ...fetchByPath.keys(),
      ...[...payloadManifests.values()].flatMap(manifest => [...manifest.entries.keys()]),
      ...[...tagManifests.values()].flatMap(manifest => [...manifest.entries.keys()]),
    ];
    for (const group of findEncodingCollisions(allPaths)) {
      problems.push({ reason: 'encoding_equivalent_paths', detail: group.join(' ↔ ') });
    }

    // 每个算法独立核对，需要的摘要集合来自全部清单。
    const algorithms = [...new Set([...payloadManifests.keys(), ...tagManifests.keys(), 'sha256'])];
    const present = new Map();
    for (const path of [...tagBytes.keys()].sort()) {
      const bytes = tagBytes.get(path);
      const digests = Object.fromEntries(algorithms.map(algorithm => [algorithm, createHash(algorithm).update(bytes).digest('hex')]));
      present.set(path, { size: bytes.length, digests, origin: 'listed' });
    }
    for (const path of [...payloadNames].sort()) {
      const dest = staged('bag', ...path.split('/'));
      const result = await downloadStream(`${bagBase}/${encodePath(path)}`, dest, algorithms, maxPayloadBytes, attemptOptions);
      if (!result.ok) throw failure(`来源payload下载失败：${path}（${result.reason}）`, 502);
      present.set(path, { size: result.size, digests: result.digests, origin: 'listed' });
    }

    // 网络补件：只从获准地址下载，先落暂存，核对声明长度后再进入袋暂存区。
    const fetchOutcomes = [];
    for (const [path, entry] of [...fetchByPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const outcome = { path, url: entry.url, outcome: 'failed' };
      const rejection = approvedFetchUrl(entry.url, approved);
      if (rejection) {
        outcome.outcome = 'rejected';
        outcome.reason = rejection;
        fetchOutcomes.push(outcome);
        report.fetches.push({ ...outcome, attempts: 0 });
        continue;
      }
      if (entry.length !== null && entry.length > maxPayloadBytes) {
        outcome.reason = 'too_large';
        fetchOutcomes.push(outcome);
        report.fetches.push({ ...outcome, attempts: 0 });
        continue;
      }
      const temp = staged('fetch', ...path.split('/'));
      const result = await downloadStream(entry.url, temp, algorithms, maxPayloadBytes, attemptOptions);
      if (result.ok && entry.length !== null && result.size !== entry.length) {
        await rm(temp, { force: true });
        outcome.reason = 'length_mismatch';
        fetchOutcomes.push(outcome);
        report.fetches.push({ ...outcome, attempts: result.attempts });
        continue;
      }
      if (!result.ok) {
        outcome.reason = result.reason;
        fetchOutcomes.push(outcome);
        report.fetches.push({ ...outcome, attempts: result.attempts });
        continue;
      }
      outcome.outcome = 'fetched';
      fetchOutcomes.push(outcome);
      report.fetches.push({ ...outcome, attempts: result.attempts });
      const dest = staged('bag', ...path.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await rename(temp, dest);
      present.set(path, { size: result.size, digests: result.digests, origin: 'fetched' });
    }

    // 分项验证：payload 与 tag 各自按算法核对，任何失败不被后续清单覆盖。
    const buildSection = (manifests, coveredPaths, reasonFor) => {
      const section = { status: 'pass', algorithms: {}, missing: [], uncovered: [] };
      const seenMissing = new Set();
      for (const [algorithm, manifest] of [...manifests.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        const mismatches = [];
        const absent = [];
        for (const [path, expected] of [...manifest.entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
          const file = present.get(path);
          if (!file) {
            absent.push(path);
            continue;
          }
          if (file.digests[algorithm] !== expected) mismatches.push(path);
        }
        section.algorithms[algorithm] = {
          status: mismatches.length ? 'fail' : absent.length ? 'incomplete' : 'pass',
          entries: manifest.entries.size,
          mismatches,
          missing: absent,
        };
        for (const path of absent) {
          if (!seenMissing.has(path)) {
            seenMissing.add(path);
            section.missing.push({ path, reason: reasonFor(path) });
          }
        }
      }
      for (const path of coveredPaths) {
        const lacking = [...manifests.entries()].filter(([, manifest]) => !manifest.entries.has(path)).map(([algorithm]) => algorithm);
        if (lacking.length) section.uncovered.push({ path, algorithms: lacking });
      }
      section.missing.sort(byPath);
      section.uncovered.sort(byPath);
      if (Object.values(section.algorithms).some(result => result.status === 'fail') || section.uncovered.length) section.status = 'fail';
      else if (section.missing.length) section.status = 'incomplete';
      return section;
    };
    const payloadReason = path => {
      const outcome = fetchOutcomes.find(item => item.path === path);
      return outcome ? `fetch_${outcome.outcome}` : 'no_fetch_entry';
    };
    const presentPayloads = [...present.keys()].filter(isPayloadPath);
    const presentTags = [...present.keys()].filter(path => !isPayloadPath(path) && manifestKind(path)?.kind !== 'tag');
    const payloadSection = buildSection(payloadManifests, presentPayloads, payloadReason);
    const tagSection = buildSection(tagManifests, presentTags, () => 'not_in_bag');
    const failed = problems.length > 0 || payloadSection.status === 'fail' || tagSection.status === 'fail';
    const incomplete = payloadSection.status === 'incomplete' || tagSection.status === 'incomplete';
    const status = failed ? 'failed' : incomplete ? 'incomplete' : 'complete';

    let bagInfo = new Map();
    if (tagBytes.has('bag-info.txt')) {
      const text = textOf('bag-info.txt');
      if (text !== null) bagInfo = parseBagInfo(text);
    }
    const externalId = bagInfo.get('External-Identifier')?.trim();
    const bagId = externalId || `bag:${listing.directory ?? 'unknown'}`;

    const manifestPayloadPaths = new Set([...payloadManifests.values()].flatMap(manifest => [...manifest.entries.keys()]));
    const payloadPaths = [...new Set([...presentPayloads, ...manifestPayloadPaths])].sort();
    const payloads = payloadPaths.map(path => {
      const file = present.get(path);
      if (!file) return { path, state: 'missing' };
      return { path, state: file.origin === 'fetched' ? 'fetched' : 'present', size: file.size, sha256: file.digests.sha256 };
    });
    const manifestsUsed = [...tagBytes.keys()]
      .filter(path => manifestKind(path) || path === 'fetch.txt')
      .sort()
      .map(path => ({ path, sha256: digest(tagBytes.get(path)) }));
    const record = {
      bagId,
      payloads,
      verification: { status, problems, payload: payloadSection, tag: tagSection },
      automation: {
        kind: autoKind,
        source: sourceUrl.origin,
        bagPath,
        version: listing.version,
        declaredVersion,
        manifests: manifestsUsed,
        fetch: fetchOutcomes,
      },
    };

    // 只有通过全部适用校验的文件才从暂存区移入交付目录；交付目录与暂存目录分离。
    const excluded = new Set(conflictPaths);
    for (const section of [payloadSection, tagSection]) {
      for (const result of Object.values(section.algorithms)) for (const path of result.mismatches) excluded.add(path);
      for (const item of section.uncovered) excluded.add(item.path);
    }
    const bagDir = join(bagsDir, digest(bagId));
    await rm(bagDir, { recursive: true, force: true });
    await mkdir(bagDir, { recursive: true });
    for (const path of [...present.keys()].sort()) {
      if (excluded.has(path)) continue;
      const target = join(bagDir, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await rename(staged('bag', ...path.split('/')), target);
      report.delivered.push(path);
    }

    // 当时依据的标签文件（含各算法清单与 fetch.txt）作为原始依据保存，合作方原件不被修改。
    const evidence = [...tagBytes.keys()].sort().map(path => ({
      source: `${bagBase}/${encodePath(path)}`,
      bytesBase64: tagBytes.get(path).toString('base64'),
      mediaType: 'text/plain; charset=utf-8',
    }));
    return { key: bagId, record, evidence, report: { ...report, key: bagId, status }, bagDir };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
