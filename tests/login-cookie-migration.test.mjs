import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { migrateOwnedSiteLoginCookies, validateSiteCookies, transformLoginCookiesDpapi, LOGIN_COOKIE_DPAPI_ENTROPY } from '../src/login-cookie-migration.mjs';
import { prepareHeadlessProfile } from '../src/recorder-browser-profile.mjs';
import { validateRecorderConfig } from '../src/recorder-config.mjs';
import { chromium } from 'playwright';

const dummyValue = 'synthetic-test-only-cookie-value';
const cookie = overrides => ({ name: 'fixture_session', value: dummyValue, domain: '.baidu.com', path: '/', expires: Date.now()/1000+3600,
  httpOnly: true, secure: true, sameSite: 'None', ...overrides });

async function workers(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cookie-migration-offline-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = [path.join(base,'source'),path.join(base,'target')];
  for (let index=0;index<roots.length;index++) {
    await fs.mkdir(path.join(roots[index],'config'),{recursive:true});
    const config = validateRecorderConfig({bookId:101+index,browserBackend:'headless',readOnly:true});
    await fs.writeFile(path.join(roots[index],'config/recorder.json'),JSON.stringify(config));
    await prepareHeadlessProfile(config,roots[index]);
  }
  return { sourceRoot:roots[0],targetRoot:roots[1] };
}

function dependencies({ sourceCookies = [cookie()], changeTargetReadback = false, leaseFails = false, navigationFault = false } = {}) {
  const calls = [], targetCookies = [];
  const launch = async (profile,options) => {
    calls.push({type:'launch',profile,options});
    let connected=true;
    const isTarget=profile.includes(path.sep+'target'+path.sep);
    const page=new EventEmitter();page.currentUrl='about:blank';page.url=()=>page.currentUrl;
    const context=new EventEmitter();context.pages=()=>[page];
    const browser={isConnected:()=>connected,newBrowserCDPSession:async()=>({send:async method=>{assert.equal(method,'SystemInfo.getProcessInfo');return {processInfo:[{type:'browser',id:isTarget?40002:40001}]};},detach:async()=>{}})};
    Object.assign(context,{ browser:()=>browser,route:async(_,handler)=>calls.push({type:'route',handler}),
      cookies:async urls=>{calls.push({type:'cookies',urls});if(navigationFault){page.currentUrl='https://easylearn.baidu.com/';page.emit('framenavigated');}return isTarget?structuredClone(changeTargetReadback?[cookie({value:'incorrect synthetic'})]:targetCookies):structuredClone(sourceCookies);},
      addCookies:async values=>{calls.push({type:'addCookies',count:values.length});targetCookies.push(...structuredClone(values));},
      close:async()=>{connected=false;calls.push({type:'close'});},
      newPage:async()=>{throw new Error('migration must not navigate');}, storageState:async()=>{throw new Error('migration must not export localStorage');} });
    return context;
  };
  const acquireLease=async(config,root)=>{
    calls.push({type:'lease',bookId:config.bookId,root});
    if(leaseFails)throw new Error('a live owned service still holds this resource');
    return {markConnecting:async()=>{},updateServicePid:async pid=>calls.push({type:'pid',pid}),confirmNoService:async()=>{},release:async()=>({released:true})};
  };
  return {calls,launch,acquireLease,protect:async text=>Buffer.from(text).toString('base64'),unprotect:async text=>Buffer.from(text,'base64').toString('utf8')};
}

test('cookie applicability rejects other domains, malformed data and duplicate identities without exposing values',()=>{
  assert.equal(validateSiteCookies([cookie()]).length,1);
  for(const value of [[],[cookie({domain:'.passport.baidu.com'})],[cookie({domain:'.example.test'})],[cookie({sameSite:'invalid'})],[cookie(),cookie()]]) {
    assert.throws(()=>validateSiteCookies(value),error=>!error.message.includes(dummyValue));
  }
});

