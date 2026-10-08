import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './preparation-files.mjs';
import { prepareDraftBatch } from './draft-batch.mjs';
import { inspectReviewedBatch } from './review-preflight.mjs';

const checks = ['sourceText', 'answerMatch', 'wholeQuestion', 'format'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function reference(baseDir, value) {
  if (!object(value) || typeof value.path !== 'string' || path.isAbsolute(value.path) || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')) throw new Error('准备证据必须包含本地相对路径和 SHA256');
  const root = fs.realpathSync(baseDir), file = path.resolve(root, value.path);
  if (!inside(root, file)) throw new Error('准备证据路径越界');
  const real = fs.realpathSync(file);
  if (!inside(root, real) || !fs.statSync(real).isFile()) throw new Error('准备证据软链接越界');
  const bytes = fs.readFileSync(real);
  if (sha256(bytes) !== value.sha256) throw new Error('准备证据 SHA256 已变化，须重新生成草稿并审校');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

/** Recorded visual review, bound to exact draft and revalidated original bytes. */
export function approveReviewedDraft(draft, draftSha256, decisions, baseDir, decisionsSha256) {
  if (!object(decisions) || decisions.schemaVersion !== 1 || decisions.manifestSha256 !== draftSha256
      || decisions.coverageChecked !== true || !Array.isArray(decisions.tasks)) throw new Error('审校须绑定当前草稿 SHA256，确认逐页 coverage，并逐题给出决策');
  const prepared = draft?.preparation;
  if (!object(prepared) || prepared.kind !== 'local-paired-draft') throw new Error('只批准 workflow:draft 生成的完整来源草稿');
  const paired = reference(baseDir, prepared.paired), mapping = reference(baseDir, prepared.mapping);
  const { manifest: regenerated } = prepareDraftBatch(paired, mapping, baseDir, { paired: prepared.paired, mapping: prepared.mapping });
  if (!isDeepStrictEqual(regenerated, draft)) throw new Error('草稿与冻结 paired/mapping/原图证据不一致；请修改输入并重新生成草稿');
  const taskIds = new Set(draft.tasks.map(task => task.id)), byId = new Map();
  for (const decision of decisions.tasks) {
    if (!object(decision) || !taskIds.has(decision.taskId) || byId.has(decision.taskId)
        || !object(decision.checks) || checks.some(check => decision.checks[check] !== true)
        || typeof decision.evidence !== 'string' || !decision.evidence.trim()) throw new Error('审校决策须唯一引用每题，四项检查全部通过并记录实际原图依据');
    byId.set(decision.taskId, decision);
  }
  if (byId.size !== taskIds.size) throw new Error('审校决策缺题，不能批准部分结果为整批');
  const approved = structuredClone(draft);
  for (const task of approved.tasks) {
    if (task.review.status !== 'pending' || !Array.isArray(task.review.issues) || task.review.issues.length) throw new Error(`任务 ${task.id} 尚有问题；批准工具不会清除 issues`);
    const decision = byId.get(task.id);
    task.review = { ...task.review, status: 'approved', checks: structuredClone(decision.checks), evidence: decision.evidence,
      ...(decision.specialReview === undefined ? {} : { specialReview: structuredClone(decision.specialReview) }) };
  }
  approved.reviewEvidence = { schemaVersion: 1, draftSha256,
    ...(decisionsSha256 ? { decisionsSha256 } : { canonicalDecisionsSha256: sha256(Buffer.from(JSON.stringify(decisions))) }),
    coverageChecked: true, sourceSemanticsVerifiedByTool: false };
  const report = inspectReviewedBatch(approved, baseDir);
  if (!report.readyForExecution) throw new Error(`批准后仍未达到执行要求：${[...report.errors, ...report.unresolvedSpecialReview.map(item => item.reason)].join('; ')}`);
  return { manifest: approved, report };
}
