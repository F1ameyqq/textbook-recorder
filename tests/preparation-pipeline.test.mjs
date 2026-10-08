import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { preparePairedBatch } from '../src/paired-batch.mjs';
import { prepareDraftBatch, rasterDimensions } from '../src/draft-batch.mjs';
import { sha256, preparationJob, writeJobJson, readJobJson } from '../src/preparation-files.mjs';
import { pairBatch } from '../scripts/pair-batch.mjs';
import { prepareDraft } from '../scripts/prepare-draft.mjs';
import { inspectReviewedBatch, renderReviewedBatchPreview } from '../src/review-preflight.mjs';

const copied = value => structuredClone(value);
function png(width, height) {
  const crc = bytes => { let sum = 0xffffffff; for (const byte of bytes) { sum ^= byte; for (let i = 0; i < 8; i++) sum = sum & 1 ? 0xedb88320 ^ sum >>> 1 : sum >>> 1; } return (sum ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(Buffer.alloc(height*(1+width*3),255))), chunk('IEND',Buffer.alloc(0))]);
}

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(),'recorder-preparation-'));
  t.after(() => fs.rm(project,{recursive:true,force:true}));
  const baseDir = path.join(project,'data','jobs','synthetic');
  await fs.mkdir(path.join(baseDir,'images'),{recursive:true});
  const bytes = png(2,2), pages = [];
  for (let page=1;page<=3;page++) {
    const file=`images/page-${page}.png`; await fs.writeFile(path.join(baseDir,file),bytes);
    pages.push({systemPage:page,file,sha256:sha256(bytes),width:2,height:2,mimeType:'image/png',bytes:bytes.length});
  }
  const index = {schemaVersion:1,bookId:900001,pages};
  const indexBytes = Buffer.from(JSON.stringify(index)); await fs.writeFile(path.join(baseDir,'index.json'),indexBytes);
  const source = chosen => ({pages:chosen,images:chosen.map(page=>pages[page-1].file),regions:chosen.map(page=>({page,image:pages[page-1].file,bbox:[0,0,2,2]}))});
  const record = (id,number,text,chosen) => ({id,chapter:'示例章',unit:'示例节',group:'基础',questionNumber:number,rawOcr:text,source:source(chosen)});
  const input = {schemaVersion:1,bookId:900001,
    questions:[record('q1',1,'1. 合成问题？',[1]),record('knowledge',null,'知识建构：填写两项。',[1,2]),record('activity',null,'活动整体：分析并回答，步骤一和步骤二。',[1,2])],
    answers:[record('a1',1,'合成答案',[3]),record('a2',null,'甲、乙',[3]),record('a3',null,'整体分析答案',[3])],
    pairings:[{questionId:'knowledge',answerId:'a2'},{questionId:'activity',answerId:'a3'}]};
  const mapping = {schemaVersion:1,kind:'new-system-draft-mapping',bookId:900001,source:'fixture',index:{path:'index.json',sha256:sha256(indexBytes)},
    placements:input.questions.map((q,i)=>({questionId:q.id,target:{chapterLabel:'示例章',sectionLabel:'示例节',record:i+1},answerRequirement:{kind:i===1?'fill-in':'question',evidence:q.rawOcr},answerStatus:'provided'})),
    coverage:{pages:[{page:1,imagePath:pages[0].file,candidates:[{id:'q1-page1',type:'question',decision:'include',taskIds:['q1']},{id:'k-page1',type:'knowledge-construction',decision:'include',taskIds:['knowledge']},{id:'activity-page1',type:'whole-activity',decision:'include',taskIds:['activity']}]},
      {page:2,imagePath:pages[1].file,candidates:[{id:'k-page2',type:'knowledge-construction',decision:'include',taskIds:['knowledge']},{id:'activity-page2',type:'whole-activity',decision:'include',taskIds:['activity']},{id:'instruction',type:'non-question',decision:'exclude',taskIds:[],reason:'仅展示流程说明，无具体作答要求'}]}]}};
  return {project,baseDir,input,mapping,index,source,record,paired:preparePairedBatch(input)};
}

