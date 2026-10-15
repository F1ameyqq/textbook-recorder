import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { loadRecorderConfig, PLATFORM_ORIGIN, existingWorkspacePath, writableWorkspacePath, prepareRuntimeDirectory } from './recorder-config.mjs';
import { prepareHeadlessProfile } from './recorder-browser-profile.mjs';
import { acquireRecorderResourceLease } from './recorder-resource-lease.mjs';

export const LOGIN_COOKIE_DPAPI_ENTROPY = 'textbook-recorder/site-login-cookies/v1';
const COOKIE_URLS = [PLATFORM_ORIGIN+'/', PLATFORM_ORIGIN+'/edu-shop-web/', PLATFORM_ORIGIN+'/edushop/', PLATFORM_ORIGIN+'/edushop/textbook/detail/shitilist'];
const limit = 2 * 1024 * 1024;
const failure = () => new Error('本机登录 cookie 迁移失败；未输出认证值，请保留原 profile 和加密包');
const sha = value => createHash('sha256').update(value).digest('hex');
const applicable = cookie => {
  const domain = typeof cookie?.domain === 'string' ? cookie.domain.replace(/^\./u, '').toLowerCase() : '';
  return ['easylearn.baidu.com', 'baidu.com'].includes(domain);
};

export function validateSiteCookies(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000 || Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) throw failure();
  const allowed = new Set(['name','value','domain','path','expires','httpOnly','secure','sameSite','partitionKey']);
  const identities = new Set();
  for (const cookie of value) {
    if (!cookie || Object.keys(cookie).some(key => !allowed.has(key)) || !applicable(cookie)
        || typeof cookie.name !== 'string' || !cookie.name || cookie.name.length > 256
        || typeof cookie.value !== 'string' || cookie.value.length > 65536
        || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')
        || !Number.isFinite(cookie.expires) || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean'
        || !['Strict','Lax','None'].includes(cookie.sameSite)
        || cookie.partitionKey !== undefined && typeof cookie.partitionKey !== 'string') throw failure();
    const identity = JSON.stringify([cookie.name,cookie.domain,cookie.path,cookie.partitionKey??null]);
    if (identities.has(identity)) throw failure(); identities.add(identity);
  }
  return value;
}

