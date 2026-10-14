import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRecorderFleet, controlRecorderFleet } from '../src/recorder-fleet.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function main(argv = process.argv.slice(2), { root = defaultRoot, log = console.log, plan = planRecorderFleet, control = controlRecorderFleet } = {}) {
  const [action = 'plan', ...args] = argv, options = {}, seen = new Set();
  if (!['plan', 'start', 'status', 'pause'].includes(action)) throw new Error('用法：recorder-fleet.mjs plan|start|status|pause --fleet=配置.json [--book=name|--all] [--remote]');
  for (const argument of args) {
    const key = argument.split('=')[0];
    if (seen.has(key)) throw new Error('fleet 选项重复'); seen.add(key);
    if (argument.startsWith('--fleet=')) options.fleetPath = argument.slice(8);
    else if (argument.startsWith('--book=')) options.book = argument.slice(7);
    else if (argument === '--all') options.all = true;
    else if (argument === '--remote') options.remote = true;
    else throw new Error('未知 fleet 选项');
  }
  if (!options.fleetPath || options.book === '' || options.remote && action !== 'status' || action === 'plan' && (options.book !== undefined || options.all) || options.all && options.book !== undefined) throw new Error('须指定 --fleet；plan 只检查隔离，--remote 仅适用于 status');
  const prepared = await plan(root, options.fleetPath), result = action === 'plan' ? prepared : await control(prepared, action, options);
  log(JSON.stringify(result, null, 2)); if (result.ok === false) process.exitCode = 1; return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
