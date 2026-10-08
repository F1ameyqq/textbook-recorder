import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { EXTENSION_TOKEN_ENV, DPAPI_ENTROPY, defaultExtensionAuthStore, decryptWindowsDpapi, resolveExtensionAuth } from '../src/extension-auth.mjs';
import { connectMcp } from '../scripts/run-new-system-extension.mjs';

const dummy = 'test-only-extension-token-8d59f021';
const cipher = Buffer.from('test-ciphertext-not-a-production-secret').toString('base64');
const envelope = changes => JSON.stringify({ schemaVersion:1, kind:'playwright-extension-auth', algorithm:'windows-dpapi', scope:'CurrentUser', ciphertext:cipher, ...changes });
const fail = async () => { throw Error('must not read or decrypt a store'); };

test('environment token overrides encrypted store and private child env is not serialized', async () => {
  const result = await resolveExtensionAuth({ environment:{ [EXTENSION_TOKEN_ENV]:dummy, OTHER_SECRET:'unrelated' }, platform:'win32', readFile:fail, decrypt:fail });
  assert.equal(result.childEnv[EXTENSION_TOKEN_ENV], dummy);
  assert.deepEqual(Object.keys(result.childEnv), [EXTENSION_TOKEN_ENV]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { authConfigured:true, authSource:'environment' });
  assert.doesNotMatch(JSON.stringify(result), /test-only|unrelated/u);
});

test('invalid explicit environment token fails before store access without echoing it', async () => {
  for (const token of ['contains secret whitespace', 'private\nvalue', 'a'.repeat(4097), 123, null]) {
    await assert.rejects(resolveExtensionAuth({ environment:{ [EXTENSION_TOKEN_ENV]:token }, platform:'win32', readFile:fail, decrypt:fail }), error => error.code === 'AUTH_INVALID' && !error.message.includes('private') && !error.message.includes('secret'));
  }
});

test('no store retains interactive authorization and does not try to decrypt', async () => {
  const result = await resolveExtensionAuth({ environment:{}, platform:'win32', readFile:async () => { throw Object.assign(Error('absent'), { code:'ENOENT' }); }, decrypt:fail });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { authConfigured:false, authSource:'none' });
  assert.deepEqual(result.childEnv, {});
  const linux = await resolveExtensionAuth({ environment:{}, platform:'linux', readFile:fail, decrypt:fail });
  assert.equal(linux.authConfigured, false);
});

test('default store is under user LocalAppData, separate from the project', () => {
  assert.equal(defaultExtensionAuthStore({ LOCALAPPDATA:path.join(os.tmpdir(), 'auth-user') }), path.join(os.tmpdir(), 'auth-user', 'textbook-recorder', 'extension-auth.dpapi.json'));
});

test('encrypted user store validates envelope and decrypts only ciphertext', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-auth-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const storePath = path.join(dir, 'encrypted.json');
  await fs.writeFile(storePath, envelope());
  let calls = 0;
  const result = await resolveExtensionAuth({ environment:{ [EXTENSION_TOKEN_ENV]:'' }, platform:'win32', storePath, decrypt:async received => { calls++; assert.equal(received, cipher); return dummy; } });
  assert.equal(calls, 1);
  assert.equal(result.authConfigured, true);
  assert.equal(result.authSource, 'windows-dpapi');
  assert.equal(result.childEnv[EXTENSION_TOKEN_ENV], dummy);
  assert.doesNotMatch(await fs.readFile(storePath, 'utf8'), /test-only-extension-token/u);
  assert.doesNotMatch(JSON.stringify(result), /test-only/u);
});

test('corrupt, plaintext, wrong-scope and unreadable stores fail closed with sanitized diagnostics', async () => {
  for (const text of ['{invalid', JSON.stringify({ token:dummy }), envelope({ scope:'LocalMachine' }), envelope({ schemaVersion:2 }), envelope({ ciphertext:'bad!' }), envelope({ token:dummy }), 'x'.repeat(65537)]) {
    await assert.rejects(resolveExtensionAuth({ environment:{}, platform:'win32', readFile:async () => text, decrypt:fail }), error => error.code === 'AUTH_INVALID' && !error.message.includes(dummy));
  }
  await assert.rejects(resolveExtensionAuth({ environment:{}, platform:'win32', readFile:async () => { throw Object.assign(Error(dummy), { code:'EACCES' }); } }), error => error.code === 'AUTH_STORE' && !error.message.includes(dummy));
  await assert.rejects(resolveExtensionAuth({ environment:{}, platform:'win32', readFile:async () => envelope(), decrypt:async () => { throw Error(dummy); } }), error => error.code === 'AUTH_DECRYPT' && !error.message.includes(dummy));
  await assert.rejects(resolveExtensionAuth({ environment:{}, platform:'win32', readFile:async () => envelope(), decrypt:async () => 'invalid token' }), { code:'AUTH_INVALID' });
});

