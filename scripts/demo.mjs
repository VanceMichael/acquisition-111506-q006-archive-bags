
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory });
try {
  console.log(`${product}：人工收件与薄袋补件验收演示`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());

  // 一、既有人工收件流程保持不变。
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate }));
  }

  // 二、登记薄袋：目录和清单齐全、远程正文未到。
  const register = await fetch(`${application.url}/api/bags`, {
    method: 'POST',
    body: JSON.stringify({ sourceBaseUrl: source.url }),
  });
  const { bagId, report: initial } = await register.json();
  if (!register.ok) throw new Error('登记失败');
  console.log('\n薄袋登记', JSON.stringify({ bagId, status: initial.status }));
  console.log('验收结论：', initial.summary);
  const missing = initial.payload.md5.find(row => row.state === 'missing');
  console.log('缺件正文：', JSON.stringify(missing));
  console.log('tagmanifest 独立验收：', Object.fromEntries(
    Object.entries(initial.tag.manifests).map(([algo, rows]) => [algo, rows.every(row => row.state === 'ok') ? '通过' : '失败'])));

  // 三、第一次补件：来源首次返回 503，失败记录在案，状态仍是缺件。
  const first = await (await fetch(`${application.url}/api/bags/${bagId}/complete`, {
    method: 'POST', body: JSON.stringify({ reason: 'demo-first-try' }),
  })).json();
  console.log('\n第一次补件：', JSON.stringify({ status: first.status, outcome: first.attempts[0].outcome, error: first.attempts[0].error }));

  // 四、重试补件：校验通过后提升进袋目录，整袋具备交接条件。
  const second = await (await fetch(`${application.url}/api/bags/${bagId}/complete`, {
    method: 'POST', body: JSON.stringify({ reason: 'demo-retry' }),
  })).json();
  console.log('重试补件：', JSON.stringify({ status: second.status, outcome: second.attempts[0].outcome, bytes: second.attempts[0].bytes }));
  console.log('验收结论：', second.summary);

  // 五、历次报告与当时依据的清单摘要都可复核。
  const reports = await (await fetch(`${application.url}/api/bags/${bagId}/reports`)).json();
  console.log('\n验收报告份数：', reports.length);
  for (const report of reports) {
    console.log('  #' + report.sequence, report.reason, '=>', report.status,
      '| manifest-md5 依据', report.basis.payloadManifests['manifest-md5.txt'].slice(0, 12) + '…');
  }
  const delivered = await fetch(`${application.url}/api/bags/${bagId}/file/data/images/map.bin`);
  console.log('\n补齐正文回查：', delivered.status, (await delivered.text()));
  console.log('合作来源袋目录仍无该正文：', (await fetch(`${source.url}/bags/demo/data/images/map.bin`)).status === 404 ? '是（未回填原件）' : '否');
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