test('migration uses only two explicitly registered local profiles and emits metadata with encrypted package hash',async t=>{
  const roots=await workers(t),options=dependencies();
  const result=await migrateOwnedSiteLoginCookies({...roots,...options});
  assert.equal(result.cookieCount,1);assert.equal(result.importedCookieCount,1);assert.equal(result.localCookieReadbackVerified,true);assert.equal(result.platformLoginVerified,false);
  assert.equal(result.sourceBookId,101);assert.equal(result.targetBookId,102);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-test-only-cookie-value/u);
  const bytes=await fs.readFile(result.packagePath),envelope=JSON.parse(bytes);
  assert.equal(envelope.algorithm,'windows-dpapi');assert.equal(envelope.scope,'CurrentUser');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),result.encryptedPackageSha256);
  assert.equal(envelope.cookies[0].name,'fixture_session');assert.equal(envelope.cookies[0].value,undefined);
  assert.ok(!bytes.toString('utf8').includes(dummyValue));
  const launches=options.calls.filter(value=>value.type==='launch');assert.equal(launches.length,3);
  assert.ok(launches.every(value=>value.options.headless===true&&value.options.serviceWorkers==='block'&&value.options.args.includes('--disable-sync')));
  assert.ok(launches[0].profile.startsWith(roots.sourceRoot));assert.ok(launches[1].profile.startsWith(roots.targetRoot));
  assert.equal(options.calls.filter(value=>value.type==='close').length,3);
  assert.equal(options.calls.filter(value=>value.type==='addCookies').length,1);
  assert.ok(options.calls.filter(value=>value.type==='cookies').every(value=>value.urls.every(url=>url.startsWith('https://easylearn.baidu.com/'))));
  for(const audit of [result.sourceAudit,result.targetAudit,result.targetPersistenceAudit]){
    assert.equal(audit.pageNavigationCount,0);assert.equal(audit.pageRequestCount,0);assert.equal(audit.blockedPageRequestCount,0);
    assert.equal(audit.allPagesInitiallyAboutBlank,true);assert.equal(audit.allPagesFinallyAboutBlank,true);
    assert.equal(audit.browserClosed,true);assert.equal(audit.servicePidExitConfirmed,true);
    assert.equal(audit.requestCounterScope,'owned-context-page-requests');
  }
});

test('live lease, non-readonly worker, pending source and failed target readback all fail closed with no sensitive diagnostics',async t=>{
  for(const mode of ['live-lease','write-config','source-pending','target-readback','navigation']) await t.test(mode,async child=>{
    const roots=await workers(child),options=dependencies({leaseFails:mode==='live-lease',changeTargetReadback:mode==='target-readback',navigationFault:mode==='navigation'});
    if(mode==='write-config')await fs.writeFile(path.join(roots.targetRoot,'config/recorder.json'),JSON.stringify({bookId:102,browserBackend:'headless',readOnly:false}));
    if(mode==='source-pending'){await fs.mkdir(path.join(roots.sourceRoot,'data/persistent-executor'),{recursive:true});await fs.writeFile(path.join(roots.sourceRoot,'data/persistent-executor/session.json'),JSON.stringify({schemaVersion:1,bookId:101,pending:{},writeBlocked:true}));}
    await assert.rejects(migrateOwnedSiteLoginCookies({...roots,...options}),error=>!error.message.includes(dummyValue)&&!error.message.includes('incorrect synthetic'));
    if(!['target-readback','navigation'].includes(mode))assert.equal(options.calls.filter(value=>value.type==='launch').length,0);
  });
});

test('an existing encrypted package can be reused for the same explicit pair without reopening the source profile',async t=>{
  const roots=await workers(t),first=dependencies(),result=await migrateOwnedSiteLoginCookies({...roots,...first});
  const second=dependencies(),reused=await migrateOwnedSiteLoginCookies({...roots,...second,reusePackage:result.packagePath});
  assert.equal(reused.reusedEncryptedPackage,true);assert.equal(reused.sourceAudit,null);assert.equal(reused.packagePath,result.packagePath);
  assert.equal(reused.encryptedPackageSha256,result.encryptedPackageSha256);
  assert.equal(second.calls.filter(value=>value.type==='launch').length,2);
  assert.ok(second.calls.filter(value=>value.type==='launch').every(value=>value.profile.startsWith(roots.targetRoot)));
});