test('synthetic records -> paired -> pending draft -> offline preview preserves whole tasks and provenance',async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.baseDir,'records.json'),JSON.stringify(f.input));
  await fs.writeFile(path.join(f.baseDir,'mapping.json'),JSON.stringify(f.mapping));
  const paired = await pairBatch(['--input','data/jobs/synthetic/records.json','--output','data/jobs/synthetic/paired.json'],{project:f.project,cwd:f.project});
  assert.equal(paired.approved,0); assert.equal(paired.pending,3); assert.equal(paired.readyForExecution,false);
  const result = await prepareDraft(['--input=data/jobs/synthetic/paired.json','--mapping=data/jobs/synthetic/mapping.json','--output=data/jobs/synthetic/draft.json'],{project:f.project,cwd:f.project});
  assert.equal(result.valid,true); assert.equal(result.pending,3); assert.equal(result.readyForExecution,false);
  const manifest = JSON.parse(await fs.readFile(result.outputPath,'utf8'));
  assert.deepEqual(manifest.tasks.map(task=>task.id),['q1','knowledge','activity']);
  assert.deepEqual(manifest.tasks[2].source.pages,[1,2]);
  assert.deepEqual(manifest.tasks[1].review.issues,[]);
  assert.equal(manifest.tasks[0].preparation.records.stem.rawOcr,f.input.questions[0].rawOcr);
  assert.equal(manifest.preparation.index.sha256,f.mapping.index.sha256);
  assert.ok(manifest.tasks.every(task=>task.review.status==='pending'&&Object.values(task.review.checks).every(value=>value===false)));
  const preview = renderReviewedBatchPreview(manifest,f.baseDir);
  assert.match(preview,/data:image\/png;base64,/); assert.doesNotMatch(preview,/<script|onclick=/iu);
  await assert.rejects(prepareDraft(['--input=data/jobs/synthetic/paired.json','--mapping=data/jobs/synthetic/mapping.json','--output=data/jobs/synthetic/draft.json'],{project:f.project,cwd:f.project}),/EEXIST/);
});

test('ambiguous, reused and unknown answers remain unresolved despite replacement declarations',async t=>{
  const f=await fixture(t), input=copied(f.input); input.answers[0].rawOcr='未知';
  input.pairings.push({questionId:'q1',answerId:'a1'}); input.pairings[1].answerId='a1';
  const paired=preparePairedBatch(input), mapping=copied(f.mapping);
  mapping.placements[0].replacementBlocks={answer:[{type:'text',text:'人工拟定文字'}]};
  mapping.placements[0].agentReview={checkedAgainstOriginal:true,evidence:'仅记录核对声明'};
  const result=prepareDraftBatch(paired,mapping,f.baseDir);
  assert.ok(result.manifest.tasks[0].review.issues.includes('answer_unknown'));
  assert.ok(result.manifest.tasks[0].review.issues.includes('answer_reused'));
  assert.equal(result.report.readyForExecution,false);
  const multiple=copied(f.input); multiple.answers.push(f.record('duplicate',1,'另候选',[3]));
  assert.ok(prepareDraftBatch(preparePairedBatch(multiple),f.mapping,f.baseDir).manifest.tasks[0].review.issues.includes('multiple_answer_candidates'));
});

test('missing reference requires explicit current rule, actual indexed searched pages and concrete question',async t=>{
  const f=await fixture(t), input=copied(f.input); input.answers=input.answers.filter(item=>item.id!=='a1');
  const mapping=copied(f.mapping); mapping.placements[0].answerStatus='not-provided'; mapping.placements[0].searchedAnswerPages=[3];
  const paired=preparePairedBatch(input), unresolved=prepareDraftBatch(paired,mapping,f.baseDir);
  assert.ok(unresolved.manifest.tasks[0].review.issues.includes('answer_missing')); assert.equal(unresolved.report.valid,false);
  mapping.placements[0].agentReview={checkedAgainstOriginal:true,evidence:'原图第3页已逐图检查，未见此题参考答案'};
  mapping.missingReferencePolicy={authorized:true,source:'direct-user-rule',userQuote:'本次确有具体问题但无答案时使用固定备注',evidenceReference:'synthetic-current-user-rule',label:'原书未提供参考答案'};
  const known=prepareDraftBatch(paired,mapping,f.baseDir);
  assert.deepEqual(known.manifest.tasks[0].review.issues,[]); assert.equal(known.report.valid,true);
  assert.equal(known.manifest.tasks[0].answer.blocks[0].text,'原书未提供参考答案');
  assert.equal(known.manifest.tasks[0].preparation.notes[0].originalIssue,'answer_missing');
  assert.equal(known.manifest.tasks[0].review.status,'pending');
  mapping.placements[0].answerRequirement.evidence='原书未提供参考答案';
  assert.throws(()=>prepareDraftBatch(paired,mapping,f.baseDir),/作答要求/);
});

