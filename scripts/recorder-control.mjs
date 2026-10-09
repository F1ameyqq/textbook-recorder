import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadRecorderConfig,validateRecorderCommand,existingWorkspacePath,TASK_ACTIONS} from '../src/recorder-config.mjs';
import {summarizeRecorderStatus} from '../src/recorder-status-summary.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function recorderRequest(root,command,{configPath='config/recorder.json',fetchImpl=fetch}={}){
  const config=await loadRecorderConfig(root,configPath),control=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/control.json'),'utf8'));
  if(control.schemaVersion!==1||control.bookId!==config.bookId||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535||!/^[a-f0-9]{64}$/u.test(control.key??''))throw new Error('本地控制文件与当前书籍配置不符');
  const {action}=validateRecorderCommand(command,root),localStatus=action==='status';
  const response=await fetchImpl('http://127.0.0.1:'+control.port+'/'+(localStatus?'status':'command'),{method:localStatus?'GET':'POST',headers:{'x-recorder-key':control.key,...(localStatus?{}:{'Content-Type':'application/json'})},...(localStatus?{}:{body:JSON.stringify(command)}),signal:AbortSignal.timeout(55000)}),value=await response.json();
  if(!response.ok)throw new Error(value.error??'常驻服务调用失败');return value;
}
export async function waitRecorderCommand(root,command,{configPath='config/recorder.json',request=recorderRequest,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,timeoutMs=1800000,pollMs=1000,onProgress=()=>{}}={}){
  if(!TASK_ACTIONS.includes(command.action))throw new Error('--wait 只适用于录入任务');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000||!Number.isSafeInteger(pollMs)||pollMs<1)throw new Error('等待时限无效');
  const {bookId}=await loadRecorderConfig(root,configPath),bound={...command,id:command.id??randomUUID()};validateRecorderCommand(bound,root);
  const started=now();let status=await request(root,bound,{configPath});
  for(;;){
    if(status.bookId!==bookId||status.error)throw new Error(status.error??'执行器书籍不符，停止等待，不重发任务');
    if(status.pending&&status.pending.id!==bound.id)throw new Error('执行器正在处理另一命令，停止等待，不重发任务');
    if(!status.pending){
      if(status.last?.id!==bound.id||status.last.terminal!==true)throw new Error('缺少本命令终止证明，保留进度，不重发任务');
      return status;
    }
    onProgress(summarizeRecorderStatus(status));
    if(now()-started>=timeoutMs)throw new Error('等待超时；原任务和进度保留，请查 status，不重发任务');
    await pause(Math.min(pollMs,Math.max(1,timeoutMs-(now()-started))));
    status=await request(root,{action:'status'},{configPath});
  }
}

export async function main(argv=process.argv.slice(2),{root=defaultRoot,log=console.log,request=recorderRequest,pause,now=Date.now}={}){
  const positional=[],options={configPath:'config/recorder.json',details:false,wait:false,timeoutMs:1800000};const seen=new Set();
  for(const argument of argv){
    const flag=argument.split('=')[0];
    if(argument.startsWith('--')){
      if(seen.has(flag))throw new Error('命令选项重复');seen.add(flag);
      if(argument.startsWith('--config='))options.configPath=argument.slice(9);
      else if(argument==='--summary')options.details=false;
      else if(argument==='--details')options.details=true;
      else if(argument==='--wait')options.wait=true;
      else if(argument.startsWith('--timeout-ms='))options.timeoutMs=Number(argument.slice(13));
      else throw new Error('未知控制选项');
    }else positional.push(argument);
  }
  if(seen.has('--summary')&&seen.has('--details'))throw new Error('--summary 与 --details 不能同时使用');
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>3600000||seen.has('--timeout-ms')&&!options.wait)throw new Error('--timeout-ms 需要 --wait，范围为 1–3600000');
  if(positional.length>2)throw new Error('用法：recorder-control.mjs status|connect-status|probe|collect|pause|close|readback|reconcile [args.json]');
  const [requested='status',argsPath]=positional,action=requested==='connect-status'?'status':requested,args=argsPath?JSON.parse(await fs.readFile(await existingWorkspacePath(root,argsPath),'utf8')):{};
  // A POST status explicitly requests the initial browser connection; GET does not.
  const config=await loadRecorderConfig(root,options.configPath),control=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/control.json'),'utf8'));
  if(control.schemaVersion!==1||control.bookId!==config.bookId||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535||!/^[a-f0-9]{64}$/u.test(control.key??''))throw new Error('控制配置无效');
  const command={action,args};validateRecorderCommand(command,root);
  if(options.wait&&!TASK_ACTIONS.includes(action))throw new Error('--wait 只适用于录入任务');
  const output=value=>log(JSON.stringify(options.details?value:summarizeRecorderStatus(value),null,2));
  if(requested==='connect-status'){
    const response=await fetch('http://127.0.0.1:'+control.port+'/command',{method:'POST',headers:{'x-recorder-key':control.key,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(55000)}),value=await response.json();output(value);if(!response.ok)process.exitCode=1;return value;
  }
  let lastProgressAt=now();
  const value=options.wait?await waitRecorderCommand(root,command,{...options,request,pause,now,onProgress:summary=>{if(now()-lastProgressAt>=15000){output(summary);lastProgressAt=now();}}}):await request(root,command,options);
  output(value);
  const terminal=value.last?.terminal?value.last:null;
  if(value.error||terminal&&(terminal.error||terminal.evidenceError||value.writeBlocked||terminal.result?.uncertain===true||terminal.result?.comparison?.ok===false))process.exitCode=1;
  return value;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