function fakeChild({ output = dummy, code = 0, neverClose = false, error = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  if (!neverClose) queueMicrotask(() => { if (error) child.emit('error', Error(dummy)); else { child.stdout.write(output); child.stderr.write('private-error-' + dummy); child.emit('close', code); } });
  return child;
}

test('DPAPI subprocess carries no plaintext in arguments and hides its window/output', async () => {
  let call, input = '';
  const token = await decryptWindowsDpapi(cipher, { platform:'win32', spawnProcess:(command,args,options) => {
    call = {command,args,options}; const child = fakeChild(); child.stdin.on('data', chunk => { input += chunk; }); return child;
  } });
  assert.equal(token, dummy);
  assert.equal(input, cipher);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe','pipe','pipe']);
  assert.doesNotMatch(JSON.stringify(call), /test-only-extension-token|test-ciphertext/u);
  const source = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(source, /DataProtectionScope\]::CurrentUser/u);
  assert.ok(source.includes(DPAPI_ENTROPY));
  assert.doesNotMatch(source, /LocalMachine|ReadAllText|WriteAllText/u);
});

test('DPAPI non-Windows, process errors, invalid output, oversized output and timeout fail safely', async () => {
  assert.throws(() => decryptWindowsDpapi(cipher, { platform:'linux' }), { code:'AUTH_PLATFORM' });
  assert.throws(() => decryptWindowsDpapi('bad!', { platform:'win32' }), { code:'AUTH_INVALID' });
  for (const options of [{code:1},{error:true},{output:'invalid token'},{output:'x'.repeat(4097)}]) {
    await assert.rejects(decryptWindowsDpapi(cipher, { platform:'win32', spawnProcess:() => fakeChild(options) }), error => error.code === 'AUTH_DECRYPT' && !error.message.includes(dummy));
  }
  const child = fakeChild({neverClose:true});
  await assert.rejects(decryptWindowsDpapi(cipher, { platform:'win32', timeoutMs:5, spawnProcess:() => child }), { code:'AUTH_TIMEOUT' });
  assert.equal(child.killed, true);
});

test('connector explicitly forwards token, reports safe profile/auth metadata and only closes MCP', async () => {
  let forwarded, params, closes = 0, connects = 0;
  class Transport { constructor(options) { params = options; forwarded = {...options.env}; this.stderr = new PassThrough(); } }
  class Client { async connect(transport) { connects++; assert.equal(transport instanceof Transport, true); } async close() { closes++; } }
  const connection = await connectMcp(path.resolve('fixtures/bridge.cjs'), { ClientClass:Client, TransportClass:Transport, authOptions:{ environment:{ [EXTENSION_TOKEN_ENV]:dummy, OTHER_SECRET:'not-inherited' }, platform:'win32', readFile:fail } });
  assert.equal(connects, 1);
  assert.deepEqual(forwarded, { [EXTENSION_TOKEN_ENV]:dummy });
  assert.deepEqual(params.env, {}, 'discard parent-side transport copy after the child has inherited it');
  assert.equal(connection.authConfigured, true);
  assert.equal(connection.authSource, 'environment');
  assert.equal(connection.servicePid, null);
  assert.equal(connection.isClosed(), false);
  assert.deepEqual(connection.profile, { browser:'msedge', profileDirName:'Default', existingBrowser:true });
  assert.ok(params.args.includes('--extension'));
  assert.equal(params.args[params.args.indexOf('--browser') + 1], 'msedge');
  assert.equal(params.args[params.args.indexOf('--profile-dir-name') + 1], 'Default');
  assert.doesNotMatch(JSON.stringify(connection), /test-only|PLAYWRIGHT_MCP_EXTENSION_TOKEN/u);
  await connection.close(); assert.equal(closes, 1); assert.equal(connection.isClosed(), true);
});

test('connector connection failure clears token and closes its MCP transport without leaking error secrets', async () => {
  let params, closes = 0;
  class Transport { constructor(options) { params = options; this.stderr = new PassThrough(); } }
  class Client { async connect() { throw Error('failure ' + dummy + ' https://private.example/?token=' + dummy); } async close() { closes++; } }
  await assert.rejects(connectMcp(path.resolve('fixtures/bridge.cjs'), { ClientClass:Client, TransportClass:Transport, authOptions:{ environment:{ [EXTENSION_TOKEN_ENV]:dummy } } }), error => !error.message.includes(dummy) && !error.message.includes('private.example'));
  assert.equal(closes, 1); assert.deepEqual(params.env, {});
});

