import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadRecorderConfig } from '../src/recorder-config.mjs';
import { resolveExtensionAuth } from '../src/extension-auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const results = [{ check: 'Node.js >= 22', passed: Number(process.versions.node.split('.')[0]) >= 22, detail: process.versions.node }];
for (const dependency of ['playwright', '@playwright/mcp', '@modelcontextprotocol/sdk']) {
  try { require.resolve(dependency); results.push({ check: dependency, passed: true }); }
  catch { results.push({ check: dependency, passed: false, detail: '请先运行 npm ci' }); }
}
try { const config = await loadRecorderConfig(root); results.push({ check: '本地书籍配置', passed: true, detail: `书 ${config.bookId}，端口 ${config.port}` }); }
catch { results.push({ check: '本地书籍配置', passed: false, detail: 'npm run configure -- --book-id=你的书号' }); }
results.push({ check: '正式录入操作系统', passed: process.platform === 'win32', detail: process.platform === 'win32' ? 'Windows' : '此系统可做本地审校及演练；原 Edge/DPAPI 入口需要 Windows' });
if (process.platform === 'win32') {
  const edge = path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const edgeAlt = path.join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const found = (await Promise.all([edge, edgeAlt].map(file => fs.access(file).then(() => true, () => false)))).some(Boolean);
  results.push({ check: 'Microsoft Edge', passed: found, detail: found ? '已找到浏览器' : '请安装 Microsoft Edge' });
  try { const auth = await resolveExtensionAuth(); results.push({ check: '本机扩展令牌', passed: auth.authConfigured, detail: auth.authConfigured ? '已配置；未输出令牌' : '运行 scripts/setup-extension-auth.ps1 安全导入本机令牌' }); }
  catch { results.push({ check: '本机扩展令牌', passed: false, detail: '无法读取当前用户的授权，请重新安全导入' }); }
}
for (const result of results) console.log(`${result.passed ? '[通过]' : '[待配置]'} ${result.check}${result.detail ? '：' + result.detail : ''}`);
console.log('本次未连接或写入网页。扩展是否启用、平台登录是否有效，由 recorder:probe 进一步核对。');
console.log(`本地工作目录可使用 data/jobs；当前用户 ${os.platform()}。`);
if (results.some(result => !result.passed)) process.exitCode = 1;
