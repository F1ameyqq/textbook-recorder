import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalIncidentPacket } from '../src/local-incident-packet.mjs';
import { preparationArgumentPath } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = 'node scripts/create-incident-packet.mjs --report=data/jobs/<job>/report.json [--manifest=data/jobs/<job>/manifest.json] [--progress=data/jobs/<job>/progress.json] --output=data/jobs/<job>/incident.json';

export async function createIncidentPacket(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    const match = /^--(report|manifest|progress|output)(?:=(.*))?$/u.exec(token);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('异常包参数未知或重复');
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error('异常包参数缺少明确路径');
    options[match[1]] = value;
  }
  if (options.help) return { help };
  if (!options.report || !options.output) throw new Error('异常包必须明确提供 --report 和 --output');
  const resolved = {};
  for (const key of ['report', 'manifest', 'progress', 'output']) if (options[key] !== undefined) resolved[key] = await preparationArgumentPath(cwd, options[key]);
  return createLocalIncidentPacket(project, resolved);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await createIncidentPacket(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch { console.error('本地异常包创建失败；请核对输入大小、同作业路径、身份/hash 绑定及不可覆盖输出，原文件已保留。'); process.exitCode = 1; }
}
