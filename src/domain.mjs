export const product = "馆际档案交接柜";
export const requiredFields = ["bagId", "payloads", "verification"];
export const businessKey = "bagId";
export const autoKind = 'bagit-rfc8493';
export const statusLabels = { incomplete: '缺件', failed: '内容校验失败', complete: '具备交接条件' };

export function validateRecord(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('收件内容必须是对象');
  for (const field of requiredFields) if (!(field in input) || input[field] === null) fail(`缺少业务字段：${field}`);
  if (typeof input[businessKey] !== 'string' || !input[businessKey].trim() || input[businessKey].length > 512) fail('业务标识无效');
  const record = structuredClone(input);
  return { key: record[businessKey], record };
}
