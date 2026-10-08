import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {workspacePath,existingWorkspacePath,existingWorkspaceDirectory,writableWorkspacePath,prepareRuntimeDirectory,loadRecorderConfig,validateRecorderCommand} from '../src/recorder-config.mjs';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {runReviewedBatch} from '../scripts/run-reviewed-batch-service.mjs';

async function aliasedWorkspace(t){
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-root-alias-'));
  const root=path.join(parent,'actual-workspace'),alias=path.join(parent,'workspace-alias'),outside=path.join(parent,'outside');
  await fs.mkdir(root);await fs.mkdir(outside);
  await fs.symlink(root,alias,process.platform==='win32'?'junction':'dir');
  t.after(async()=>{
    assert.equal(path.dirname(parent),path.resolve(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith('recorder-root-alias-'));
    await fs.unlink(alias);
    await fs.rm(parent,{recursive:true,force:true});
  });
  await fs.mkdir(path.join(root,'config'));
  await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'config/recorder.json'),JSON.stringify({bookId:101}));
  return {root:await fs.realpath(root),alias,outside};
}
function reviewedManifest(){
  return {schemaVersion:1,kind:'new-system-batch',bookId:101,source:'production',tasks:[{
    id:'alias-test-1',target:{chapterLabel:'合成章',sectionLabel:'合成节',record:1},source:{pages:[1],answerPages:[9]},
    stem:{blocks:[{type:'text',text:'求一加一的和。'}]},answer:{blocks:[{type:'text',text:'2'}]},
    answerRequirement:{kind:'question',evidence:'求一加一的和。'},answerStatus:'provided',
    review:{status:'approved',issues:[],checks:{sourceText:true,answerMatch:true,wholeQuestion:true,format:true}}
  }],coverage:{pages:[{page:1,candidates:[{id:'candidate-1',type:'question',decision:'include',taskIds:['alias-test-1']}]}]}};
}

test('root junction accepts lexical and canonical paths through config/runtime/path reuse',async t=>{
  const {root,alias}=await aliasedWorkspace(t),existing=path.join(root,'data/existing.json');
  await fs.writeFile(existing,'{"preserve":true}');
  assert.equal(workspacePath(alias,'data/existing.json'),existing);
  assert.equal(workspacePath(alias,existing),existing);
  assert.equal(await existingWorkspacePath(alias,'data/existing.json'),existing);
  assert.equal(await existingWorkspacePath(alias,existing),existing);
  assert.equal(await existingWorkspaceDirectory(alias,'.'),root);
  assert.equal(await existingWorkspaceDirectory(alias,root),root);
  assert.equal((await loadRecorderConfig(alias)).configPath,path.join(root,'config/recorder.json'));
  const prepared=await prepareRuntimeDirectory(alias,'data/runtime/nested');
  assert.equal(prepared,path.join(root,'data/runtime/nested'));
  assert.equal(await prepareRuntimeDirectory(alias,prepared),prepared);
  const output=await writableWorkspacePath(alias,path.join(prepared,'missing/deeper/evidence.json'));
  assert.equal(output,path.join(root,'data/runtime/nested/missing/deeper/evidence.json'));
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,'evidence');
  assert.equal(await existingWorkspacePath(alias,output),output);
  assert.equal(await writableWorkspacePath(alias,'data/existing.json'),existing);
  assert.deepEqual(validateRecorderCommand({action:'execute',args:{manifest:existing,state:output}},alias).args,{manifest:existing,state:output});
});

test('root alias does not admit escaped lexical paths or external child junctions',async t=>{
  const {root,alias,outside}=await aliasedWorkspace(t),escape=path.join(root,'data/escape');
  await fs.writeFile(path.join(outside,'sentinel.json'),'preserve');
  await fs.symlink(outside,escape,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>workspacePath(alias,'../outside/new.json'),/项目/u);
  assert.throws(()=>workspacePath(alias,path.join(outside,'sentinel.json')),/项目/u);
  assert.throws(()=>workspacePath(alias,root),/项目/u);
  assert.throws(()=>workspacePath(alias,path.join(root+'-sibling','new.json')),/项目/u);
  await assert.rejects(existingWorkspacePath(alias,'data/escape/sentinel.json'),/项目/u);
  await assert.rejects(existingWorkspaceDirectory(alias,'data/escape'),/项目/u);
  await assert.rejects(writableWorkspacePath(alias,'data/escape/sentinel.json'),/项目/u);
  await assert.rejects(writableWorkspacePath(alias,'data/escape/missing/deeper/output.json'),/项目/u);
  await assert.rejects(prepareRuntimeDirectory(alias,'data/escape/new-directory'),/项目/u);
  assert.deepEqual(await fs.readdir(outside),['sentinel.json']);
  assert.equal(await fs.readFile(path.join(outside,'sentinel.json'),'utf8'),'preserve');
});

