import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const EXTENSION_TOKEN_ENV = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';
export const DPAPI_ENTROPY = 'textbook-recorder/playwright-extension-auth/v1';

export class ExtensionAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'ExtensionAuthError'; this.code = code; }
}

const invalid = () => new ExtensionAuthError('AUTH_INVALID', '扩展授权配置无效；不会显示或传递无效令牌。');
const validToken = token => typeof token === 'string' && token.length > 0 && token.length <= 4096 && /^[\x21-\x7e]+$/u.test(token);
function authResult(token, source) {
  const result = { authConfigured:Boolean(token), authSource:source };
  Object.defineProperty(result, 'childEnv', { value:token ? { [EXTENSION_TOKEN_ENV]:token } : {}, enumerable:false });
  return result;
}

export function defaultExtensionAuthStore(environment = process.env) {
  const local = environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'textbook-recorder', 'extension-auth.dpapi.json');
}

// The command is constant. Only encrypted DPAPI bytes travel over child stdin;
// plaintext returns through a private pipe and is never printed or saved.
const decryptSource = `$ErrorActionPreference = 'Stop'
$plainBytes = $null
try {
  Add-Type -AssemblyName System.Security
  $cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
} catch {
  [Console]::Error.Write('DPAPI decryption failed')
  exit 1
} finally {
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}`;

export function decryptWindowsDpapi(ciphertext, { platform = process.platform, spawnProcess = spawn, timeoutMs = 10000, systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') throw new ExtensionAuthError('AUTH_PLATFORM', '加密扩展授权仅支持当前 Windows 用户。');
  if (typeof ciphertext !== 'string' || ciphertext.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(ciphertext) || !ciphertext.length) throw invalid();
  const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(decryptSource, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    let child, settled = false, stdout = Buffer.alloc(0), timer;
    const finish = (error, token) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      stdout.fill(0);
      if (error) reject(error); else resolve(token);
    };
    const failed = () => new ExtensionAuthError('AUTH_DECRYPT', '无法解密当前用户的扩展授权；请重新运行安全导入脚本。');
    try { child = spawnProcess(command, args, { windowsHide:true, stdio:['pipe','pipe','pipe'] }); }
    catch { finish(failed()); return; }
    child.stdout.on('data', chunk => {
      const next = Buffer.concat([stdout, Buffer.from(chunk)]); stdout.fill(0); stdout = next;
      if (stdout.length > 4096) { child.kill(); finish(failed()); }
    });
    child.stderr.on('data', () => {}); // Never surface PowerShell output containing input.
    child.stdout.on('error', () => finish(failed()));
    child.stderr.on('error', () => finish(failed()));
    child.on('error', () => finish(failed()));
    child.stdin.on('error', () => finish(failed()));
    child.on('close', code => {
      if (settled) return;
      const token = stdout.toString('utf8');
      if (code !== 0 || !validToken(token)) finish(failed()); else finish(null, token);
    });
    timer = setTimeout(() => { child.kill(); finish(new ExtensionAuthError('AUTH_TIMEOUT', '扩展授权解密超时；未启动浏览器连接。')); }, timeoutMs);
    child.stdin.end(ciphertext);
  });
}

function parseEncryptedStore(text) {
  let value;
  try {
    if (Buffer.byteLength(text, 'utf8') > 65536) throw invalid();
    value = JSON.parse(String(text).replace(/^\uFEFF/u, ''));
  } catch { throw invalid(); }
  const allowed = new Set(['schemaVersion','kind','algorithm','scope','ciphertext','createdAt']);
  if (!value || Object.keys(value).some(key => !allowed.has(key)) || value.schemaVersion !== 1 || value.kind !== 'playwright-extension-auth' || value.algorithm !== 'windows-dpapi' || value.scope !== 'CurrentUser' || typeof value.ciphertext !== 'string' || !value.ciphertext || value.ciphertext.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.ciphertext)) throw invalid();
  return value;
}

/** childEnv is private: use only for transport.env, never for logging/status. */
export async function resolveExtensionAuth({ environment = process.env, platform = process.platform, storePath = defaultExtensionAuthStore(environment), readFile = fs.readFile, decrypt = decryptWindowsDpapi } = {}) {
  const fromEnv = environment[EXTENSION_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!validToken(fromEnv)) throw invalid();
    return authResult(fromEnv, 'environment');
  }
  if (platform !== 'win32') return authResult(null, 'none');
  let text;
  try { text = await readFile(storePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return authResult(null, 'none');
    throw new ExtensionAuthError('AUTH_STORE', '无法读取当前用户的加密扩展授权。');
  }
  const stored = parseEncryptedStore(text);
  let token;
  try { token = await decrypt(stored.ciphertext); }
  catch { throw new ExtensionAuthError('AUTH_DECRYPT', '无法解密当前用户的扩展授权；请重新运行安全导入脚本。'); }
  if (!validToken(token)) throw invalid();
  return authResult(token, 'windows-dpapi');
}
