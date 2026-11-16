
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { openStore, digest } from './store.mjs';
import { validateRecord, product, autoKind, statusLabels } from './domain.mjs';
import { collectBag } from './collector.mjs';
import { validateBagPath } from './bagit.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function listDelivered(directory, prefix = '') {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listDelivered(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1' }) {
  const store = await openStore(directory);
  const bagsDir = join(directory, 'bags');
  const stagingDir = join(directory, 'staging');
  const allowedOrigins = (process.env.FETCH_ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const defaultSource = process.env.SOURCE_URL ?? 'http://127.0.0.1:4311';
  let queue = Promise.resolve();
  const runCollect = input => {
    const run = queue.then(() => collectBag({
      source: input.source ?? defaultSource,
      bagPath: input.bagPath ?? '/bags/demo',
      bagsDir,
      stagingDir,
      allowedOrigins,
    }));
    queue = run.catch(() => {});
    return run;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'POST' && url.pathname === '/api/collect') {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw Object.assign(new Error('请求必须是对象'), { status: 400 });
        }
        if (input.source !== undefined && typeof input.source !== 'string') {
          throw Object.assign(new Error('source 必须是字符串'), { status: 400 });
        }
        if (input.bagPath !== undefined && (typeof input.bagPath !== 'string'
          || !input.bagPath.startsWith('/') || input.bagPath.split('/').some(segment => segment === '..'))) {
          throw Object.assign(new Error('bagPath 无效'), { status: 400 });
        }
        const result = await runCollect(input);
        const { key, record } = validateRecord(result.record);
        const receipt = await store.accept(key, record, result.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, {
          ...receipt,
          report: { ...result.report, statusLabel: statusLabels[result.report.status] },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname === '/api/bags/status') {
        const key = url.searchParams.get('key') ?? '';
        const latest = store.history(key).filter(item => item.record?.automation?.kind === autoKind).at(-1);
        if (!latest) return sendJson(response, 404, { error: '该标识没有自动交接记录' });
        const { verification, automation } = latest.record;
        return sendJson(response, 200, {
          key,
          sequence: latest.sequence,
          receivedAt: latest.receivedAt,
          status: verification.status,
          statusLabel: statusLabels[verification.status],
          problems: verification.problems,
          payload: verification.payload,
          tag: verification.tag,
          manifests: automation.manifests,
          evidence: latest.evidence,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/bags/files') {
        const key = url.searchParams.get('key') ?? '';
        const path = url.searchParams.get('path');
        const bagDir = join(bagsDir, digest(key));
        if (!path) return sendJson(response, 200, { key, files: await listDelivered(bagDir) });
        let safe;
        try {
          safe = validateBagPath(path);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
        const target = resolve(bagDir, ...safe.split('/'));
        if (!target.startsWith(resolve(bagDir) + sep)) return sendJson(response, 400, { error: '路径越界' });
        try {
          const bytes = await readFile(target);
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          return response.end(bytes);
        } catch (error) {
          if (error.code === 'ENOENT') return sendJson(response, 404, { error: '交付内容缺少该文件' });
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      sendJson(response, status, { error: status === 500 ? '收件服务内部错误' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
