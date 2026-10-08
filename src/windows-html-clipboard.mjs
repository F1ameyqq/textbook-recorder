import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/windows-html-clipboard.ps1', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function windowsClipboardHelperLaunch() {
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', helper], options: { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } };
}

/** Windows CF_HTML offsets count UTF-8 bytes, rather than JS characters. */
export function encodeWindowsClipboardHtml(html) {
  if (typeof html !== 'string' || !html.trim() || html.includes('\0')) throw new Error('Clipboard HTML must be nonempty and contain no NUL');
  const headerTemplate = 'Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n';
  const prefix = '<html><body><!--StartFragment-->';
  const suffix = '<!--EndFragment--></body></html>';
  const startHTML = Buffer.byteLength(headerTemplate, 'utf8');
  const startFragment = startHTML + Buffer.byteLength(prefix, 'utf8');
  const endFragment = startFragment + Buffer.byteLength(html, 'utf8');
  const endHTML = endFragment + Buffer.byteLength(suffix, 'utf8');
  if (endHTML > 9999999999) throw new Error('Clipboard HTML too large');
  const offsets = { StartHTML: startHTML, EndHTML: endHTML, StartFragment: startFragment, EndFragment: endFragment };
  let header = headerTemplate;
  for (const [name, value] of Object.entries(offsets)) header = header.replace(`${name}:0000000000`, `${name}:${String(value).padStart(10, '0')}`);
  return Buffer.from(header + prefix + html + suffix + '\0', 'utf8');
}

/** Own payload only: helper never exports the user's previous clipboard. */
export async function writeWindowsClipboardHtml({ html, text }, { timeoutMs = 10000 } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows clipboard requires Windows');
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('Clipboard text must be a string without NUL');
  const htmlBytes = encodeWindowsClipboardHtml(html);
  const textBytes = Buffer.from(text + '\0', 'utf16le');
  const expected = { htmlSha256: hash(htmlBytes), textSha256: hash(textBytes), htmlBytes: htmlBytes.length, textBytes: textBytes.length };
  const input = JSON.stringify({ htmlBase64: htmlBytes.toString('base64'), textBase64: textBytes.toString('base64') });
  const receipt = await new Promise((resolve, reject) => {
    const launch = windowsClipboardHelperLaunch();
    const child = spawn(launch.command, launch.args, launch.options);
    let out = '', failed = false, executionPolicyBlocked = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('System clipboard helper timed out')); }, timeoutMs);
    child.stdout.on('data', data => { out += data; if (out.length > 2048) { failed = true; child.kill(); reject(new Error('Unexpected clipboard helper output')); } });
    // Do not forward helper stderr: only fixed, payload-free failure labels escape.
    child.stderr.on('data', data => {
      if (/PSSecurityException|running scripts is disabled|ExecutionPolicy|执行策略|禁止运行脚本/iu.test(data.toString())) executionPolicyBlocked = true;
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); failed = true; reject(new Error('System clipboard helper could not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) return reject(new Error(executionPolicyBlocked ? 'System clipboard helper blocked by current PowerShell execution policy; policy unchanged' : 'System clipboard write or own-payload verification failed'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('System clipboard helper returned an invalid receipt')); }
    });
    child.stdin.end(input);
  });
  if (receipt?.ok !== true || Object.keys(expected).some(key => receipt[key] !== expected[key])) throw new Error('System clipboard own-payload receipt mismatch');
  return { ok: true, ...expected };
}
