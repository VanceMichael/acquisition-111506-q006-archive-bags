
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { openBagStore } from './bagstore.mjs';
import { validateRecord, product } from './domain.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {}; // 可选请求体：空 body 视为空对象
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1', allowedOrigins = [] }) {
  const store = await openStore(directory);
  const bagStore = await openBagStore(directory, {
    maxFetchBytes: Number(process.env.MAX_FETCH_BYTES ?? 256 * 1024 * 1024),
  });
  const extraOrigins = [...allowedOrigins, ...(process.env.ALLOWED_FETCH_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)];
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
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      // 薄袋登记：从合作来源领取袋目录（不含 fetch.txt 指向的远程正文）。
      if (request.method === 'POST' && url.pathname === '/api/bags') {
        const input = await readJson(request);
        const result = await bagStore.registerBag({
          sourceBaseUrl: input.sourceBaseUrl,
          bagPath: input.bagPath,
          bagId: input.bagId,
          allowedOrigins: extraOrigins,
        });
        return sendJson(response, 201, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/bags') return sendJson(response, 200, await bagStore.listBags());
      const bagRoute = /^\/api\/bags\/([a-z0-9][a-z0-9-]{0,63})(?:\/(.+))?$/.exec(url.pathname);
      if (bagRoute) {
        const [, bagId, suffix] = bagRoute;
        if (request.method === 'GET' && !suffix) return sendJson(response, 200, await bagStore.getBag(bagId));
        if (request.method === 'POST' && suffix === 'complete') {
          const body = await readJson(request, 64 * 1024);
          const report = await bagStore.completeBag(bagId, { reason: body?.reason });
          return sendJson(response, 200, report);
        }
        if (request.method === 'GET' && suffix === 'reports') {
          return sendJson(response, 200, await bagStore.bagReports(bagId));
        }
        if (request.method === 'GET' && suffix?.startsWith('file/')) {
          let path;
          try { path = decodeURIComponent(suffix.slice('file/'.length)); }
          catch { return sendJson(response, 400, { error: '袋内路径编码无效' }); }
          const { bytes, mediaType } = await bagStore.bagFile(bagId, path);
          response.writeHead(200, { 'content-type': mediaType });
          return response.end(bytes);
        }
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
  return { store, bagStore, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
