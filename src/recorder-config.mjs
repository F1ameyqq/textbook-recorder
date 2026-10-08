import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';

export const PLATFORM_ORIGIN='https://easylearn.baidu.com';
export const TASK_ACTIONS=['probe','verify','execute','readback','reconcile'];
export const CONTROL_ACTIONS=[...TASK_ACTIONS,'pause','close','status'];
function withinWorkspace(root,candidate,allowRoot=false){
  const relative=path.relative(root,candidate);
  return (allowRoot||relative!=='')&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
function assertCanonicalPath(root,candidate,allowRoot=false){
  if(!withinWorkspace(root,candidate,allowRoot))throw new Error('文件必须位于执行器项目内');
  return candidate;
}
function workspaceEntryPath(root,file,allowRoot=false){
  if(typeof file!=='string'||!file||file.includes('\0'))throw new Error('文件路径无效');
  const lexicalRoot=path.resolve(root),full=path.resolve(lexicalRoot,file);
  let canonicalRoot;
  try{canonicalRoot=realpathSync.native(lexicalRoot);}catch(error){if(error.code!=='ENOENT')throw error;canonicalRoot=lexicalRoot;}
  if(withinWorkspace(lexicalRoot,full,allowRoot))return path.resolve(canonicalRoot,path.relative(lexicalRoot,full));
  return assertCanonicalPath(canonicalRoot,full,allowRoot);
}
export function workspacePath(root,file){return workspaceEntryPath(root,file);}
export async function existingWorkspacePath(root,file){
  const entry=workspacePath(root,file),canonicalRoot=await fs.realpath(root),full=await fs.realpath(entry);
  return assertCanonicalPath(canonicalRoot,full);
}
export async function existingWorkspaceDirectory(root,directory){
  const entry=workspaceEntryPath(root,directory,true),canonicalRoot=await fs.realpath(root),resolved=await fs.realpath(entry);
  assertCanonicalPath(canonicalRoot,resolved,true);
  if(!(await fs.stat(resolved)).isDirectory())throw new Error('baseDir 必须是项目内目录');
  return resolved;
}
export async function writableWorkspacePath(root,file){
  const full=workspacePath(root,file),canonicalRoot=await fs.realpath(root);
  let parent=path.dirname(full),canonicalParent;
  while(true){
    try{canonicalParent=await fs.realpath(parent);assertCanonicalPath(canonicalRoot,canonicalParent,true);break;}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      let exists=false;try{await fs.lstat(parent);exists=true;}catch(statError){if(statError.code!=='ENOENT')throw statError;}
      if(exists)throw new Error('运行目录链接无法解析，拒绝写入');
      const next=path.dirname(parent);if(next===parent)throw error;parent=next;
    }
  }
  let exists=false;try{await fs.lstat(full);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists){
    let existing;try{existing=await fs.realpath(full);}catch{throw new Error('运行文件链接无法解析，拒绝写入');}
    return assertCanonicalPath(canonicalRoot,existing);
  }
  return assertCanonicalPath(canonicalRoot,path.resolve(canonicalParent,path.relative(parent,full)));
}
export async function prepareRuntimeDirectory(root,directory){const full=path.resolve(root,directory);await writableWorkspacePath(root,path.join(full,'.recorder-path-check'));await fs.mkdir(full,{recursive:true});return existingWorkspaceDirectory(root,full);}
export function validateRecorderConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['schemaVersion','bookId','port','origin','inputMode'].includes(key)))throw new Error('录题配置字段无效');
  if(value.schemaVersion!==undefined&&value.schemaVersion!==1)throw new Error('录题配置版本无效');
  if(!Number.isSafeInteger(value.bookId)||value.bookId<=0)throw new Error('config/recorder.json 必须显式指定正整数 bookId');
  const port=value.port??8789;
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('port 必须为 1–65535');
  if(value.origin!==undefined&&value.origin!==PLATFORM_ORIGIN)throw new Error('只支持指定的录题平台 origin');
  if(value.inputMode!==undefined&&value.inputMode!=='browser-command')throw new Error('共享执行器只使用 browser-command 输入模式');
  return {schemaVersion:1,bookId:value.bookId,port,origin:PLATFORM_ORIGIN,inputMode:'browser-command'};
}
export async function loadRecorderConfig(root,configPath='config/recorder.json'){
  let file;try{file=await existingWorkspacePath(root,configPath);return {...validateRecorderConfig(JSON.parse(await fs.readFile(file,'utf8'))),configPath:file};}
  catch(error){if(error.code==='ENOENT')throw new Error('缺少本地 config/recorder.json；先复制示例并填写自己的 bookId');throw error;}
}
export function recorderBookUrl(bookId){if(!Number.isSafeInteger(bookId)||bookId<=0)throw new Error('bookId 必须显式指定');return PLATFORM_ORIGIN+'/edu-shop-web/#/content-manager/teaching-content?textbookID='+bookId+'&textbookType=main';}
export function assertRecorderPage(urlText,bookId){
  const url=new URL(urlText),parts=url.hash.split('?'),query=new URLSearchParams(parts[1]);
  if(url.origin!==PLATFORM_ORIGIN||url.username||url.password||url.pathname!=='/edu-shop-web/'||parts.length!==2||parts[0]!=='#/content-manager/teaching-content'||query.getAll('textbookID').length!==1||query.get('textbookID')!==String(bookId)||query.getAll('textbookType').length!==1||query.get('textbookType')!=='main')throw new Error('当前页不是本地配置指定的书籍录入页');
}
export function validateRecorderCommand(command,root){
  if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).some(key=>!['id','action','args'].includes(key)))throw new Error('只接受固定命令，不允许任意脚本');
  const {action,args={}}=command;
  if(!CONTROL_ACTIONS.includes(action)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('命令或参数无效');
  const allowed=action==='probe'?['chapterLabel','sectionLabel','inventory','exportRecords']:['status','pause','close'].includes(action)?[]:['manifest','state',...(['execute','verify'].includes(action)?['limit']:['taskId']),...(action==='readback'?['capture']:[]),...(action==='reconcile'?['pendingPath']:[])];
  if(Object.keys(args).some(key=>!allowed.includes(key)))throw new Error('命令参数无效，不接受专项修复或代码参数');
  if(action==='probe'){
    if(args.inventory!==undefined&&typeof args.inventory!=='boolean'||args.exportRecords!==undefined&&typeof args.exportRecords!=='boolean')throw new Error('盘点参数必须为布尔值');
    if(Boolean(args.chapterLabel)!==Boolean(args.sectionLabel)||args.chapterLabel!==undefined&&(typeof args.chapterLabel!=='string'||!args.chapterLabel.trim()||typeof args.sectionLabel!=='string'||!args.sectionLabel.trim()))throw new Error('单节盘点需完整章/节名称');
    if(args.inventory&&(args.chapterLabel||args.exportRecords)||args.exportRecords&&!args.sectionLabel)throw new Error('盘点参数冲突');
  }else if(TASK_ACTIONS.includes(action)){
    if(typeof args.manifest!=='string')throw new Error('必须指定已审题单 manifest');
    if(['readback','reconcile'].includes(action)&&(typeof args.taskId!=='string'||!args.taskId))throw new Error('必须指定原题单 taskId');
    if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>1000))throw new Error('limit 必须为 1–1000');
    if(args.capture!==undefined&&typeof args.capture!=='boolean')throw new Error('capture 必须为布尔值');
  }
  for(const field of ['manifest','state','pendingPath'])if(args[field]!==undefined)workspacePath(root,args[field]);
  if(command.id!==undefined&&!/^[A-Za-z0-9_-]{1,80}$/u.test(command.id))throw new Error('命令 ID 无效');
  return {action,args};
}