test('connection closes notify subscribers and preserve prior callback; ordinary tool errors stay connected', async () => {
  let prior = 0, notification = 0, unsubscribed = 0;
  class Transport { constructor() { this.stderr = new PassThrough(); this.pid = 12345; } }
  class Client {
    constructor() { this.onclose = () => { prior++; }; }
    async connect() {}
    async callTool() { throw Error('read-only business failure'); }
    async close() { this.onclose(); }
  }
  const connection = await connectMcp(path.resolve('fixtures/bridge.cjs'), { ClientClass:Client, TransportClass:Transport, authOptions:{ environment:{ [EXTENSION_TOKEN_ENV]:dummy } }, processAlive:() => false });
  assert.equal(connection.servicePid, 12345);
  connection.onClosed(() => { notification++; });
  const unsubscribe = connection.onClosed(() => { unsubscribed++; }); unsubscribe();
  await assert.rejects(connection.client.callTool({name:'read'}), /business failure/u);
  assert.equal(connection.isClosed(), false); assert.equal(notification, 0);
  await connection.close(); await connection.close();
  assert.equal(prior, 1); assert.equal(notification, 1); assert.equal(unsubscribed, 0);
  let late = 0; connection.onClosed(() => { late++; }); await new Promise(resolve => queueMicrotask(resolve)); assert.equal(late, 1);
});

test('close awaits the captured service PID exit and retains failure if exit is not confirmed', async () => {
  let probes = 0;
  class Transport { constructor() { this.stderr = new PassThrough(); this.pid = 12345; } }
  class Client { async connect() {} async close() {} }
  const options = {ClientClass:Client,TransportClass:Transport,authOptions:{ environment:{ [EXTENSION_TOKEN_ENV]:dummy } }};
  const connection = await connectMcp(path.resolve('fixtures/bridge.cjs'), {...options,processAlive:pid=>{assert.equal(pid,12345);return ++probes < 3;},pause:async()=>{}});
  await connection.close(); assert.equal(probes, 3); assert.equal(connection.isClosed(), true);
  const stuck = await connectMcp(path.resolve('fixtures/bridge.cjs'), {...options,processAlive:()=>true,closeTimeoutMs:5,closePollMs:1});
  await assert.rejects(stuck.close(), error => error.code === 'MCP_EXIT_UNCONFIRMED' && error.servicePid === 12345);
  assert.equal(stuck.isClosed(), false);
  const unknown = await connectMcp(path.resolve('fixtures/bridge.cjs'), {...options,processAlive:()=>{throw Object.assign(Error('denied'),{code:'EPERM'});}});
  await assert.rejects(unknown.close(), {code:'MCP_EXIT_UNCONFIRMED'});
  assert.equal(unknown.isClosed(), false);
});

test('failed handshake cannot report a clean shutdown when its service PID survives', async () => {
  class Transport { constructor() { this.stderr = new PassThrough(); this.pid = 12345; } }
  class Client { async connect() { throw Error(dummy); } async close() {} }
  await assert.rejects(connectMcp(path.resolve('fixtures/bridge.cjs'), {ClientClass:Client,TransportClass:Transport,authOptions:{ environment:{[EXTENSION_TOKEN_ENV]:dummy}},processAlive:()=>true,closeTimeoutMs:2,closePollMs:1}), error=>error.code === 'MCP_EXIT_UNCONFIRMED' && !error.message.includes(dummy));
});

test('MCP close failures remain unconfirmed and never expose transport exception secrets', async () => {
  class Transport { constructor() { this.stderr = new PassThrough(); this.pid = 12345; } }
  class Client { async connect() {} async close() { throw Error(dummy); } }
  const connection = await connectMcp(path.resolve('fixtures/bridge.cjs'), {ClientClass:Client,TransportClass:Transport,authOptions:{environment:{[EXTENSION_TOKEN_ENV]:dummy}},processAlive:()=>false});
  await assert.rejects(connection.close(), error=>error.code === 'MCP_EXIT_UNCONFIRMED' && !error.message.includes(dummy));
  assert.equal(connection.isClosed(), false);
});

test('real Windows DPAPI round trip uses only an ephemeral test token and private pipes', { skip:process.platform !== 'win32' }, async () => {
  const source = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}'); try { [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))) } finally { [Array]::Clear($bytes,0,$bytes.Length) }`;
  const ciphertext = await new Promise((resolve,reject) => {
    const command = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32','WindowsPowerShell','v1.0','powershell.exe');
    const child = spawn(command, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')], {windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
    child.on('error', () => reject(Error('test DPAPI protector unavailable')));
    child.on('close', code => code === 0 ? resolve(output) : reject(Error('test DPAPI protector failed')));
    child.stdin.end(dummy);
  });
  assert.equal(await decryptWindowsDpapi(ciphertext), dummy);
});
