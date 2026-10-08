import fs from 'node:fs/promises';
import path from 'node:path';
export function pidAlive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }

/** A dead supervisor does not free the original-browser writer while its child lives. */
export async function acquirePersistentLock(filename, { alive = pidAlive, pid = process.pid } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive:true });
  let handle;
  try { handle = await fs.open(filename, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw new Error('浏览器运行锁无效，请检查正在运行的执行器'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || previous.unconfirmedService === true || alive(previous.pid) || alive(previous.servicePid)) throw new Error('原浏览器仍有执行器或子服务退出未确认，禁止第二个写入器');
    await fs.unlink(filename); handle = await fs.open(filename, 'wx');
  }
  let details = {pid,servicePid:null,unconfirmedService:false,kind:'persistent-recorder'};
  const save = async () => { await handle.truncate(0); await handle.write(JSON.stringify(details), 0, 'utf8'); await handle.sync(); };
  await save();
  return {
    markConnecting:async () => { details.unconfirmedService = true; await save(); },
    updateServicePid:async servicePid => { if (!Number.isSafeInteger(servicePid) || servicePid <= 0) throw new Error('子服务PID无效'); details.servicePid = servicePid; details.unconfirmedService = false; await save(); },
    confirmNoService:async () => { if (alive(details.servicePid)) throw new Error('子服务尚未退出'); details.servicePid = null; details.unconfirmedService = false; await save(); },
    release:async () => { if (details.unconfirmedService || alive(details.servicePid)) throw new Error('子服务尚未确认退出，保留浏览器运行锁'); await handle.close(); await fs.unlink(filename); },
  };
}
