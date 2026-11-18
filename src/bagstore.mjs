// 薄袋收件柜：登记、补件（fetch.txt）与验收报告。
// 合作方原件目录只读；下载先落独立暂存区，校验通过后才提升进袋目录；
// 每次验收都把当时依据的清单摘要写进报告，补件重试可复核而不改动原件。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, readdir, rename, access, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve, relative, dirname, sep } from 'node:path';
import {
  KNOWN_ALGORITHMS, manifestKind, parseManifest, parseFetch, validateBagPath, validateBagIt, evaluateBag,
} from './bagit.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const BAG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 把已验证的袋相对段拼成根目录内的绝对路径，任何越界都会被拒绝。
function inside(root, segments) {
  const target = resolve(root, ...segments);
  const relation = relative(root, target);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw httpError(400, '路径超出袋目录范围');
  }
  return target;
}

async function listFilesRecursive(directory) {
  const output = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else output.push(target);
    }
  }
  try { await walk(directory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

export async function openBagStore(directory, options = {}) {
  const root = resolve(directory);
  const bagsRoot = join(root, 'bags');
  const blobsRoot = join(root, 'blobs');
  await mkdir(bagsRoot, { recursive: true });
  await mkdir(blobsRoot, { recursive: true });
  const maxFetchBytes = options.maxFetchBytes ?? 256 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;

  const journals = new Map();
  async function loadJournal(bagId) {
    if (journals.has(bagId)) return journals.get(bagId);
    const file = join(bagsRoot, bagId, 'bag-journal.jsonl');
    let events = [];
    try {
      events = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    journals.set(bagId, events);
    return events;
  }
  async function appendEvent(bagId, event) {
    const events = await loadJournal(bagId);
    await appendFile(join(bagsRoot, bagId, 'bag-journal.jsonl'), JSON.stringify(event) + '\n');
    events.push(event);
  }

  // 内容寻址的原始字节库：清单、fetch.txt 等依据都可回查。
  async function storeBlob(bytes) {
    const sha256 = digest(bytes);
    try {
      await writeFile(join(blobsRoot, sha256), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return sha256;
  }

  async function httpGet(url) {
    // 不跟随重定向，避免获准地址把下载引到未授权来源。
    const response = await fetchImpl(url, { redirect: 'manual' });
    if (response.type === 'opaqueredirect' || Math.floor(response.status / 100) !== 2) {
      throw Object.assign(new Error(`来源返回 ${response.status}`), { statusCode: response.status });
    }
    return response;
  }

  // 流式下载到独立暂存文件，同时按所有相关算法计算摘要并限制大小。
  // 暂存文件始终留在独立 staging 目录，任何情况都不会直接写袋目录。
  async function downloadToStaging({ stagingDir, url, algorithms }) {
    const stagingName = `fetch-${randomUUID()}.part`;
    const stagingPath = join(stagingDir, stagingName);
    const hashes = Object.fromEntries(algorithms.map(algorithm => [algorithm, createHash(algorithm)]));
    let size = 0;
    let sink;
    try {
      const response = await httpGet(url);
      sink = createWriteStream(stagingPath);
      const whenDrained = () => new Promise(resolvePromise => sink.once('drain', resolvePromise));
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxFetchBytes) throw httpError(413, '补件超过允许的下载大小');
          for (const hash of Object.values(hashes)) hash.update(chunk);
          if (!sink.write(chunk)) await whenDrained();
        }
        await new Promise((resolvePromise, rejectPromise) => sink.end(resolvePromise));
      } catch (error) {
        sink.destroy();
        throw error;
      }
    } catch (error) {
      if (sink) sink.destroy?.();
      await unlink(stagingPath).catch(() => {});
      return { ok: false, stagingPath, error: error.message, size };
    }
    return {
      ok: true,
      stagingName,
      stagingPath,
      size,
      digests: Object.fromEntries(
        Object.entries(hashes).map(([algorithm, hash]) => [algorithm, hash.digest('hex')]),
      ),
    };
  }

  // 读取袋目录中一份文件；不存在返回 null。
  async function readBagFile(bagDir, path) {
    validateBagPath(path);
    const target = inside(bagDir, path.split('/'));
    try { return await readFile(target); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 基于袋目录当前字节做一次完整验收，并记录依据清单的摘要。
  async function runVerification(bagId, { reason, attempts = [] }) {
    const bagDir = join(bagsRoot, bagId, 'bag');
    const absoluteFiles = await listFilesRecursive(bagDir);
    const present = new Map(absoluteFiles.map(target => [relative(bagDir, target), target]));

    const payloadManifests = new Map();
    const tagManifests = new Map();
    const basis = { payloadManifests: {}, tagManifests: {}, fetch: null, bagit: null };
    for (const [name] of present) {
      const kind = manifestKind(name);
      if (!kind) continue;
      if (!KNOWN_ALGORITHMS.has(kind.algorithm)) {
        throw httpError(422, `不支持的清单算法：${kind.algorithm}`);
      }
      const text = (await readFile(present.get(name), 'utf8'));
      const entries = parseManifest(text, { fileName: name, ...kind });
      (kind.kind === 'payload' ? payloadManifests : tagManifests).set(kind.algorithm, entries);
      const sha256 = digest(Buffer.from(text, 'utf8'));
      if (kind.kind === 'payload') basis.payloadManifests[name] = sha256;
      else basis.tagManifests[name] = sha256;
    }
    const fetchEntries = present.has('fetch.txt')
      ? parseFetch((await readFile(present.get('fetch.txt'), 'utf8')))
      : [];
    if (present.has('fetch.txt')) basis.fetch = digest(await readFile(present.get('fetch.txt')));
    if (present.has('bagit.txt')) basis.bagit = digest(await readFile(present.get('bagit.txt')));

    const presentTagFiles = [...present.keys()].filter(name =>
      !name.startsWith('data/') && !manifestKind(name));
    const report = await evaluateBag({
      payloadManifests,
      tagManifests,
      fetchEntries,
      presentTagFiles,
      presentPaths: new Set(present.keys()),
      read: path => readBagFile(bagDir, path),
    });
    // 补件已取回但与 fetch.txt 长度声明或清单摘要不符，属于内容校验失败而非单纯缺件。
    const badFetch = attempts.filter(attempt =>
      attempt.outcome === 'digest-mismatch' || attempt.outcome === 'length-mismatch');
    if (badFetch.length > 0 && report.status !== 'failed') {
      report.status = 'failed';
      report.summary = '内容校验失败：补件字节与 fetch.txt 声明或清单摘要不符，不能交接';
      report.structural.push({
        code: 'fetchVerificationFailed',
        message: '补件内容未通过长度或摘要校验，失败字节保留在暂存区，未写入袋目录',
        paths: badFetch.map(attempt => ({ path: attempt.path, outcome: attempt.outcome })),
      });
    }
    const events = await loadJournal(bagId);
    const sequence = events.filter(event => event.type === 'report').length + 1;
    const fullReport = {
      type: 'report', bagId, sequence, reason, attempts, basis,
      ...report, createdAt: new Date().toISOString(),
    };
    await appendEvent(bagId, fullReport);
    return fullReport;
  }

  return {
    async registerBag(input = {}) {
      const { bagPath = 'bags/demo' } = input;
      if (!input.sourceBaseUrl || typeof input.sourceBaseUrl !== 'string') {
        throw httpError(422, '需要合作来源基础地址');
      }
      let source;
      try { source = new URL(input.sourceBaseUrl); } catch { throw httpError(422, '合作来源地址无效'); }
      if (source.protocol !== 'http:' && source.protocol !== 'https:') throw httpError(422, '只允许 http/https 来源');
      validateBagPath(bagPath);
      const bagId = input.bagId ?? `bag-${randomUUID().slice(0, 12)}`;
      if (!BAG_ID.test(bagId)) throw httpError(422, '袋标识只能使用小写字母、数字与连字符（最长64）');
      const bagHome = join(bagsRoot, bagId);
      try {
        await access(bagHome);
        throw httpError(409, '该袋标识已登记');
      } catch (error) {
        if (error.status) throw error;
        if (error.code !== 'ENOENT') throw error;
      }
      const bagDir = join(bagHome, 'bag');
      const stagingDir = join(bagHome, 'staging');
      await mkdir(bagDir, { recursive: true });
      await mkdir(stagingDir, { recursive: true });

      const directoryUrl = `${source.href.replace(/\/$/, '')}/${bagPath}`;
      const response = await httpGet(directoryUrl);
      const listing = await response.json();
      if (!listing || !Array.isArray(listing.files) || listing.files.length === 0) {
        throw httpError(502, '来源目录没有可领取的文件');
      }
      const allowedOrigins = [source.origin, ...(Array.isArray(input.allowedOrigins) ? input.allowedOrigins : [])];
      const files = [];
      for (const name of listing.files) {
        validateBagPath(name);
        const segments = name.split('/');
        const target = inside(bagDir, segments);
        const fileUrl = `${directoryUrl}/${segments.map(encodeURIComponent).join('/')}`;
        const fileResponse = await httpGet(fileUrl);
        const bytes = Buffer.from(await fileResponse.arrayBuffer());
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' }); // 原件只写一次，绝不覆盖
        const sha256 = await storeBlob(bytes);
        files.push({ path: name, sha256, size: bytes.length });
      }

      const bagitBytes = await readBagFile(bagDir, 'bagit.txt');
      if (!bagitBytes) throw httpError(422, '来源袋缺少 bagit.txt');
      validateBagIt(bagitBytes);

      const registration = {
        type: 'registered',
        bagId,
        source: { baseUrl: source.href, bagPath, origin: source.origin },
        allowedOrigins: [...new Set(allowedOrigins)],
        files,
        createdAt: new Date().toISOString(),
      };
      await appendEvent(bagId, registration);
      const report = await runVerification(bagId, { reason: 'registration' });
      return { bagId, registration, report };
    },

    // 按 fetch.txt 从获准地址补齐缺失正文，然后重新验收。
    async completeBag(bagId, input = {}) {
      if (!BAG_ID.test(bagId)) throw httpError(400, '袋标识无效');
      const bagHome = join(bagsRoot, bagId);
      const bagDir = join(bagHome, 'bag');
      const stagingDir = join(bagHome, 'staging');
      const events = await loadJournal(bagId);
      const registration = events.find(event => event.type === 'registered');
      if (!registration) throw httpError(404, '袋未登记');
      await mkdir(stagingDir, { recursive: true });

      const attempts = [];
      const preReport = await runVerification(bagId, { reason: 'before-fetch', attempts: [] });
      const fetchText = await readBagFile(bagDir, 'fetch.txt');
      if (!fetchText) {
        return runVerification(bagId, { reason: input.reason ?? 'recheck', attempts });
      }
      const fetchEntries = parseFetch(fetchText.toString('utf8'));
      const allowed = new Set(registration.allowedOrigins);
      for (const entry of fetchEntries) {
        if (!allowed.has(entry.origin)) {
          throw httpError(422, `补件地址未获授权：${entry.url}`);
        }
      }

      // 找出在任一算法清单中仍缺失的正文。
      const missingPaths = new Set();
      for (const rows of Object.values(preReport.payload)) {
        for (const row of rows) if (row.state === 'missing') missingPaths.add(row.path);
      }
      const algorithms = Object.keys(preReport.payload);

      for (const entry of fetchEntries) {
        if (!missingPaths.has(entry.path)) continue;
        const attempt = { path: entry.path, url: entry.url, startedAt: new Date().toISOString() };
        let downloaded;
        try {
          downloaded = await downloadToStaging({ stagingDir, url: entry.url, algorithms });
        } catch (error) {
          attempt.outcome = 'fetch-failed';
          attempt.error = error.message;
          attempts.push(attempt);
          continue;
        }
        if (!downloaded.ok) {
          attempt.outcome = 'fetch-failed';
          attempt.error = downloaded.error;
          attempts.push(attempt);
          continue;
        }
        if (entry.length !== null && downloaded.size !== entry.length) {
          const retained = join(stagingDir, `failed-${randomUUID()}.part`);
          await rename(downloaded.stagingPath, retained); // 长度不符的字节同样保留在暂存区作证
          attempt.outcome = 'length-mismatch';
          attempt.expectedLength = entry.length;
          attempt.actualLength = downloaded.size;
          attempt.staged = relative(bagHome, retained);
          attempts.push(attempt);
          continue;
        }
        // 与所有算法清单逐一比对：任一不符即为校验失败，且不能被其它清单覆盖。
        const mismatches = [];
        for (const algorithm of algorithms) {
          const expected = preReport.payload[algorithm].find(row => row.path === entry.path)?.expectedDigest;
          if (expected && downloaded.digests[algorithm] !== expected) {
            mismatches.push({ algorithm, expected, actual: downloaded.digests[algorithm] });
          }
        }
        if (mismatches.length > 0) {
          const retained = join(stagingDir, `failed-${randomUUID()}.part`);
          await rename(downloaded.stagingPath, retained); // 失败证据保留在暂存区，不进袋目录
          attempt.outcome = 'digest-mismatch';
          attempt.mismatches = mismatches;
          attempt.staged = relative(bagHome, retained);
          attempts.push(attempt);
          continue;
        }
        // 校验通过才提升进袋目录；目标已存在则拒绝，保证合作方原件不被改写。
        const target = inside(bagDir, entry.path.split('/'));
        try {
          await access(target);
          throw httpError(409, `袋内已存在同名文件，拒绝覆盖：${entry.path}`);
        } catch (error) {
          if (error.status) throw error;
          if (error.code !== 'ENOENT') throw error;
        }
        await mkdir(dirname(target), { recursive: true });
        await rename(downloaded.stagingPath, target);
        await storeBlob(await readFile(target));
        attempt.outcome = 'promoted';
        attempt.bytes = downloaded.size;
        attempts.push(attempt);
      }
      return runVerification(bagId, { reason: input.reason ?? 'fetch-retry', attempts });
    },

    async listBags() {
      const bagIds = (await readdir(bagsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
      const output = [];
      for (const bagId of bagIds) {
        const events = await loadJournal(bagId);
        const registration = events.find(event => event.type === 'registered');
        const reports = events.filter(event => event.type === 'report');
        const latest = reports.at(-1) ?? null;
        output.push({
          bagId,
          source: registration?.source ?? null,
          status: latest?.status ?? 'unknown',
          summary: latest?.summary ?? null,
          reportCount: reports.length,
          registeredAt: registration?.createdAt ?? null,
        });
      }
      return output;
    },

    async getBag(bagId) {
      if (!BAG_ID.test(bagId)) throw httpError(400, '袋标识无效');
      const events = await loadJournal(bagId);
      const registration = events.find(event => event.type === 'registered');
      if (!registration) throw httpError(404, '袋未登记');
      const reports = events.filter(event => event.type === 'report');
      return { registration, latest: reports.at(-1) ?? null, reportCount: reports.length };
    },

    async bagReports(bagId) {
      if (!BAG_ID.test(bagId)) throw httpError(400, '袋标识无效');
      const events = await loadJournal(bagId);
      if (!events.some(event => event.type === 'registered')) throw httpError(404, '袋未登记');
      return events.filter(event => event.type === 'report');
    },

    async bagFile(bagId, path) {
      if (!BAG_ID.test(bagId)) throw httpError(400, '袋标识无效');
      const events = await loadJournal(bagId);
      if (!events.some(event => event.type === 'registered')) throw httpError(404, '袋未登记');
      const bagDir = join(bagsRoot, bagId, 'bag');
      const bytes = await readBagFile(bagDir, path);
      if (!bytes) throw httpError(404, '袋内没有该文件');
      return { bytes, mediaType: path.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream' };
    },
  };
}
