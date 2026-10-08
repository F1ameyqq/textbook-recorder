import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveReviewedDraft } from '../src/review-approval.mjs';
import { preparationArguments, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

export async function approveDraft(argv, root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))) {
  const options = preparationArguments(argv, ['manifest', 'decisions', 'output']);
  if (options.help) return { help: 'workflow:approve --manifest=data/jobs/<job>/batch.draft.json --decisions=data/jobs/<job>/review-decisions.json --output=data/jobs/<job>/batch.approved.json' };
  const draft = await readJobJson(root, options.manifest), decisions = await readJobJson(root, options.decisions);
  if (draft.baseDir !== decisions.baseDir) throw new Error('草稿和审校决策必须来自同一 job');
  const result = approveReviewedDraft(draft.value, draft.sha256, decisions.value, draft.baseDir, decisions.sha256);
  const output = await writeJobJson(root, options.output, result.manifest, draft.baseDir);
  return { approved: result.report.summary.approvedTasks, readyForExecution: true, manifestPath: output.file,
    manifestSha256: output.sha256, sourceSemanticsVerifiedByTool: false, platformWritePerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await approveDraft(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
