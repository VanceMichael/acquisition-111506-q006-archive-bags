import { TextDecoder } from 'node:util';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const invalid = message => Object.assign(new Error(message), { code: 'invalid_path', status: 422 });

// 按交接格式解释袋内相对路径：只允许一次百分号解码（规范只转义 LF、CR、CRLF 和 %），
// 不对普通斜线套用 URL 解码，也不反复解码；解码结果必须是安全的 UTF-8 相对路径。
export function decodeBagPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw invalid('袋内路径为空');
  const bytes = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '%') {
      const hex = raw.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw invalid(`袋内路径转义不完整：${raw}`);
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte);
    }
  }
  let path;
  try {
    path = utf8Strict.decode(Uint8Array.from(bytes));
  } catch {
    throw invalid(`袋内路径不是有效UTF-8：${raw}`);
  }
  return validateBagPath(path);
}

// 校验已解码的袋相对路径，拒绝任何可能写出袋目录或无法安全落盘的形式。
export function validateBagPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw invalid('袋内路径为空');
  if (path.length > 1024) throw invalid(`袋内路径过长：${path.slice(0, 64)}…`);
  if (path.startsWith('/')) throw invalid(`袋内路径不能是绝对路径：${path}`);
  if (/^[A-Za-z]:/.test(path)) throw invalid(`袋内路径不能带盘符：${path}`);
  if (path.includes('\\')) throw invalid(`袋内路径不能使用反斜线：${path}`);
  for (const char of path) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw invalid(`袋内路径包含控制字符：${path}`);
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) throw invalid(`袋内路径包含空分段：${path}`);
    if (segment === '.' || segment === '..') throw invalid(`袋内路径包含相对分段：${path}`);
  }
  return path;
}

// fetch.txt 每行依次为下载URL、十进制字节长度或 -、袋内相对路径（路径可含空格，只解码一次）。
export function parseFetchTxt(text) {
  const entries = [];
  const problems = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const match = /^(\S+)[ \t]+(\S+)[ \t]+(.*)$/.exec(line);
    if (!match || match[3].length === 0) {
      problems.push({ line: index + 1, reason: 'fetch_line_malformed' });
      return;
    }
    const [, url, lengthField, rawPath] = match;
    let length = null;
    if (lengthField !== '-') {
      if (!/^\d+$/.test(lengthField) || Number(lengthField) > Number.MAX_SAFE_INTEGER) {
        problems.push({ line: index + 1, reason: 'fetch_length_invalid' });
        return;
      }
      length = Number(lengthField);
    }
    let path;
    try {
      path = decodeBagPath(rawPath);
    } catch (error) {
      problems.push({ line: index + 1, reason: 'invalid_path', detail: error.message });
      return;
    }
    entries.push({ url, length, path, line: index + 1 });
  });
  return { entries, problems };
}

// payload manifest 与 tagmanifest 每行为 摘要+空白+路径（容许 * 前缀）。
// 同一路径摘要冲突时保留先读到的值，同时记录冲突，绝不让后读的行静默覆盖。
export function parseManifest(text, source) {
  const entries = new Map();
  const conflicts = [];
  const problems = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const match = /^([0-9A-Fa-f]+)[ \t]+\*?(.*)$/.exec(line);
    if (!match || match[2].length === 0) {
      problems.push({ manifest: source, line: index + 1, reason: 'manifest_line_malformed' });
      return;
    }
    const digest = match[1].toLowerCase();
    let path;
    try {
      path = decodeBagPath(match[2]);
    } catch (error) {
      problems.push({ manifest: source, line: index + 1, reason: 'invalid_path', detail: error.message });
      return;
    }
    if (entries.has(path)) {
      if (entries.get(path) !== digest) {
        conflicts.push({ manifest: source, path, reason: 'manifest_digest_conflict', kept: entries.get(path), rejected: digest });
      }
      return;
    }
    entries.set(path, digest);
  });
  return { entries, conflicts, problems };
}

// bagit.txt 与 bag-info.txt 的 标签: 值 解析（支持续行）。
export function parseBagInfo(text) {
  const labels = new Map();
  let current = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(line) && current !== null) {
      labels.set(current, `${labels.get(current)} ${line.trim()}`);
      continue;
    }
    const match = /^([^:\s][^:]*):[ \t]?(.*)$/.exec(line);
    if (match) {
      current = match[1];
      labels.set(current, match[2]);
    }
  }
  return labels;
}

// 检测编码等价（Unicode NFC 相同但字节不同）的同名对象，只检测不合并。
export function findEncodingCollisions(paths) {
  const groups = new Map();
  for (const path of paths) {
    const key = path.normalize('NFC');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }
  const collisions = [];
  for (const group of groups.values()) {
    const unique = [...new Set(group)];
    if (unique.length > 1) collisions.push(unique.sort());
  }
  return collisions;
}

export const isPayloadPath = path => path.startsWith('data/');

export function manifestKind(name) {
  const payload = /^manifest-([A-Za-z0-9]+)\.txt$/.exec(name);
  if (payload) return { kind: 'payload', algorithm: payload[1].toLowerCase() };
  const tag = /^tagmanifest-([A-Za-z0-9]+)\.txt$/.exec(name);
  if (tag) return { kind: 'tag', algorithm: tag[1].toLowerCase() };
  return null;
}

export function strictText(bytes) {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    throw invalid('文件不是有效UTF-8');
  }
}
