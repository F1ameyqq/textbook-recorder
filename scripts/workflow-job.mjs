import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparationArgumentPath } from '../src/preparation-files.mjs';
import { initializeWorkflowJob, workflowJobStatus, nextWorkflowArtifact, registerWorkflowArtifact, WORKFLOW_ROLES } from '../src/workflow-job.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `本地任务登记：不会连接平台或产生执行许可。
node scripts/workflow-job.mjs --action=init --job=data/jobs/<job> --plan=data/jobs/<job>/plan.json
node scripts/workflow-job.mjs --action=status --job=data/jobs/<job>
node scripts/workflow-job.mjs --action=next --job=data/jobs/<job> --role=draft
node scripts/workflow-job.mjs --action=register --job=data/jobs/<job> --role=draft --file=data/jobs/<job>/draft.v0001.json --sha256=<实际文件SHA256>
role: ${WORKFLOW_ROLES.join(', ')}
init 和 register 用 wx 写不可变新快照，status 和 next 只读。next 不占用输出路径。
plan: {"schemaVersion":1,"kind":"local-workflow-plan","bookId":900001,"source":"fixture","scope":{"pages":[1,2],"sections":[{"chapterLabel":"示例章","sectionLabel":"示例节","startRecord":1,"recordLimit":20}]}}
生产 plan 可保留实际 authorizationEvidence:{userQuote,evidenceReference}；本地记录不会授予追加或缺答许可。`;

export async function workflowJob(argv, { root = defaultRoot, cwd = process.cwd() } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const match = /^--(action|job|plan|role|file|sha256)(?:=(.*))?$/u.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) throw new Error(`未知或重复参数：${argument}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    options[match[1]] = value;
  }
  if (options.help) return { help };
  const fields = { init: ['action', 'job', 'plan'], status: ['action', 'job'], next: ['action', 'job', 'role'], register: ['action', 'job', 'role', 'file', 'sha256'] }[options.action];
  if (!fields || fields.some(field => !options[field]) || Object.keys(options).some(field => !fields.includes(field))) throw new Error('参数不完整或与 action 冲突；用 --help 查看本地接口');
  const job = await preparationArgumentPath(cwd, options.job);
  if (options.action === 'init') return initializeWorkflowJob(root, job, await preparationArgumentPath(cwd, options.plan));
  if (options.action === 'status') return workflowJobStatus(root, job);
  if (options.action === 'next') return nextWorkflowArtifact(root, job, options.role);
  return registerWorkflowArtifact(root, job, { role: options.role, file: await preparationArgumentPath(cwd, options.file), expectedSha256: options.sha256 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await workflowJob(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); process.exitCode = result.blockers?.length ? 1 : 0; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