test('index raw SHA, actual dimensions, source-page relationship and bounds are enforced',async t=>{
  const f=await fixture(t), wrong=copied(f.mapping); wrong.index.sha256='a'.repeat(64);
  assert.throws(()=>prepareDraftBatch(f.paired,wrong,f.baseDir),/SHA256/);
  const index=copied(f.index); index.pages[0].width=3; const bytes=Buffer.from(JSON.stringify(index));
  await fs.writeFile(path.join(f.baseDir,'wrong-index.json'),bytes); wrong.index={path:'wrong-index.json',sha256:sha256(bytes)};
  assert.throws(()=>prepareDraftBatch(f.paired,wrong,f.baseDir),/实际尺寸/);
  const out=copied(f.paired); out.tasks[0].stem.source.regions[0].bbox=[0,0,3,2];
  assert.throws(()=>prepareDraftBatch(out,f.mapping,f.baseDir),/坐标/);
  const page=copied(f.paired); page.tasks[0].stem.source.regions[0].image='images/page-2.png'; page.tasks[0].stem.source.images.push('images/page-2.png');
  assert.throws(()=>prepareDraftBatch(page,f.mapping,f.baseDir),/来源页|原图路径/);
});

test('crop requires byte-bound source.json and exact source geometry, not an image.source claim',async t=>{
  const f=await fixture(t); await fs.mkdir(path.join(f.baseDir,'figures')); const bytes=png(1,1);
  await fs.writeFile(path.join(f.baseDir,'figures','diagram.png'),bytes);
  const mapping=copied(f.mapping), source={page:1,image:'images/page-1.png',bbox:[0,0,1,1],sha256:f.index.pages[0].sha256};
  mapping.placements[0].replacementBlocks={stem:[{type:'text',text:'合成题干仍用文本。'},{type:'image',path:'figures/diagram.png',purpose:'diagram',source}]};
  mapping.placements[0].agentReview={checkedAgainstOriginal:true,evidence:'逐原图核对图与题干'};
  assert.throws(()=>prepareDraftBatch(f.paired,mapping,f.baseDir),/cropEvidence/);
  const evidence={kind:'source-crops',bookId:f.input.bookId,indexSha256:f.mapping.index.sha256,crops:[{id:'diagram',page:1,image:source.image,sourceSha256:source.sha256,bbox:source.bbox,file:'figures/diagram.png',sha256:sha256(bytes),purpose:'diagram'}]};
  const raw=Buffer.from(JSON.stringify(evidence)); await fs.writeFile(path.join(f.baseDir,'source.json'),raw); mapping.cropEvidence={path:'source.json',sha256:sha256(raw)};
  const result=prepareDraftBatch(f.paired,mapping,f.baseDir); assert.equal(result.report.valid,true); assert.equal(result.manifest.tasks[0].stem.blocks[1].align,'center');
  const wrong=copied(mapping); wrong.placements[0].replacementBlocks.stem[1].source.sha256=sha256(bytes);
  assert.throws(()=>prepareDraftBatch(f.paired,wrong,f.baseDir),/裁图证据/);
  const wrongTaskRegion=copied(f.paired); wrongTaskRegion.tasks[0].stem.source.regions[0].bbox=[1,1,2,2];
  assert.throws(()=>prepareDraftBatch(wrongTaskRegion,mapping,f.baseDir),/本题已声明/);
  await fs.writeFile(path.join(f.baseDir,'figures','diagram.png'),png(2,1));
  assert.throws(()=>prepareDraftBatch(f.paired,mapping,f.baseDir),/裁图输出/);
});