/** Private stdin/stdout only; process arguments contain constant code and entropy. */
export function transformLoginCookiesDpapi(input, { decrypt = false, platform = process.platform, spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', timeoutMs = 10000 } = {}) {
  if (platform !== 'win32' || typeof input !== 'string' || !input || Buffer.byteLength(input,'utf8') > limit * 2) throw failure();
  const source = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$bytes=$null
try {
  Add-Type -AssemblyName System.Security
  $entropy=[Text.Encoding]::UTF8.GetBytes('${LOGIN_COOKIE_DPAPI_ENTROPY}')
  ${decrypt ? "$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())\n  $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)\n  try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))}finally{[Array]::Clear($plain,0,$plain.Length)}" : "$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())\n  $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)\n  [Console]::Out.Write([Convert]::ToBase64String($cipher))"}
} catch { [Console]::Error.Write('DPAPI operation failed');exit 1 }
finally {if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)}}`;
  const command = path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const args = ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];
  return new Promise((resolve,reject) => {
    let child, output=Buffer.alloc(0), settled=false, timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);output.fill(0);if(error)reject(failure());else resolve(result);};
    try { child=spawnProcess(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}); } catch { finish(true);return; }
    child.stdout.on('data',chunk=>{const next=Buffer.concat([output,Buffer.from(chunk)]);output.fill(0);output=next;if(output.length>limit*2){child.kill();finish(true);}});
    child.stderr.on('data',()=>{});
    for(const stream of [child.stdout,child.stderr,child.stdin])stream.on('error',()=>finish(true));
    child.on('error',()=>finish(true));
    child.on('close',code=>{if(settled)return;const result=output.toString('utf8');if(code!==0||!result)finish(true);else finish(false,result);});
    timer=setTimeout(()=>{child.kill();finish(true);},timeoutMs);
    child.stdin.end(input);
  });
}

async function requireIdle(root,config) {
  try {
    const state=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/session.json'),'utf8'));
    if(state.schemaVersion!==1||state.bookId!==config.bookId||state.pending!==null||state.writeBlocked!==false||state.blockedContext!==null
      ||state.browserBackend!=='headless'||state.browserProfileDir!==config.browserProfileDir||(state.readOnly??false)!==(config.readOnly??false))throw failure();
  } catch(error) { if(error.code!=='ENOENT')throw failure(); }
}

async function withOwnedAuthenticationProfile(root,config,operation,{launch,acquireLease,leaseDirectory}={}) {
  await requireIdle(root,config);
  const lease=await acquireLease(config,root,{...(leaseDirectory?{leaseDirectory}:{})});
  let context,launched=false,closed=false;
  try {
    await requireIdle(root,config);
    const profile=await prepareHeadlessProfile(config,root);
    await lease.markConnecting();launched=true;
    context=await launch(profile,{channel:'msedge',headless:true,serviceWorkers:'block',args:[
      '--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run',
      '--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost','--proxy-server=http://127.0.0.1:9']});
    const audit={requestCounterScope:'owned-context-page-requests',pageObservationStartedAt:new Date().toISOString(),pageNavigationCount:0,pageRequestCount:0,blockedPageRequestCount:0,
      allPagesInitiallyAboutBlank:false,allPagesFinallyAboutBlank:false,browserClosed:false,servicePidExitConfirmed:false};
    const watched=new Set();
    const watch=page=>{if(watched.has(page))return;watched.add(page);page.on('framenavigated',()=>{audit.pageNavigationCount++;});};
    context.on('page',watch);context.on('request',()=>{audit.pageRequestCount++;});
    await context.route('**/*',async route=>{audit.blockedPageRequestCount++;await route.abort('blockedbyclient');});
    const pages=context.pages();if(!pages.length||pages.some(page=>page.url()!=='about:blank'))throw failure();
    for(const page of pages)watch(page);audit.allPagesInitiallyAboutBlank=true;audit.pageCountAtStart=pages.length;
    const browser=context.browser();if(!browser||!browser.isConnected())throw failure();
    const session=await browser.newBrowserCDPSession();
    try {const proof=await session.send('SystemInfo.getProcessInfo'),own=proof.processInfo?.filter(value=>value.type==='browser'&&Number.isSafeInteger(value.id)&&value.id>0);if(own?.length!==1)throw failure();audit.ownedBrowserPid=own[0].id;await lease.updateServicePid(own[0].id);}finally{await session.detach();}
    audit.pageOperationStartedAt=new Date().toISOString();const result=await operation(context);audit.pageOperationFinishedAt=new Date().toISOString();
    const finalPages=context.pages();audit.pageCountAtEnd=finalPages.length;
    if(!finalPages.length||finalPages.some(page=>page.url()!=='about:blank')||audit.pageNavigationCount!==0||audit.pageRequestCount!==audit.blockedPageRequestCount)throw failure();
    audit.allPagesFinallyAboutBlank=true;
    await context.close();
    const deadline=Date.now()+5000;
    while(browser.isConnected()){if(Date.now()>=deadline)throw failure();await new Promise(resolve=>setTimeout(resolve,50));}
    for(;;){try{await lease.confirmNoService();break;}catch{if(Date.now()>=deadline)throw failure();await new Promise(resolve=>setTimeout(resolve,50));}}
    closed=true;audit.browserClosed=true;audit.servicePidExitConfirmed=true;audit.browserClosedAt=new Date().toISOString();const released=await lease.release();if(released.released!==true)throw failure();
    return {value:result,audit};
  } catch {
    if(context&&!closed){try{await context.close();await lease.confirmNoService();closed=true;}catch{}}
    if(closed||!launched){try{await lease.release();}catch{}}
    throw failure();
  }
}

/** Source must be an owned read-only headless worker. A different-book write
 * target requires explicit opt-in and keeps its real profile/session identity.
 * No browser navigation, Default profile, localStorage or run state is copied. */
export async function migrateOwnedSiteLoginCookies({ sourceRoot,targetRoot,
  launch=(profile,options)=>chromium.launchPersistentContext(profile,options),acquireLease=acquireRecorderResourceLease,
  protect=text=>transformLoginCookiesDpapi(text),unprotect=text=>transformLoginCookiesDpapi(text,{decrypt:true}),leaseDirectory,reusePackage,allowWriteTarget=false }={}) {
  let payload,cookies;
  try {
    if(typeof sourceRoot!=='string'||typeof targetRoot!=='string'||typeof allowWriteTarget!=='boolean')throw failure();
    sourceRoot=await fs.realpath(sourceRoot);targetRoot=await fs.realpath(targetRoot);
    const source=await loadRecorderConfig(sourceRoot),target=await loadRecorderConfig(targetRoot);
    if(sourceRoot===targetRoot||source.bookId===target.bookId||source.browserBackend!=='headless'||target.browserBackend!=='headless'
        ||source.readOnly!==true||target.readOnly!==true&&!allowWriteTarget||source.browserProfileDir===target.browserProfileDir)throw failure();
    // Export only an already-registered source profile, never adopt a browser.
    await existingWorkspacePath(sourceRoot,path.join(source.browserProfileDir,'.recorder-profile.json'));
    await prepareHeadlessProfile(source,sourceRoot);
    await requireIdle(sourceRoot,source);await requireIdle(targetRoot,target);
    let sourceAudit=null,packagePath,bytes,ciphertext;
    if(reusePackage!==undefined){
      packagePath=await existingWorkspacePath(sourceRoot,reusePackage);
      const relative=path.relative(path.join(sourceRoot,'data/login-cookies'),packagePath);
      if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure();
      bytes=await fs.readFile(packagePath);if(bytes.length>limit*2)throw failure();
      const envelope=JSON.parse(bytes);
      if(envelope.schemaVersion!==1||envelope.kind!=='textbook-site-login-cookies'||envelope.algorithm!=='windows-dpapi'||envelope.scope!=='CurrentUser')throw failure();
      ciphertext=envelope.ciphertext;
    }else{
      const exported=await withOwnedAuthenticationProfile(sourceRoot,source,async context=>validateSiteCookies(await context.cookies(COOKIE_URLS)),{launch,acquireLease,leaseDirectory});
      cookies=exported.value;sourceAudit=exported.audit;
      const metadata={origin:PLATFORM_ORIGIN,sourceBookId:source.bookId,targetBookId:target.bookId,cookieCount:cookies.length,cookies:cookies.map(({name,domain,path})=>({name,domain,path}))};
      payload=JSON.stringify({schemaVersion:1,kind:'textbook-site-login-cookies',origin:PLATFORM_ORIGIN,sourceBookId:source.bookId,targetBookId:target.bookId,cookies});
      ciphertext=await protect(payload);
      if(typeof ciphertext!=='string'||!ciphertext||ciphertext.length>limit*2||!/^[A-Za-z0-9+/=]+$/u.test(ciphertext))throw failure();
      const directory=await prepareRuntimeDirectory(sourceRoot,path.join(sourceRoot,'data/login-cookies'));
      packagePath=await writableWorkspacePath(sourceRoot,path.join(directory,'site-'+target.bookId+'-'+randomUUID()+'.dpapi.json'));
      const envelope={schemaVersion:1,kind:'textbook-site-login-cookies',algorithm:'windows-dpapi',scope:'CurrentUser',createdAt:new Date().toISOString(),...metadata,ciphertext};
      bytes=Buffer.from(JSON.stringify(envelope,null,2),'utf8');await fs.writeFile(packagePath,bytes,{flag:'wx'});
    }
    if(typeof ciphertext!=='string'||!ciphertext||ciphertext.length>limit*2||!/^[A-Za-z0-9+/=]+$/u.test(ciphertext))throw failure();
    payload=await unprotect(ciphertext);let imported;try{imported=JSON.parse(payload);}catch{throw failure();}
    if(imported.schemaVersion!==1||imported.kind!=='textbook-site-login-cookies'||imported.origin!==PLATFORM_ORIGIN||imported.sourceBookId!==source.bookId||imported.targetBookId!==target.bookId)throw failure();
    const selected=validateSiteCookies(imported.cookies);
    const targetOperation=await withOwnedAuthenticationProfile(targetRoot,target,async context=>{
      await context.addCookies(selected);
      const reread=validateSiteCookies(await context.cookies(COOKIE_URLS));
      if(selected.some(cookie=>!reread.some(value=>value.name===cookie.name&&value.domain===cookie.domain&&value.path===cookie.path&&value.value===cookie.value
        &&value.httpOnly===cookie.httpOnly&&value.secure===cookie.secure&&value.sameSite===cookie.sameSite
        &&value.expires===cookie.expires&&(value.partitionKey??null)===(cookie.partitionKey??null))))throw failure();
    },{launch,acquireLease,leaseDirectory});
    const persistent=selected.filter(cookie=>cookie.expires!==-1);
    const persisted=await withOwnedAuthenticationProfile(targetRoot,target,async context=>{
      const reread=await context.cookies(COOKIE_URLS);
      if(persistent.some(cookie=>!reread.some(value=>value.name===cookie.name&&value.domain===cookie.domain&&value.path===cookie.path
          &&value.value===cookie.value&&value.expires===cookie.expires&&(value.partitionKey??null)===(cookie.partitionKey??null))))throw failure();
    },{launch,acquireLease,leaseDirectory});
    const metadata={origin:PLATFORM_ORIGIN,sourceBookId:source.bookId,targetBookId:target.bookId,cookieCount:selected.length,cookies:selected.map(({name,domain,path})=>({name,domain,path}))};
    return {...metadata,sourceReadOnly:true,targetReadOnly:target.readOnly===true,writeTargetExplicitlyAllowed:allowWriteTarget,
      packagePath,encryptedPackageSha256:sha(bytes),reusedEncryptedPackage:reusePackage!==undefined,importedCookieCount:selected.length,
      persistentCookieCount:persistent.length,sessionCookieCount:selected.length-persistent.length,localCookieReadbackVerified:true,persistentCookieReadbackVerified:true,
      sourceAudit,targetAudit:targetOperation.audit,targetPersistenceAudit:persisted.audit,platformLoginVerified:false};
  } catch { throw failure(); }
  finally {payload=null;cookies=null;}
}
