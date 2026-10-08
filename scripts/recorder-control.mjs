import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRecorderConfig,validateRecorderCommand,existingWorkspacePath} from '../src/recorder-config.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function recorderRequest(root,command,{configPath='config/recorder.json',fetchImpl=fetch}={}){
  const config=await loadRecorderConfig(root,configPath),control=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/control.json'),'utf8'));
  if(control.schemaVersion!==1||control.bookId!==config.bookId||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535||!/^[a-f0-9]{64}$/u.test(control.key??''))throw new Error('本地控制文件与当前书籍配置不符');
  const {action}=validateRecorderCommand(command,root),localStatus=action==='status';
  const response=await fetchImpl('http://127.0.0.1:'+control.port+'/'+(localStatus?'status':'command'),{method:localStatus?'GET':'POST',headers:{'x-recorder-key':control.key,...(localStatus?{}:{'Content-Type':'application/json'})},...(localStatus?{}:{body:JSON.stringify(command)}),signal:AbortSignal.timeout(55000)}),value=await response.json();
  if(!response.ok)throw new Error(value.error??'常驻服务调用失败');return value;
}
export async function main(argv=process.argv.slice(2),{root=defaultRoot,log=console.log}={}){
  const positional=[],options={configPath:'config/recorder.json'};for(const argument of argv){if(argument.startsWith('--config='))options.configPath=argument.slice(9);else positional.push(argument);}
  if(positional.length>2)throw new Error('用法：recorder-control.mjs status|connect-status|probe|pause|close|readback|reconcile [args.json]');
  const [requested='status',argsPath]=positional,action=requested==='connect-status'?'status':requested,args=argsPath?JSON.parse(await fs.readFile(await existingWorkspacePath(root,argsPath),'utf8')):{};
  // A POST status explicitly requests the initial browser connection; GET does not.
  const config=await loadRecorderConfig(root,options.configPath),control=JSON.parse(await fs.readFile(await existingWorkspacePath(root,'data/persistent-executor/control.json'),'utf8'));
  if(control.schemaVersion!==1||control.bookId!==config.bookId||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535||!/^[a-f0-9]{64}$/u.test(control.key??''))throw new Error('控制配置无效');
  const command={action,args};validateRecorderCommand(command,root);
  if(requested==='connect-status'){
    const response=await fetch('http://127.0.0.1:'+control.port+'/command',{method:'POST',headers:{'x-recorder-key':control.key,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(55000)}),value=await response.json();log(JSON.stringify(value,null,2));if(!response.ok)process.exitCode=1;return value;
  }
  const value=await recorderRequest(root,command,options);log(JSON.stringify(value,null,2));return value;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
