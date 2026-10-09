import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {pidAlive} from '../src/persistent-recorder-lock.mjs';
import {loadRecorderConfig,existingWorkspacePath,writableWorkspacePath,prepareRuntimeDirectory} from '../src/recorder-config.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pauseDefault=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function controller(root){
  try{
    const control=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/control.json'),'utf8'));
    if(control.schemaVersion!==1||!Number.isSafeInteger(control.bookId)||!Number.isSafeInteger(control.pid)||control.pid<1||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535||!/^[a-f0-9]{64}$/u.test(control.key??''))throw new Error('本地服务控制文件无效，保留文件并检查');
    return control;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

/** Starts only the local supervisor. Browser connection is lazy and task dispatch is separate. */
export async function ensureRecorderService(root=defaultRoot,{configPath='config/recorder.json',sessionPath='data/persistent-executor/session.json',serviceScript='scripts/run-recorder-service.mjs',serviceArgs,spawnProcess=spawn,alive=pidAlive,fetchImpl=fetch,pause=pauseDefault,now=Date.now,timeoutMs=10000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('后台服务启动时限必须为 1–60000 毫秒');
  const config=await loadRecorderConfig(root,configPath),expectedSession=await writableWorkspacePath(root,sessionPath),directory=path.join(root,'data/persistent-executor');
  const health=async(control)=>{
    if(control.bookId!==config.bookId||control.port!==config.port||control.sessionPath!==expectedSession)throw new Error('现有服务与书籍、端口或原会话不符，不另启写入器');
    const response=await fetchImpl('http://127.0.0.1:'+control.port+'/health',{headers:{'x-recorder-key':control.key,connection:'close'},signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('已有服务无法通过本地身份检查，不另启写入器');
    const value=await response.json();
    if(value.bookId!==config.bookId||value.sessionPath!==expectedSession)throw new Error('本地服务健康检查身份不符，不另启写入器');
    return {bookId:config.bookId,pid:control.pid,port:control.port,sessionPath:expectedSession,reused:true,connection:value.connection,pending:value.pending?{id:value.pending.id,action:value.pending.action}:null,writeBlocked:value.writeBlocked};
  };
  const previous=await controller(root);
  if(previous&&alive(previous.pid))return health(previous);
  await prepareRuntimeDirectory(root,directory);
  const script=await existingWorkspacePath(root,serviceScript);if(path.extname(script)!=='.mjs')throw new Error('服务入口必须是本项目的 mjs 文件');
  const stdoutPath=await writableWorkspacePath(root,path.join(directory,'service.stdout.log')),stderrPath=await writableWorkspacePath(root,path.join(directory,'service.stderr.log'));
  const stdout=await fs.open(stdoutPath,'a'),stderr=await fs.open(stderrPath,'a');let child;
  try{child=spawnProcess(process.execPath,[script,...(serviceArgs??['--config='+config.configPath])],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});}
  finally{await stdout.close();await stderr.close();}
  let launchError;child.on('error',error=>{launchError=error;});child.unref();
  const started=now();
  for(;;){
    if(launchError||child.exitCode!==null&&child.exitCode!==undefined)throw new Error('后台服务启动失败；查看本地 service.stderr.log，不重复启动');
    const control=await controller(root);
    if(control?.pid===child.pid){
      let result;
      try{result=await health(control);}
      catch(error){
        // A just-closed service can leave an old HTTP socket in the caller's pool.
        // Recheck only this exact new child once; never spawn another supervisor.
        if(now()-started>=timeoutMs||!alive(child.pid))throw error;
        await pause(100);const fresh=await controller(root);
        if(fresh?.pid!==child.pid||fresh.key!==control.key)throw error;
        result=await health(fresh);
      }
      return {...result,reused:false};
    }
    if(now()-started>=timeoutMs)throw new Error('后台服务启动等待超时；保留进程和证据，先检查本地状态，不重复启动');
    await pause(100);
  }
}

export async function main(argv=process.argv.slice(2),{root=defaultRoot,log=console.log}={}){
  if(argv.length>1||argv.length===1&&!argv[0].startsWith('--config='))throw new Error('只接受 --config=项目内配置路径');
  const result=await ensureRecorderService(root,{configPath:argv[0]?.slice(9)??'config/recorder.json'});log(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
