import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRuntimeDirectory, writableWorkspacePath, existingWorkspacePath, workspacePath } from './recorder-config.mjs';

/** Never import, copy, or adopt a user's existing browser profile. */
export async function prepareHeadlessProfile(config, root) {
  if (config.browserBackend !== 'headless') return null;
  const full = await writableWorkspacePath(root, config.browserProfileDir);
  const relative = path.relative(workspacePath(root, 'data/browser-profiles'), full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('独立 profile 不在专属目录内');
  const profileDir = await prepareRuntimeDirectory(root, full), marker = path.join(profileDir, '.recorder-profile.json');
  const expected = { schemaVersion: 1, kind: 'textbook-recorder-owned-profile', bookId: config.bookId, ...(config.readOnly===true?{readOnly:true}:{}) };
  let owner;
  try { owner = JSON.parse(await fs.readFile(await existingWorkspacePath(root, marker), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('独立 profile 身份文件无效，保留目录');
    if ((await fs.readdir(profileDir)).length) throw new Error('现有 profile 未由录入器登记，拒绝采用或复制');
    try { await writableWorkspacePath(root, marker); await fs.writeFile(marker, JSON.stringify(expected), { flag: 'wx' }); owner = expected; }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; owner = JSON.parse(await fs.readFile(await existingWorkspacePath(root, marker), 'utf8')); }
  }
  if (owner.schemaVersion !== 1 || owner.kind !== expected.kind || owner.bookId !== config.bookId
      || (owner.readOnly??false)!==(config.readOnly??false) || Object.keys(owner).some(key=>!['schemaVersion','kind','bookId','readOnly'].includes(key))) throw new Error('独立 profile 属于其他书籍、readOnly 模式或身份无法确认');
  return profileDir;
}
