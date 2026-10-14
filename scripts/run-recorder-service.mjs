import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PersistentRecorderSession} from '../src/persistent-recorder-session.mjs';
import {acquirePersistentLock} from '../src/persistent-recorder-lock.mjs';
import {loadRecorderConfig,writableWorkspacePath,prepareRuntimeDirectory,existingWorkspacePath} from '../src/recorder-config.mjs';
import {connectMcp,safeDiagnosticMessage} from './run-new-system-extension.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function startRecorderService({root=defaultRoot,configPath='config/recorder.json',sessionStatePath='data/persistent-executor/session.json',connect=connectMcp,log=console.log,port}={}){
  root=path.resolve(root);const config=await loadRecorderConfig(root,configPath),directory=path.join(root,'data/persistent-executor');
  const lockPath=path.join(root,'data/new-system-browser/extension-Default.lock');await prepareRuntimeDirectory(root,directory);await prepareRuntimeDirectory(root,path.dirname(lockPath));await writableWorkspacePath(root,lockPath);
  const lease=await acquirePersistentLock(lockPath);const key=randomBytes(32).toString('hex');
  const session=new PersistentRecorderSession({root,bookId:config.bookId,focusMode:config.focusMode,windowMode:config.windowMode,statePath:sessionStatePath,connect:async bridge=>{let connected;await lease.markConnecting();try{connected=await connect(bridge);await lease.updateServicePid(connected.servicePid);return connected;}catch(error){if(error.code==='MCP_EXIT_UNCONFIRMED'&&error.servicePid)await lease.updateServicePid(error.servicePid);else{if(connected)await connected.close();await lease.confirmNoService();}throw error;}}});
  try{await session.initialize();}catch(error){await lease.release();throw error;}
  let shuttingDown=false,heartbeat;const controlFile=path.join(directory,'control.json');
  async function shutdown(){if(shuttingDown)return;shuttingDown=true;try{await writableWorkspacePath(root,lockPath);await writableWorkspacePath(root,controlFile);const closed=await session.close();await lease.confirmNoService();await lease.release();clearInterval(heartbeat);await fs.unlink(controlFile).catch(error=>{if(error.code!=='ENOENT')throw error;});server.close();return closed;}catch(error){shuttingDown=false;throw error;}}
  const server=http.createServer(async(request,response)=>{
    const send=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
    if(request.headers.origin||!/^127\.0\.0\.1:\d+$/u.test(request.headers.host??''))return send(403,{error:'只允许本机命令行控制'});
    const supplied=Buffer.from(request.headers['x-recorder-key']??''),expected=Buffer.from(key);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{error:'本机控制凭据不匹配'});
    try{if(shuttingDown)return send(409,{error:'执行器正在关闭'});if(request.method==='GET'&&request.url==='/health')return send(200,session.snapshot());if(request.method==='GET'&&request.url==='/status')return send(200,await session.status());
      if(request.method!=='POST'||request.url!=='/command'||request.headers['content-type']!=='application/json')return send(404,{error:'无效接口'});
      let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>16384)throw new Error('命令过大');}const command=JSON.parse(body);
      if(command.action==='close'){if(Object.keys(command).some(key=>!['action','args','id'].includes(key))||command.args&&Object.keys(command.args).length)throw new Error('关闭参数无效');return send(200,await shutdown());}
      return send(200,await session.command(command));
    }catch(error){return send(409,{error:safeDiagnosticMessage(error.message),status:session.snapshot()});}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port??config.port,'127.0.0.1',resolve);});}catch(error){await lease.release();throw error;}
  const control={schemaVersion:1,bookId:config.bookId,focusMode:session.focusMode,windowMode:session.windowMode,sessionPath:session.statePath,pid:process.pid,port:server.address().port,key};try{await writableWorkspacePath(root,controlFile);await fs.writeFile(controlFile,JSON.stringify(control));}catch(error){server.close();await lease.release();throw error;}
  heartbeat=setInterval(()=>{if(!shuttingDown&&session.connection&&!session.busy&&session.state.pending)session.status().catch(()=>{});},3000);heartbeat.unref();
  log('常驻执行器已启动：127.0.0.1:'+control.port+'，书 '+config.bookId+'；尚未连接或写入网页。');return {session,server,shutdown,controlFile};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let configPath='config/recorder.json';for(const argument of process.argv.slice(2)){if(!argument.startsWith('--config='))throw new Error('只接受 --config=项目内配置路径');configPath=argument.slice(9);}
  const service=await startRecorderService({configPath});const stop=()=>service.shutdown().catch(error=>console.error(safeDiagnosticMessage(error.message)));process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
