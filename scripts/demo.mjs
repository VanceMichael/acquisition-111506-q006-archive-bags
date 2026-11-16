
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product, statusLabels } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory });
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }
  console.log('当前收件', await (await fetch(`${application.url}/api/records`)).text());

  console.log('自动交接：薄袋补件与验收');
  for (const label of ['首次补件', '同来源再次补件']) {
    const response = await fetch(`${application.url}/api/collect`, { method: 'POST', body: JSON.stringify({ source: source.url }) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({
      status: response.status,
      key: receipt.key,
      duplicate: receipt.duplicate,
      验收: statusLabels[receipt.record.verification.status],
      payload: receipt.record.verification.payload.status,
      tag: receipt.record.verification.tag.status,
      补件: receipt.record.automation.fetch,
    }));
  }
  const status = await (await fetch(`${application.url}/api/bags/status?key=loan-17`)).json();
  console.log('当前交接状态', JSON.stringify({ 状态: status.statusLabel, 依据清单: status.manifests.map(item => item.path) }));
  const delivered = await (await fetch(`${application.url}/api/bags/files?key=loan-17`)).json();
  console.log('已交付文件', JSON.stringify(delivered.files));
  const fetched = await fetch(`${application.url}/api/bags/files?key=loan-17&path=${encodeURIComponent('data/images/map.bin')}`);
  const fetchedBody = Buffer.from(await fetched.arrayBuffer());
  console.log('正文回查', JSON.stringify({ path: 'data/images/map.bin', size: fetchedBody.length, sha256: createHash('sha256').update(fetchedBody).digest('hex') }));
  const manifestRef = status.manifests.find(item => item.path === 'manifest-md5.txt');
  const manifestText = await (await fetch(`${application.url}/api/evidence/${manifestRef.sha256}`)).text();
  console.log('当时依据的清单可复核', JSON.stringify(manifestText.split('\n').filter(Boolean)));
  console.log('说明：缺件、内容校验失败等异常状态由自动化测试覆盖（npm test）。');
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