test('whole-question screenshots and split whole activities are blocked; approved is never copied',async t=>{
  const f=await fixture(t), image=copied(f.mapping); image.placements[0].replacementBlocks={stem:[{type:'image',path:'images/page-1.png',purpose:'whole-question'}]};
  image.placements[0].agentReview={checkedAgainstOriginal:true,evidence:'声明不能解除整题截图禁止'};
  assert.throws(()=>prepareDraftBatch(f.paired,image,f.baseDir),/whole-question/);
  const split=copied(f.mapping); split.coverage.pages[0].candidates[2].taskIds=['activity','q1'];
  assert.equal(prepareDraftBatch(f.paired,split,f.baseDir).report.valid,false);
  const approved=copied(f.paired); approved.tasks[0].review.status='approved';
  assert.equal(prepareDraftBatch(approved,f.mapping,f.baseDir).manifest.tasks[0].review.status,'pending');
});

test('rich replacements preserve exact scripts and eight answer spaces; latex is explicit unsupported',async t=>{
  const f=await fixture(t), mapping=copied(f.mapping);
  mapping.placements[0].replacementBlocks={answer:[{type:'text',runs:[{type:'text',text:'R'},{type:'sub',text:'1'},{type:'text',text:'\u00a0'.repeat(8)+'10'},{type:'sup',text:'3'}],strictSpacing:true}]};
  mapping.placements[0].agentReview={checkedAgainstOriginal:true,evidence:'逐图确认上下标和答案间隔'};
  const result=prepareDraftBatch(f.paired,mapping,f.baseDir); assert.deepEqual(result.manifest.tasks[0].answer.blocks,mapping.placements[0].replacementBlocks.answer);
  assert.equal(result.report.valid,true);
  const latex=copied(f.input); latex.questions[0].blocks=[{type:'latex',latex:'\\frac{1}{2}'}];
  const blocked=prepareDraftBatch(preparePairedBatch(latex),f.mapping,f.baseDir);
  assert.equal(blocked.manifest.tasks[0].stem.blocks[0].type,'formula'); assert.equal(blocked.report.valid,false);
  assert.ok(blocked.manifest.tasks[0].review.issues.includes('unsupported_native_format'));
  const unchecked=copied(mapping); delete unchecked.placements[0].agentReview;
  assert.throws(()=>prepareDraftBatch(f.paired,unchecked,f.baseDir),/agentReview/);
});

test('scope mismatch, target reuse and dropped placements cannot become ready',async t=>{
  const f=await fixture(t), mismatched=copied(f.input); mismatched.answers[1].unit='其他节';
  const result=prepareDraftBatch(preparePairedBatch(mismatched),f.mapping,f.baseDir); assert.ok(result.manifest.tasks[1].review.issues.includes('declared_answer_scope_mismatch'));
  const reused=copied(f.mapping); reused.placements[1].target.record=1;
  assert.equal(prepareDraftBatch(f.paired,reused,f.baseDir).report.valid,false);
  const dropped=copied(f.mapping); dropped.placements.pop(); assert.throws(()=>prepareDraftBatch(f.paired,dropped,f.baseDir),/覆盖全部/);
});

test('source zero is rejected by the existing paired validator rather than repaired',async t=>{
  const f=await fixture(t), invalid=copied(f.input); invalid.questions[0].source.pages=[0];
  assert.throws(()=>preparePairedBatch(invalid),/正整数|来源页/);
});

test('job paths reject cross-job output, outside root and overwrite without modifying old bytes',async t=>{
  const f=await fixture(t); await fs.mkdir(path.join(f.project,'data','jobs','other'));
  await assert.rejects(writeJobJson(f.project,'data/jobs/other/out.json',{},f.baseDir),/同一/);
  await assert.rejects(writeJobJson(f.project,'outside/out.json',{}),/data\/jobs/);
  await assert.rejects(writeJobJson(f.project,'data/jobs/synthetic/nested/out.json',{}),/根目录/);
  await writeJobJson(f.project,'data/jobs/synthetic/out.json',{old:true},f.baseDir);
  await assert.rejects(writeJobJson(f.project,'data/jobs/synthetic/out.json',{old:false},f.baseDir),/EEXIST/);
  assert.deepEqual((await readJobJson(f.project,'data/jobs/synthetic/out.json')).value,{old:true});
});

