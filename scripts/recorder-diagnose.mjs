import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {diagnoseRecorder} from '../src/recorder-diagnostics.mjs';
import {safeDiagnosticMessage} from './run-new-system-extension.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function main(argv=process.argv.slice(2),{root=defaultRoot,log=console.log}={}){
  if(argv.length>1||argv.length===1&&!argv[0].startsWith('--job='))throw new Error('只接受可选 --job=原命令ID');
  const report=await diagnoseRecorder(root,{jobId:argv[0]?.slice(6)});log(JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(safeDiagnosticMessage(error.message));process.exitCode=1;}
}
