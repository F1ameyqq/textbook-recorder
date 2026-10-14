import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateOwnedSiteLoginCookies} from '../src/login-cookie-migration.mjs';

export async function main(argv=process.argv.slice(2),{migrate=migrateOwnedSiteLoginCookies,log=console.log}={}){
  const values={};
  for(const argument of argv){const match=argument.match(/^--(source-root|target-root|reuse-package)=(.+)$/u);if(!match||values[match[1]]!==undefined)throw new Error('仅接受显式 --source-root=目录 --target-root=目录 和可选 --reuse-package=源项目内加密包');values[match[1]]=match[2];}
  if(!values['source-root']||!values['target-root'])throw new Error('必须明确两个独立教材 worker 目录');
  const metadata=await migrate({sourceRoot:values['source-root'],targetRoot:values['target-root'],...(values['reuse-package']?{reusePackage:values['reuse-package']}:{})});
  log(JSON.stringify(metadata,null,2));return metadata;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch{console.error('本机登录 cookie 迁移未确认完成；保留 profile 和加密包，未输出认证值。');process.exitCode=1;}
}