test('actual symlink/junction ancestor outside jobs is rejected before creating output',async t=>{
  const f=await fixture(t), outside=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-outside-'));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const link=path.join(f.project,'data','jobs','escape');
  try { await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir'); }
  catch (error) { if (process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction'); return; } throw error; }
  await assert.rejects(writeJobJson(f.project,'data/jobs/escape/attempt.json',{}),/越界|越出|真实路径/);
  await assert.rejects(preparationJob(f.project,'data/jobs/escape/in.json'),/越界|越出|真实路径/);
  assert.deepEqual(await fs.readdir(outside),[]);
});

test('relative CLI flags through an actual project junction alias retain canonical job confinement',async t=>{
  const f=await fixture(t), alias=path.join(path.dirname(f.project),path.basename(f.project)+'-alias');
  try { await fs.symlink(f.project,alias,process.platform==='win32'?'junction':'dir'); }
  catch(error) { if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction');return; } throw error; }
  t.after(()=>fs.unlink(alias));
  const canonicalBase=await fs.realpath(f.baseDir);
  await fs.writeFile(path.join(f.baseDir,'records.json'),JSON.stringify(f.input));
  const result=await pairBatch(['--input=data/jobs/synthetic/records.json','--output=data/jobs/synthetic/alias-paired.json'],{project:f.project,cwd:alias});
  assert.equal(path.dirname(result.outputPath),canonicalBase);
  const absolute=await pairBatch(['--input',path.join(alias,'data','jobs','synthetic','records.json'),'--output',path.join(alias,'data','jobs','synthetic','absolute-paired.json')],{project:f.project,cwd:alias});
  assert.equal(path.dirname(absolute.outputPath),canonicalBase);
  const lexical=await preparationJob(alias,path.join(alias,'data','jobs','synthetic','other.json'),{create:true});
  assert.equal(lexical.baseDir,canonicalBase);
  // A physically identical baseDir alias is accepted, rather than only a
  // canonical baseDir returned by readJobJson. A different job stays rejected.
  const aliasBase=path.join(alias,'data','jobs','synthetic');
  const written=await writeJobJson(f.project,'data/jobs/synthetic/alias-write.json',{viaAlias:true},aliasBase);
  assert.equal(path.dirname(written.file),canonicalBase);
  assert.deepEqual((await readJobJson(f.project,'data/jobs/synthetic/alias-write.json')).value,{viaAlias:true});
  await fs.mkdir(path.join(f.project,'data','jobs','other'));
  await assert.rejects(writeJobJson(f.project,'data/jobs/other/alias-cross-job.json',{},aliasBase),/同一/);
  await assert.rejects(fs.access(path.join(f.project,'data','jobs','other','alias-cross-job.json')),/ENOENT/);
});

test('input image and JSON symlinks cannot escape the job',async t=>{
  const f=await fixture(t), outside=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-source-outside-'));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.writeFile(path.join(outside,'outside.json'),'{}');
  const link=path.join(f.baseDir,'foreign');
  try { await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir'); }
  catch (error) { if (process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)) { t.skip('Windows 无权创建实际 junction'); return; } throw error; }
  const mapping=copied(f.mapping); mapping.index.path='foreign/outside.json';
  assert.throws(()=>prepareDraftBatch(f.paired,mapping,f.baseDir),/软链接越界/);
  // Existing normal original assets remain usable after rejecting the foreign reference.
  assert.equal(prepareDraftBatch(f.paired,f.mapping,f.baseDir).report.valid,true);
});

test('raster header parser supports PNG and real SOF JPEG, refuses malformed dimensions',()=>{
  assert.deepEqual(rasterDimensions(png(3,4)),{width:3,height:4,mimeType:'image/png'});
  const jpeg=Buffer.from([255,216,255,192,0,8,8,0,4,0,3,1,255,217]);
  assert.deepEqual(rasterDimensions(jpeg),{width:3,height:4,mimeType:'image/jpeg'});
  assert.throws(()=>rasterDimensions(Buffer.from('<svg/>')),/PNG\/JPEG/);
});
