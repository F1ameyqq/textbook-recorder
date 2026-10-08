import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewDecisionsTemplate } from '../src/review-decisions-template.mjs';
import { preparationArguments, preparationArgumentPath, readJobJson, writeJobJson } from '../src/preparation-files.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function createReviewDecisions(argv, { project = projectRoot, cwd = process.cwd() } = {}) {
  const options = preparationArguments(argv, ['manifest', 'output']);
  if (options.help) return { help: 'workflow:decisions --manifest=data/jobs/<job>/batch.draft.json --output=data/jobs/<job>/review-decisions.json；仅准备待填写模板，不批准或写入平台' };
  const draft = await readJobJson(project, await preparationArgumentPath(cwd, options.manifest));
  const { decisions, report } = createReviewDecisionsTemplate(draft.value, draft.sha256, draft.baseDir);
  const output = await writeJobJson(project, await preparationArgumentPath(cwd, options.output), decisions, draft.baseDir);
  return { tasks: decisions.tasks.length, approved: 0, coverageChecked: false, readyForExecution: false,
    draftValid: report.valid, outputPath: output.file, outputSha256: output.sha256, manifestSha256: draft.sha256,
    source: draft.value.source, sourceSemanticsVerifiedByTool: false, platformWritePerformed: false,
    errors: report.errors, warnings: report.warnings, unresolvedSpecialReview: report.unresolvedSpecialReview };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await createReviewDecisions(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
