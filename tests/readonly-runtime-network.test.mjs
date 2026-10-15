import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRecorderService } from '../scripts/run-recorder-service.mjs';
import { connectMcp } from '../scripts/run-new-system-extension.mjs';
import { waitRecorderCommand } from '../scripts/recorder-control.mjs';
import { summarizeRecorderStatus } from '../src/recorder-status-summary.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runtimeFixture(t, { attempts = false, tree = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-recorder-mcp-offline-'));
  await fs.cp(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true });
  await fs.cp(path.join(repository, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  await fs.symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'config'));
  const config = { bookId: 102, browserBackend: 'headless', readOnly: true, port: 8789 };
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify(config));
  let service;
  t.after(async () => {
    if (service) { await service.session.status(); await service.shutdown(); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const connect = async (bridgePath, options) => {
    assert.equal(options.readOnly, true);
    let bootstrap = await fs.readFile(bridgePath, 'utf8');
    // The fixture lives wholly behind context routes. It cannot reach Baidu or
    // any other network destination. The production read guard is installed
    // after this fallback and therefore has priority over it.
    const node=(name,children='',leaf=false)=>'<div class="el-tree-node'+(children?' is-expanded':'')+'"><div class="el-tree-node__content"><i class="el-tree-node__expand-icon'+(leaf?' is-leaf':'')+'"></i>'+name+'</div>'+(children?'<div class="el-tree-node__children">'+children+'</div>':'')+'</div>';
    const treeNodes=node('Unloaded parent')+node('Root leaf','',true)+node('Unit B',node('Period One',node('基础巩固','',true)));
    const html='<!doctype html><html><head><meta charset="utf-8"></head><body><div id="contentedit"><div class="w-e-text" contenteditable="true"></div></div><div id="answeredit"><div class="w-e-text" contenteditable="true"></div></div>'+
      (tree?'<div class="el-tree"></div><script>fetch("/edushop/textbook/detail/basicinfo?textbookID=102");setTimeout(()=>document.querySelector(".el-tree").innerHTML='+JSON.stringify(treeNodes)+',180);</script>':'<p>offline runtime fixture</p>')+'</body></html>';
    const fixture = `if(!context.__offlineReadFixture){context.__offlineReadFixture={passed:[]};await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());context.__offlineReadFixture.passed.push({method:request.method(),pathname:url.pathname});if(url.origin==='https://easylearn.baidu.com'&&request.method()==='GET'){await route.fulfill({status:200,contentType:url.pathname==='/edushop/textbook/detail/basicinfo'?'application/json':'text/html',body:url.pathname==='/edushop/textbook/detail/basicinfo'?JSON.stringify({errno:0,data:{textbookID:102,stateName:'草稿',canEdit:true}}):${JSON.stringify(html)}});}else await route.abort('blockedbyclient');});}`;
    bootstrap = bootstrap.replace('      await ownHeadless(page);', '      ' + fixture + '\n      await ownHeadless(page);');
    const adapter = `options=>({source:'production',origin:'https://easylearn.baidu.com',page:options.page,bookId:102,timeout:3000,directoryTimeout:3000,_nodeID:55,_directoryRecords:[],connect:async()=>{},guard:async()=>{},_reloadForFreshRead:async()=>options.page.reload({waitUntil:'domcontentloaded'}),read:async()=>{
      ${attempts ? `await options.page.evaluate(async()=>{for(const method of ['POST','PUT','PATCH','DELETE'])try{await fetch('/edushop/textbook/myproducecommit/editshiti?must-not-log-query=1',{method,body:'must-not-log-body'});}catch{}try{await fetch('/edushop/textbook/myproducecommit/editshiti?must-not-log-query=2');}catch{}});` : ''}
      return {status:'missing'};
    }})`;
    bootstrap = bootstrap.replace('installPersistentBridge({page:target,config})', 'installPersistentBridge({page:target,config,adapterFactory:' + adapter + '})');
    await fs.writeFile(bridgePath, bootstrap);
    return connectMcp(bridgePath, options);
  };
  service = await startRecorderService({ root, port: 0, resourceLeaseDirectory: path.join(root, 'test-resource-leases'), connect, log: () => {} });
  config.port = service.server.address().port;
  await fs.writeFile(path.join(root, 'config/recorder.json'), JSON.stringify(config));
  return { root, service };
}

test('ordinary controller probe proves zero mutation requests through actual readonly MCP bootstrap before navigation', { timeout: 60000 }, async t => {
  const { root, service } = await runtimeFixture(t);
  const completed = await waitRecorderCommand(root, { id: 'readonly-zero-probe', action: 'probe', args: { chapterLabel: 'Offline chapter', sectionLabel: 'Offline section' } }, { timeoutMs: 15000, pollMs: 20 });
  assert.equal(completed.error, undefined);
  assert.equal(completed.readOnly, true);
  assert.equal(completed.last.terminal, true);
  assert.equal(completed.last.result.writePerformed, false);
  const proof = completed.last.readOnlyNetwork ?? completed.last.result.readOnlyNetwork;
  assert.ok(proof);
  assert.equal(proof.start.installed, true);
  assert.equal(proof.zeroMutationAttemptsDuringCommand, true);
  assert.deepEqual(proof.end.counts, { attempted: 0, blocked: 0, abortFailed: 0, responded: 0, unrouted: 0, pending: 0 });
  assert.equal(proof.allMutationAttemptsBlocked, true);
  const disk = JSON.parse(await fs.readFile(proof.evidencePath, 'utf8'));
  assert.equal(disk.bookId, 102); assert.equal(disk.zeroMutationAttempts, true);
  const summary = summarizeRecorderStatus(completed);
  assert.equal(summary.readOnly, true); assert.ok(summary.job.readOnlyNetwork ?? summary.job.result.readOnlyNetwork);
  for (const action of ['draft-roundtrip', 'draft-roundtrip-restore']) {
    await assert.rejects(service.session.invokeBridge('start', { id: 'readonly-denied-' + action, action,
      args: { manifest: 'data/never-read-plan.json', state: 'data/never-created-journal.json' } }), /readOnly/u);
  }
  assert.equal(service.session.state.connectionCount, 1);
  assert.equal((await service.session.status()).remote.job.id, 'readonly-zero-probe');
});

test('actual readonly MCP blocks write methods and known mutation GET, with attempts disclosed and no sensitive payload logging', { timeout: 60000 }, async t => {
  const { root } = await runtimeFixture(t, { attempts: true });
  const completed = await waitRecorderCommand(root, { id: 'readonly-blocked-probe', action: 'probe', args: { chapterLabel: 'Offline chapter', sectionLabel: 'Offline section' } }, { timeoutMs: 15000, pollMs: 20 });
  assert.equal(completed.error, undefined);
  const proof = completed.last.readOnlyNetwork ?? completed.last.result.readOnlyNetwork;
  assert.equal(proof.zeroMutationAttemptsDuringCommand, false);
  assert.equal(proof.delta.attempted, 5); assert.equal(proof.delta.blocked, 5);
  assert.equal(proof.end.counts.responded, 0); assert.equal(proof.allMutationAttemptsBlocked, true);
  assert.deepEqual(proof.end.endpoints.map(value => value.method).sort(), ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  const diskText = await fs.readFile(proof.evidencePath, 'utf8');
  assert.doesNotMatch(diskText, /must-not-log-query|must-not-log-body|headers|cookie|authorization/iu);
  assert.ok(JSON.parse(diskText).endpoints.every(value => value.pathname === '/edushop/textbook/myproducecommit/editshiti'));
});

test('actual readonly MCP tree preparation waits for loaded nodes and preserves raw scalar draft diagnostics', { timeout: 60000 }, async t => {
  const {root}=await runtimeFixture(t,{tree:true});
  const completed=await waitRecorderCommand(root,{id:'readonly-tree-probe',action:'probe',args:{treeSnapshot:true}},{timeoutMs:15000,pollMs:20});
  assert.equal(completed.last.error,undefined);const result=completed.last.result;
  assert.equal(result.writePerformed,false);assert.equal(result.basicinfo.stateName,'草稿');assert.equal(result.basicinfo.canEdit,true);assert.equal(result.basicinfo.canEditType,'boolean');
  assert.equal(result.roots,3);assert.equal(result.visibleLeaves,2);
  const snapshot=JSON.parse(await fs.readFile(result.treeSnapshotPath,'utf8'));
  assert.equal(snapshot.treeNodeCount,5);assert.equal(snapshot.contentCount,5);
  assert.deepEqual(snapshot.visibleLeaves.map(row=>row.path),[['Root leaf'],['Unit B','Period One','基础巩固']]);
  assert.equal(completed.last.readOnlyNetwork.zeroMutationAttemptsDuringCommand,true);
});