test('DPAPI subprocess arguments contain constant entropy/code, input stays in private stdin, and helper window/output errors stay hidden',async()=>{
  let parameters,stdin='';
  const spawnProcess=(command,args,options)=>{
    parameters={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    child.stdin.on('data',chunk=>{stdin+=chunk.toString();});child.stdin.on('finish',()=>{child.stdout.write('ZW5jcnlwdGVk');child.emit('close',0);});return child;
  };
  assert.equal(await transformLoginCookiesDpapi(dummyValue,{platform:'win32',spawnProcess}),'ZW5jcnlwdGVk');
  assert.equal(stdin,dummyValue);assert.equal(parameters.options.windowsHide,true);assert.deepEqual(parameters.options.stdio,['pipe','pipe','pipe']);
  assert.ok(!JSON.stringify(parameters).includes(dummyValue));
  const source=Buffer.from(parameters.args.at(-1),'base64').toString('utf16le');assert.match(source,/CurrentUser/u);assert.ok(source.includes(LOGIN_COOKIE_DPAPI_ENTROPY));assert.doesNotMatch(source,/LocalMachine|WriteAllText|ReadAllText/u);
});

test('real CurrentUser DPAPI protects and restores only a synthetic offline cookie payload',async t=>{
  if(process.platform!=='win32'){t.skip('Windows DPAPI unavailable');return;}
  const text=JSON.stringify({origin:'https://easylearn.baidu.com',cookies:[cookie()],offlineNote:'仅离线样本 Ω'});
  const encrypted=await transformLoginCookiesDpapi(text);assert.ok(!encrypted.includes(dummyValue));
  const restored=await transformLoginCookiesDpapi(encrypted,{decrypt:true});assert.equal(restored,text);
});

test('fresh offline owned Edge profiles persist a DPAPI-migrated synthetic site cookie without navigating', {timeout:60000},async t=>{
  if(process.platform!=='win32'){t.skip('Windows owned Edge fixture unavailable');return;}
  const roots=await workers(t),sourceConfig=JSON.parse(await fs.readFile(path.join(roots.sourceRoot,'config/recorder.json'),'utf8'));
  const profile=await prepareHeadlessProfile(sourceConfig,roots.sourceRoot);
  const options={channel:'msedge',headless:true,serviceWorkers:'block',args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost','--proxy-server=http://127.0.0.1:9']};
  const sourceContext=await chromium.launchPersistentContext(profile,options);await sourceContext.route('**/*',route=>route.abort('blockedbyclient'));
  await sourceContext.addCookies([cookie()]);await sourceContext.close();
  const leaseDirectory=path.join(path.dirname(roots.sourceRoot),'offline-resource-leases');
  const result=await migrateOwnedSiteLoginCookies({...roots,leaseDirectory});
  assert.equal(result.importedCookieCount,1);assert.equal(result.localCookieReadbackVerified,true);assert.equal(result.platformLoginVerified,false);
  assert.equal(result.persistentCookieReadbackVerified,true);assert.equal(result.targetPersistenceAudit.pageNavigationCount,0);assert.equal(result.targetPersistenceAudit.pageRequestCount,0);
  const targetConfig=JSON.parse(await fs.readFile(path.join(roots.targetRoot,'config/recorder.json'),'utf8'));
  const targetProfile=await prepareHeadlessProfile(targetConfig,roots.targetRoot),targetContext=await chromium.launchPersistentContext(targetProfile,options);
  try {await targetContext.route('**/*',route=>route.abort('blockedbyclient'));const found=await targetContext.cookies(['https://easylearn.baidu.com/']);assert.equal(found.filter(value=>value.name==='fixture_session'&&value.value===dummyValue).length,1);}finally{await targetContext.close();}
});
