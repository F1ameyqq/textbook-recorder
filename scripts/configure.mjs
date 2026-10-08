import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecorderConfig } from '../src/recorder-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (const argument of process.argv.slice(2)) {
  const match = argument.match(/^--(book-id|port)=(\d+)$/u);
  if (!match || options[match[1]] !== undefined) throw new Error('使用 npm run configure -- --book-id=你的书号 [--port=8789]');
  options[match[1]] = Number(match[2]);
}
if (!options['book-id']) throw new Error('必须显式指定 --book-id；示例书号不能当成自己的任务。');
const config = validateRecorderConfig({ schemaVersion: 1, bookId: options['book-id'], port: options.port ?? 8789, origin: 'https://easylearn.baidu.com' });
const filename = path.join(root, 'config', 'recorder.json');
await fs.mkdir(path.dirname(filename), { recursive: true });
try {
  await fs.writeFile(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  console.log(`已生成本地配置：书 ${config.bookId}，端口 ${config.port}；尚未连接网页。`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw new Error('本地配置已存在。先关闭执行器并保留原进度，再手动修改配置；此命令不会覆盖。');
}