test('writable paths resolve an in-workspace parent alias and reject unresolved child links',async t=>{
  const {root,alias}=await aliasedWorkspace(t),actual=path.join(root,'data/actual');
  await fs.mkdir(actual);
  await fs.symlink(actual,path.join(root,'data/internal-alias'),process.platform==='win32'?'junction':'dir');
  assert.equal(await writableWorkspacePath(alias,'data/internal-alias/new/output.json'),path.join(actual,'new/output.json'));
  const existing=path.join(actual,'existing.json');await fs.writeFile(existing,'existing');
  assert.equal(await writableWorkspacePath(alias,'data/internal-alias/existing.json'),existing);
  await fs.symlink(path.join(root,'missing-target'),path.join(root,'data/dangling'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(writableWorkspacePath(alias,'data/dangling/new.json'),/链接/u);
});

test('root alias cannot use the manifest as its state through session or batch CLI',async t=>{
  const {root,alias}=await aliasedWorkspace(t),manifest=path.join(root,'data/batch.json');
  const bytes=JSON.stringify(reviewedManifest());await fs.writeFile(manifest,bytes);
  let connections=0,requests=0;
  const session=new PersistentRecorderSession({root:alias,bookId:101,connect:async()=>{connections++;throw new Error('must not connect');}});
  await session.initialize();
  for(const args of [{manifest,state:'data/batch.json'},{manifest:'data/batch.json',state:manifest}]){
    await assert.rejects(session.command({action:'execute',args}),/进度不能覆盖题单/u);
    await assert.rejects(runReviewedBatch(['--manifest='+args.manifest,'--state='+args.state,'--action=execute'],{root:alias,request:async()=>{requests++;throw new Error('must not request');},log:()=>{}}),/进度不能覆盖题单/u);
  }
  assert.equal(connections,0);assert.equal(requests,0);assert.equal(await fs.readFile(manifest,'utf8'),bytes);
  await session.close();
});

test('a canonical blocked context survives restart through the root junction without unlocking',async t=>{
  const {root,alias}=await aliasedWorkspace(t),manifest=path.join(root,'data/batch.json'),state=path.join(root,'data/run.json');
  const bytes=JSON.stringify(reviewedManifest());await fs.writeFile(manifest,bytes);
  const session=new PersistentRecorderSession({root:alias,bookId:101});await session.initialize();
  session.state.writeBlocked=true;
  session.state.blockedContext={manifest,state,manifestSha256:createHash('sha256').update(bytes).digest('hex'),taskId:'alias-test-1',pendingPath:path.join(root,'data/pending.json')};
  await session.persist();await session.close();
  const restored=new PersistentRecorderSession({root:alias,bookId:101});await restored.initialize();
  assert.equal(restored.state.writeBlocked,true);assert.deepEqual(restored.state.blockedContext,session.state.blockedContext);
  await assert.rejects(restored.command({action:'execute',args:{manifest:'data/batch.json',state:'data/run.json'}}),/写入锁/u);
  await restored.close();
});

async function rejectsAliasedManifestState(root,manifest,aliasedFile){
  const bytes=await fs.readFile(manifest,'utf8');let connections=0,requests=0;
  const session=new PersistentRecorderSession({root,bookId:101,connect:async()=>{connections++;throw new Error('must not connect');}});
  await session.initialize();
  for(const args of [{manifest,state:aliasedFile},{manifest:aliasedFile,state:manifest}]){
    await assert.rejects(session.command({action:'execute',args}),/进度不能覆盖题单/u);
    await assert.rejects(runReviewedBatch(['--manifest='+args.manifest,'--state='+args.state,'--action=execute'],{root,request:async()=>{requests++;throw new Error('must not request');},log:()=>{}}),/进度不能覆盖题单/u);
  }
  assert.equal(connections,0);assert.equal(requests,0);assert.equal(await fs.readFile(manifest,'utf8'),bytes);
  await session.close();
}

test('an internal directory junction cannot alias the manifest as session or batch state',async t=>{
  const {root,alias}=await aliasedWorkspace(t),actual=path.join(root,'data/actual');await fs.mkdir(actual);
  const manifest=path.join(actual,'batch.json');await fs.writeFile(manifest,JSON.stringify(reviewedManifest()));
  await fs.symlink(actual,path.join(root,'data/internal-alias'),process.platform==='win32'?'junction':'dir');
  await rejectsAliasedManifestState(alias,manifest,'data/internal-alias/batch.json');
});

test('an internal file symlink cannot alias the manifest as session or batch state',async t=>{
  const {root,alias}=await aliasedWorkspace(t),manifest=path.join(root,'data/batch.json'),fileAlias=path.join(root,'data/file-alias.json');
  await fs.writeFile(manifest,JSON.stringify(reviewedManifest()));
  try{await fs.symlink(manifest,fileAlias,'file');}catch(error){
    if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file symlink privilege is unavailable; directory-junction file alias is separately exercised');return;}
    throw error;
  }
  await rejectsAliasedManifestState(alias,manifest,'data/file-alias.json');
});

test('restart canonicalizes an internal-junction recovery binding and permits only its readonly reconcile',async t=>{
  const {root,alias}=await aliasedWorkspace(t),actual=path.join(root,'data/actual');await fs.mkdir(actual);
  const manifest=path.join(actual,'batch.json'),run=path.join(actual,'run.json'),pendingPath=path.join(actual,'pending.json');
  const bytes=JSON.stringify(reviewedManifest());await fs.writeFile(manifest,bytes);await fs.writeFile(run,'{}');await fs.writeFile(pendingPath,'{}');
  await fs.symlink(actual,path.join(root,'data/internal-alias'),process.platform==='win32'?'junction':'dir');
  const session=new PersistentRecorderSession({root:alias,bookId:101});await session.initialize();
  const aliasPath=file=>path.join(alias,'data/internal-alias',file);
  session.state.writeBlocked=true;
  session.state.blockedContext={manifest:aliasPath('batch.json'),state:aliasPath('run.json'),pendingPath:aliasPath('pending.json'),manifestSha256:createHash('sha256').update(bytes).digest('hex'),taskId:'alias-test-1'};
  await session.persist();await session.close();
  const restored=new PersistentRecorderSession({root:alias,bookId:101});await restored.initialize();
  assert.deepEqual(restored.state.blockedContext,{...session.state.blockedContext,manifest,state:run,pendingPath});
  assert.equal(restored.state.writeBlocked,true);
  const context=await restored.reviewedContext({manifest:'data/internal-alias/batch.json',state:'data/internal-alias/run.json'});
  assert.equal(context.manifest,manifest);assert.equal(context.state,run);
  await assert.rejects(restored.command({action:'execute',args:{manifest,state:run}}),/写入锁/u);
  let command;
  restored.bind=async()=>{restored.connection={servicePid:12345,close:async()=>{}};};
  restored.bridge=async(action,payload)=>{
    if(action==='start'){command=payload;return {bookId:101,started:true};}
    assert.equal(action,'status');
    return {bookId:101,job:{id:command.id,terminal:true,result:{bookId:101,uncertain:true,writePerformed:false}}};
  };
  await assert.rejects(restored.command({action:'reconcile',args:{manifest,state:run,taskId:'another-task',pendingPath:'data/internal-alias/pending.json'}}),/原失败/u);
  const result=await restored.command({action:'reconcile',args:{manifest:'data/internal-alias/batch.json',state:'data/internal-alias/run.json',taskId:'alias-test-1',pendingPath:'data/internal-alias/pending.json'}});
  assert.equal(command.action,'reconcile');assert.equal(command.args.pendingPath,pendingPath);
  assert.equal(result.writeBlocked,true);assert.equal(restored.state.pending,null);
  await restored.close();
});
