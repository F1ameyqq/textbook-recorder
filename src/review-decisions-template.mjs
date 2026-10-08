import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './preparation-files.mjs';
import { prepareDraftBatch } from './draft-batch.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const checks = ['sourceText', 'answerMatch', 'wholeQuestion', 'format'];
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

function readReference(baseDir, reference, label) {
  if (!object(reference) || typeof reference.path !== 'string' || !reference.path || reference.path.includes('\0')
      || path.isAbsolute(reference.path) || !hashString(reference.sha256)) throw new Error(`${label} 须绑定本地相对路径和 SHA256`);
  const root = fs.realpathSync(baseDir), file = path.resolve(root, reference.path);
  if (!inside(root, file)) throw new Error(`${label} 路径越出同一 job`);
  const real = fs.realpathSync(file);
  if (!inside(root, real) || !fs.statSync(real).isFile()) throw new Error(`${label} 软链接越出同一 job 或不是文件`);
  const bytes = fs.readFileSync(real);
  if (sha256(bytes) !== reference.sha256) throw new Error(`${label} SHA256 已变化，请重新生成草稿`);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

function recordReference(record) {
  if (!record) return null;
  return { recordId: record.id, pages: structuredClone(record.source.pages),
    images: structuredClone(record.source.images ?? []), regions: structuredClone(record.source.regions ?? []) };
}

/** Prepare blank decisions from a reproducible draft; this never records a visual review. */
export function createReviewDecisionsTemplate(draft, draftSha256, baseDir) {
  if (!object(draft) || draft.schemaVersion !== 1 || draft.kind !== 'new-system-batch'
      || !['fixture', 'production'].includes(draft.source) || !hashString(draftSha256)
      || !object(draft.preparation) || draft.preparation.kind !== 'local-paired-draft') {
    throw new Error('只为 workflow:draft 生成的完整来源草稿准备审校模板，须绑定当前原字节 SHA256');
  }
  if (!Array.isArray(draft.tasks) || !draft.tasks.length) throw new Error('草稿 tasks 必须是非空数组');
  const ids = new Set();
  for (const task of draft.tasks) {
    if (!object(task) || typeof task.id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(task.id) || ids.has(task.id)) {
      throw new Error('草稿 task ID 无效或重复');
    }
    ids.add(task.id);
    if (task.review?.status !== 'pending') throw new Error(`任务 ${task.id} 不是待审草稿；不能从已批准题单生成模板`);
  }
  if (draft.reviewEvidence !== undefined || draft.preparation.automaticallyApproved !== false
      || draft.preparation.sourceSemanticsVerifiedByTool !== false) throw new Error('草稿已携带批准声明或来源自动确认，不能生成待审模板');
  const prepared = draft.preparation;
  const paired = readReference(baseDir, prepared.paired, 'paired'), mapping = readReference(baseDir, prepared.mapping, 'mapping');
  const regenerated = prepareDraftBatch(paired, mapping, baseDir, { paired: prepared.paired, mapping: prepared.mapping });
  if (!isDeepStrictEqual(regenerated.manifest, draft)) {
    throw new Error('草稿与冻结 paired/mapping/原图证据不一致；不能修改来源、旧检查或内容后生成模板，请重新生成草稿');
  }
  // Index lookups identify searched answer images only. No whole-page region or
  // successful review is invented when the original answer record is absent.
  const index = readReference(baseDir, prepared.index, 'index');
  const byPage = new Map(index.pages.map(page => [page.systemPage, page]));
  const decisions = { schemaVersion: 1, manifestSha256: draftSha256,
    bookId: draft.bookId, source: draft.source, coverageChecked: false,
    sourceSemanticsVerifiedByTool: false, platformWritePerformed: false,
    instructions: '待填写模板：来源引用只供定位，未完成读图审校；实际逐题核对后填写四项检查和 evidence，逐页核对覆盖后再填写 coverageChecked；专项确认须另行实际核对。',
    tasks: draft.tasks.map(task => {
      const records = task.preparation.records;
      return { taskId: task.id, checks: Object.fromEntries(checks.map(check => [check, false])), evidence: '',
        sourceReferences: { referenceOnly: true, stem: recordReference(records.stem), answer: recordReference(records.answer),
          answerPages: structuredClone(task.source.answerPages),
          ...(!records.answer ? { searchedAnswerImages: task.source.answerPages.map(page => {
            const entry = byPage.get(page);
            return { page, image: entry.file, sha256: entry.sha256 };
          }) } : {}) },
        pendingIssues: structuredClone(task.review.issues),
        specialReviewRequired: structuredClone(regenerated.report.unresolvedSpecialReview.filter(item => item.taskId === task.id)) };
    }) };
  return { decisions, report: regenerated.report };
}
