import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import { renderEditorHtml, compareNewSystemReadback, verifyNewSystemSave } from './new-system-core.mjs';
import { writeWindowsClipboardHtml } from './windows-html-clipboard.mjs';
import { insertReviewedEditorHtml } from './browser-editor-command.mjs';
import { readEditorLiteralDollarSafety, prepareReviewedLiteralDollarHtml, assertEditorLiteralDollarSafety } from './literal-dollar.mjs';
import { readEditorNativeEmphasis, assertEditorNativeEmphasis } from './native-emphasis.mjs';
import { readEditorNativeScripts, assertEditorNativeScripts } from './native-scripts.mjs';
import { checkedPointerClick } from './checked-pointer-click.mjs';
import { waitForAppendAutosaveReady, readAppendAutosaveSnapshot } from './append-autosave-readiness.mjs';
import { waitVisibleByTimer } from './timer-visible-wait.mjs';
import { captureResponseBeforeWait } from './deferred-response-wait.mjs';
import { activateRecorderPage, validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';
import { requireRecorderDocumentReady,waitForRecorderDocumentReady } from './browser-document-state.mjs';
import { existingWorkspacePath, writableWorkspacePath } from './recorder-config.mjs';
import { validateHistoricalNetworkRecovery, validHistoricalNetworkRecoveryProof } from './historical-network-recovery.mjs';

const SITE = 'https://easylearn.baidu.com';
const LIST_PATH = '/edushop/textbook/detail/shitilist';
const SAVE_PATH = '/edushop/textbook/myproducecommit/editshiti';
const ROUTE = '#/content-manager/teaching-content';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const label = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const scopeKey = target => JSON.stringify([label(target.chapterLabel), label(target.sectionLabel)]);
// Locator selectors parse quotes and >> before the text RegExp. Encode those
// delimiters as literal regex escapes so appending a parent locator stays exact.
const exactLabel = value => new RegExp(`^\\s*${label(value).split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/[\/'"`>]/gu, character => '\\x' + character.charCodeAt(0).toString(16).padStart(2,'0'))).join('\\s+')}\\s*$`, 'u');

function safeNumber(value) { return positive(value) ? Number(value) : undefined; }
function parsePost(request) {
  let body;
  try { body = request.postDataJSON(); } catch {}
  if (!body || typeof body !== 'object') {
    const raw = request.postData();
    if (!raw) throw new Error('保存请求没有可验证的正文');
    try { body = JSON.parse(raw); }
    catch { body = Object.fromEntries(new URLSearchParams(raw)); }
  }
  return body;
}
function reducedRequest(body) {
  return {
    bookId: safeNumber(body.textbookID), seqIndex: safeNumber(body.seqIndex),
    ...(safeNumber(body.shitiID) ? { shitiID: Number(body.shitiID) } : {}),
    mainPicNum: safeNumber(body.mainPicNum), answerPicNum: safeNumber(body.answerPicNum),
  };
}
function requestMatches(request, origin, pathname) {
  try { const url = new URL(request.url()); return url.origin === origin && url.pathname === pathname; }
  catch { return false; }
}

function appendIntentIdentity(pending) {
  return { schemaVersion:pending.schemaVersion, kind:pending.kind, bookId:pending.bookId,
    nodeID:pending.nodeID, task:pending.task, priorRecords:pending.priorRecords,
    startedAt:pending.startedAt, evidencePath:pending.evidencePath };
}

/** Read frozen raw inputs; a caller-supplied proof object is never accepted. */
export async function readHistoricalNetworkEvidence(root, evidencePath, {context, pendingPath}) {
  const file = await existingWorkspacePath(root,evidencePath), bytes = await fs.readFile(file), bundle = JSON.parse(bytes);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const assert = (condition,message) => {if(!condition)throw new Error(message);};
  const keys = ['history','lifetime','priorBatch','failedBatch','pending','anchorPending','freshScope','freshScopeJob','freshReadback','freshReadbackJob'];
  assert(bundle.schemaVersion===1&&bundle.kind==='historical-network-recovery-evidence'&&bundle.files
    &&Object.keys(bundle).sort().join(',')==='files,kind,schemaVersion'
    &&Object.keys(bundle.files).sort().join(',')===keys.sort().join(','),'历史网络证据束结构不完整');
  const read = async ref => {
    assert(ref&&Object.keys(ref).sort().join(',')==='path,sha256'&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/u.test(ref.sha256),'历史网络证据引用须有固定路径和SHA256');
    const pathname=await existingWorkspacePath(root,ref.path), raw=await fs.readFile(pathname);
    assert(hash(raw)===ref.sha256,'历史网络证据文件SHA256已改变');
    return raw;
  };
  const batch = async refs => {
    assert(refs&&Object.keys(refs).sort().join(',')==='job,manifest,preflight,state','历史网络原批次引用不完整');
    const entries=await Promise.all(Object.entries(refs).map(async([name,ref])=>[name+'Bytes',await read(ref)]));
    return Object.fromEntries(entries);
  };
  assert(Array.isArray(bundle.files.anchorPending)&&bundle.files.anchorPending.length===14,'历史网络证明必须冻结14个原保存意图');
  const input={historyBytes:await read(bundle.files.history),lifetimeBytes:await read(bundle.files.lifetime),priorBatch:await batch(bundle.files.priorBatch),failedBatch:await batch(bundle.files.failedBatch),
    pendingBytes:await read(bundle.files.pending),anchorPendingBytes:await Promise.all(bundle.files.anchorPending.map(read)),
    freshScopeBytes:await read(bundle.files.freshScope),freshScopeJobBytes:await read(bundle.files.freshScopeJob),
    freshReadbackBytes:await read(bundle.files.freshReadback),freshReadbackJobBytes:await read(bundle.files.freshReadbackJob)};
  const history=JSON.parse(input.historyBytes),corePath=await existingWorkspacePath(root,'node_modules/playwright-core/lib/coreBundle.js'),sdkPath=await existingWorkspacePath(root,'node_modules/playwright-core/package.json');
  const coreBytes=await fs.readFile(corePath),sdkBytes=await fs.readFile(sdkPath);
  assert(hash(coreBytes)===history.coreSha256&&JSON.parse(sdkBytes).version===history.sdkVersion,'当前实际SDK字节或版本与原网络观察源码不符');
  const currentManifest=await existingWorkspacePath(root,context.manifestPath),currentState=await existingWorkspacePath(root,context.statePath),originalPendingPath=await existingWorkspacePath(root,pendingPath);
  const bound=await Promise.all([currentManifest,currentState,originalPendingPath,corePath,sdkPath].map(async pathname=>({pathname,sha256:hash(await fs.readFile(pathname))})));
  assert(bound[0].sha256===hash(input.failedBatch.manifestBytes)&&bound[1].sha256===hash(input.failedBatch.stateBytes)&&bound[2].sha256===hash(input.pendingBytes),'冻结证据与原题单、当前进度或保存意图字节不符');
  const recheck=async({originalPending=true}={})=>{
    assert(hash(await fs.readFile(await existingWorkspacePath(root,file)))===hash(bytes),'核对期间历史证据束已改变');
    for(const item of bound)if(originalPending||item.pathname!==originalPendingPath)assert(hash(await fs.readFile(await existingWorkspacePath(root,item.pathname)))===item.sha256,'核对期间原题单、进度或保存意图已改变');
  };
  return {input,bundleSha256:hash(bytes),originalPendingPath,currentManifest,currentState,recheck};
}

/**
 * Independent Playwright executor for the teaching-content UI.
 * Each write uses the visible editor's native HTML paste or an explicitly chosen
 * normal browser editing command. No endpoint is replayed,
 * and no framework state is read or changed. Only responses caused by this page's
 * ordinary UI are observed. A newly created draft is reloaded immediately after
 * its first successful autosave; it is never saved/edited a second time while it
 * lacks the server ID. Uncertain effects stop the batch for reconciliation.
 */
export class NewSystemAdapter {
  #pageObservation = null;
  #liveAppendObservation = null;

  constructor({ baseDir, dataDir, profileDir, page = null, source = 'production', origin = SITE, timeout = 20000, directoryTimeout = timeout, directoryRootTimeout = directoryTimeout, inputMode = 'native-paste', focusMode = 'foreground', windowMode = 'normal' } = {}) {
    if (!['native-paste', 'browser-command'].includes(inputMode)) throw new Error('inputMode 必须是 native-paste 或 browser-command');
    this.focusMode = validateBrowserFocusMode(focusMode);
    this.windowMode = validateBrowserWindowMode(windowMode);
    if (this.focusMode === 'foreground' && this.windowMode !== 'normal') throw new Error('minimized/headless 只允许 background 模式');
    if (this.windowMode === 'headless' && !page) throw new Error('headless 适配器必须使用独立持久服务已绑定的页面');
    if (this.focusMode === 'background' && inputMode !== 'browser-command') throw new Error('后台模式只支持 browser-command；原生剪贴板粘贴须使用 foreground');
    if (!Number.isSafeInteger(directoryTimeout) || directoryTimeout < 1 || directoryTimeout > 120000) throw new Error('directoryTimeout 必须是 1–120000 毫秒的整数');
    if (!Number.isSafeInteger(directoryRootTimeout) || directoryRootTimeout < 1 || directoryRootTimeout > 120000) throw new Error('directoryRootTimeout 必须是 1–120000 毫秒的整数');
    this.inputMode = inputMode;
    this.baseDir = path.resolve(baseDir ?? process.cwd());
    this.dataDir = path.resolve(dataDir ?? path.join(this.baseDir, 'data'));
    this.profileDir = path.resolve(profileDir ?? path.join(this.dataDir, 'new-system-edge-profile'));
    this.source = source;
    this.origin = new URL(origin).origin;
    this.timeout = timeout;
    this.directoryTimeout = directoryTimeout;
    this.directoryRootTimeout = directoryRootTimeout;
    this.page = page;
    this.context = page?.context() ?? null;
    this.ownsContext = false;
    this.bookId = undefined;
    this._sequence = 0;
    this._requests = new WeakMap();
    this._directoryKey = null;
    this._directoryRecords = [];
    this._nodeID = null;
    this._observedPage = null;
    this._busy = false;
    this._uncertain = false;
    this._pendingWrite = null;
    if (page) this._observe(page);
  }

  get connected() { return Boolean(this.page && !this.page.isClosed()); }

  _observe(page) {
    if (this._observedPage === page) return;
    if (this.#pageObservation) this.#pageObservation.continuous = false;
    this._observedPage = page;
    const context = page.context(), browser = context?.browser?.();
    const observation = { page, context, browser, continuous:true, channels:[] };
    const invalidate = () => { observation.continuous = false; };
    observation.onRequest = request => {
      this._requests.set(request, ++this._sequence);
      if (requestMatches(request, this.origin, SAVE_PATH) && request.method() === 'POST') {
        const live = this.#liveAppendObservation;
        // Keep the fresh intent's count independent of recovery clones/status.
        // A failed request or response never retracts a dispatched SAVE.
        if (live?.observation === observation) {
          live.observedSaveRequests += 1;
          live.pending.observedSaveRequests = Math.max(live.pending.observedSaveRequests, live.observedSaveRequests);
        }
        if (this._pendingWrite?.status === 'pending' && this._pendingWrite !== live?.pending) this._pendingWrite.observedSaveRequests += 1;
      }
    };
    observation.onClose = invalidate;
    observation.onCrash = invalidate;
    this.#pageObservation = observation;
    const watch = (emitter, entries) => {
      if (!emitter || typeof emitter.on !== 'function') { invalidate(); return; }
      if (typeof emitter.listeners !== 'function') invalidate();
      const removed = (event, listener) => {
        if (entries.some(([name, fn]) => name === event && fn === listener)) invalidate();
      };
      // Two watchers detect removal of either watcher before any silent gap.
      entries.push(['removeListener', removed], ['removeListener', (event, listener) => removed(event, listener)]);
      for (const [event, listener] of entries) { emitter.on(event, listener); observation.channels.push([emitter, event, listener]); }
    };
    watch(page, [['request', observation.onRequest], ['close', observation.onClose], ['crash', observation.onCrash]]);
    watch(context, [['close', invalidate]]);
    watch(browser, [['disconnected', invalidate]]);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        this._directoryKey = null;
        this._directoryRecords = [];
        this._nodeID = null;
      }
    });
  }

  #hasLiveAppendObservation(pending) {
    const live = this.#liveAppendObservation, observed = this.#pageObservation;
    if (!live || !observed) return false;
    if (!observed.continuous) return false;
    const listenersIntact = observed.channels.every(([emitter, event, listener]) => typeof emitter.listeners === 'function' && emitter.listeners(event).includes(listener));
    const browser = observed.context?.browser?.();
    const valid = observed.continuous && live.observation === observed
      && this.page === observed.page && this._observedPage === observed.page
      && this.context === observed.context && this.page.context() === observed.context
      && !this.page.isClosed() && browser === observed.browser && typeof browser?.isConnected === 'function' && browser.isConnected() && listenersIntact
      && pending === live.pending && this._pendingWrite === live.pending
      && isDeepStrictEqual(appendIntentIdentity(pending), live.identity)
      && !live.receiptConflict && pending.receiptConflict !== true
      && Number.isSafeInteger(pending.observedSaveRequests) && pending.observedSaveRequests >= 0;
    if (!valid) observed.continuous = false;
    return Boolean(valid);
  }

  _captureSaveResponse(cursor=this._sequence,extraPredicate=()=>true) {
    return captureResponseBeforeWait(this.page,{timeoutMs:this.timeout,predicate:response=>{
      const request=response.request();
      if((this._requests.get(request)??0)<=cursor || request.method()!=='POST' || !requestMatches(request,this.origin,SAVE_PATH))return false;
      return Number(parsePost(request).textbookID)===this.bookId && extraPredicate(request);
    }});
  }

  async connect(bookId) {
    if (!positive(bookId)) throw new Error('书 ID 必须是正整数');
    this.bookId = Number(bookId);
    if (!this.page) {
      if (this.source !== 'production') throw new Error('本地 fixture 必须显式注入 page');
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        channel: 'msedge', headless: false, viewport: null,
      });
      this.ownsContext = true;
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this._observe(this.page);
      this.context.on('close', () => { this.page = null; this.context = null; });
      if (this.inputMode === 'native-paste') await this.context.grantPermissions(['clipboard-write'], { origin: this.origin });
      await this.page.goto(`${this.origin}/edu-shop-web/${ROUTE}?textbookID=${this.bookId}&textbookType=main`);
    } else {
      this._observe(this.page);
      // An attached extension transports tab-scoped CDP only. Browser permission
      // overrides are unsupported there; connecting for readback must have no
      // clipboard permission effects. Existing permissions are checked before Plus.
    }
    return { connected: true, bookId: this.bookId, message: '专用窗口已连接，请在该窗口完成登录。尚未写入题目。' };
  }

  async guard({ waitForEditors = true } = {}) {
    if (typeof waitForEditors !== 'boolean') throw new Error('waitForEditors 必须是布尔值');
    if (!this.connected) throw new Error('请先连接专用窗口并登录');
    let url;
    try { url = new URL(this.page.url()); } catch { throw new Error('当前页面 URL 无法验证'); }
    if (url.origin !== this.origin || url.hash.split('?')[0] !== ROUTE) throw new Error('当前页面不是指定的新系统录入界面');
    const params = new URLSearchParams(url.hash.split('?')[1] ?? '');
    if (!positive(this.bookId) || Number(params.get('textbookID')) !== this.bookId) throw new Error('页面书 ID 与题单不一致');
    if (this.source === 'production' && this.origin !== SITE) throw new Error('生产源必须是已确认的录入平台');
    if (waitForEditors) {
      await waitVisibleByTimer(this.page.locator('#contentedit .w-e-text'),{timeout:this.timeout,name:'题目编辑器'});
      await waitVisibleByTimer(this.page.locator('#answeredit .w-e-text'),{timeout:this.timeout,name:'答案编辑器'});
    }
  }

  _validateTarget(task) {
    const target = task?.target;
    if (!target || !label(target.chapterLabel) || !label(target.sectionLabel) || !positive(target.record)) throw new Error('必须明确章节、节名和正整数题号');
    return target;
  }

  async _selectedScope() {
    return this.page.evaluate(() => {
      const norm = text => String(text ?? '').replace(/\s+/gu, ' ').trim();
      const node = document.querySelector('.el-tree-node.is-current');
      const section = node?.querySelector(':scope > .el-tree-node__content');
      const ancestors = [];
      for (let parent = node?.parentElement?.closest('.el-tree-node'); parent; parent = parent.parentElement?.closest('.el-tree-node')) {
        ancestors.unshift(norm(parent.querySelector(':scope > .el-tree-node__content')?.innerText));
      }
      const sectionLabel = norm(section?.innerText);
      return { chapterLabel: ancestors.length ? ancestors.join(' > ') : sectionLabel, sectionLabel };
    });
  }

  async _scopeMatches(target) {
    const selected = await this._selectedScope();
    return selected.chapterLabel === label(target.chapterLabel) && selected.sectionLabel === label(target.sectionLabel);
  }

  /** A breadcrumb is a path of separately named nodes, never one DOM label.
   * Keep flat scope matching compatible; explicit paths start at a tree root
   * and use immediate children, so repeated middle labels remain isolated. */
  async _directoryNode(chapterLabel, { budget = () => this.directoryTimeout } = {}) {
    const parts = String(chapterLabel).split(' > ').map(label);
    if (!parts.length || parts.length > 8 || parts.some(part => !part)) throw new Error('目录路径为空或超过支持深度');
    let node, content;
    for (const [index, part] of parts.entries()) {
      const candidates = index === 0
        ? this.page.locator(parts.length === 1 ? '.el-tree-node__content' : '.el-tree > .el-tree-node > .el-tree-node__content')
        : node.locator(':scope > .el-tree-node__children > .el-tree-node > .el-tree-node__content');
      content = candidates.filter({hasText:exactLabel(part)});
      const name = (parts.length === 1 ? '章节 ' : '目录路径 ') + parts.slice(0,index+1).join(' > ');
      await waitVisibleByTimer(content,{timeout:budget(name,'directory-chapter'),name,targetRole:'directory-chapter'});
      if (await content.count() !== 1) throw new Error('目录路径标签无法唯一匹配');
      node = content.locator('xpath=..');
      if (index < parts.length - 1) {
        const expanded = await node.evaluate(element => element.classList.contains('is-expanded') || element.getAttribute('aria-expanded') === 'true');
        if (!expanded) await this._click(content);
      }
    }
    return {node,content};
  }

  async _activate() {
    return activateRecorderPage(this.page, this.focusMode, { windowMode:this.windowMode, guard:() => this.guard({waitForEditors:false}) });
  }

  async _click(locator, {preserveEditorFocus=false,beforeInput}={}) {
    // Reapply the configured window policy after reload. Background input never
    // falls back to a foreground window when its document loses actionability.
    await this._activate();
    const clicked = await checkedPointerClick(this.page, locator, { timeout:this.timeout, focusMode:this.focusMode, windowMode:this.windowMode, preserveEditorFocus, beforeInput, guard:async () => {
      await this.guard({waitForEditors:false});
      if (this.focusMode === 'background' && this.windowMode !== 'minimized') await this._requireDocumentFocus('后台点击前后');
    } });
    this._lastPointerClick = clicked;
    return clicked;
  }

  async _stableList(expected) {
    const wanted = expected.map(record => Number(record.seqIndex));
    let previous;
    let stable = 0;
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const state = await this.page.evaluate(() => {
        const visible = element => element && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
        return {
          numbers: [...document.querySelectorAll('.shiti-cont .shiti-sort')].map(element => Number(element.innerText.trim().replace(/[.、．。]$/u, ''))),
          loading: [...document.querySelectorAll('.el-loading-mask,[aria-busy="true"]')].some(visible),
        };
      });
      const key = JSON.stringify(state);
      stable = key === previous ? stable + 1 : 0;
      previous = key;
      if (!state.loading && stable >= 2 && JSON.stringify(state.numbers) === JSON.stringify(wanted)) return;
      await wait(80);
    }
    throw new Error('目录的异步题目列表未完成加载，拒绝使用旧列表');
  }

  async _reloadForFreshRead() {
    await this.guard({waitForEditors:false});
    // Discard cached server data even when navigation subsequently fails.
    this._directoryKey=null;this._directoryRecords=[];this._nodeID=null;
    // The platform can show its directory before DOMContentLoaded completes.
    // A committed navigation is followed by the existing visible-directory
    // waits, a NEW click-caused LIST request and full scope/ID/content checks.
    // Never catch a navigation error or treat the old DOM/cache as evidence.
    await this.page.reload({waitUntil:'commit',timeout:this.timeout});
    if (this.focusMode === 'background' && this.windowMode === 'minimized') {
      // The SPA replaces its title when the book finishes loading. Wait for the
      // real new directory before applying the temporary Win32 window marker.
      await this.guard({waitForEditors:false});
      await waitVisibleByTimer(this.page.locator('.el-tree-node__content').first(), {
        timeout:this.directoryRootTimeout, name:'刷新后的教材目录', targetRole:'directory-root',
      });
    }
    await this._activate();
    await this.guard({waitForEditors:false});
  }

  async directory(task) {
    const target = this._validateTarget(task);
    // Reload may leave no section selected and both editors hidden. Validate
    // identity first; editor visibility becomes required after scope selection.
    await this.guard({ waitForEditors: false });
    await this._activate();
    // Reject a hidden or wrongly bound background document before spending the
    // directory-loading budget. A fresh committed navigation may still load;
    // readiness and chapter/section waits share the original directory budget.
    const directoryDeadline=Date.now()+this.directoryTimeout;
    if(this.focusMode==='background'){
      try{await waitForRecorderDocumentReady(this.page,{focusMode:this.focusMode,windowMode:this.windowMode,
        timeoutMs:Math.min(this.timeout,this.directoryTimeout),guard:()=>this.guard({waitForEditors:false})});}
      catch(error){error.message='目录读取前: '+error.message;throw error;}
    }
    const directoryBudget=(name,targetRole)=>{
      if(this.focusMode!=='background')return this.directoryTimeout;
      const remaining=directoryDeadline-Date.now();if(remaining>0)return remaining;
      const error=new Error(name+'在时限内未显示，停止操作');error.code='TARGET_VISIBILITY_TIMEOUT';error.targetRole=targetRole;
      error.visibilityDiagnostic={name,targetRole,timeout:this.directoryTimeout,budgetExhausted:true,lastState:null};throw error;
    };
    if (this._directoryKey === scopeKey(target) && await this._scopeMatches(target)) {
      await this._stableList(this._directoryRecords);
      await this.guard();
      return;
    }
    // Clicking an already selected section need not emit LIST. A fresh adapter
    // has no authoritative cached list, so reload instead of waiting for a
    // request the UI has no reason to send. Never synthesize/replay an API call.
    if (await this._scopeMatches(target)) {
      await this._reloadForFreshRead();
      if (await this._scopeMatches(target)) throw new Error('刷新后目录仍已选中且无可信列表，拒绝等待不存在的列表请求');
    }
    const {node:chapterNode,content:chapter} = await this._directoryNode(target.chapterLabel,{budget:directoryBudget});
    const rootLeaf = label(target.chapterLabel) === label(target.sectionLabel) && await chapterNode.evaluate(node => !node.querySelector(':scope > .el-tree-node__children > .el-tree-node') && Boolean(node.querySelector(':scope > .el-tree-node__content .el-tree-node__expand-icon.is-leaf')));
    const section = rootLeaf ? chapter : chapterNode.locator('.el-tree-node__content').filter({ hasText: exactLabel(target.sectionLabel) });
    const expanded = await chapterNode.evaluate(node => {
      const children = node.querySelector(':scope > .el-tree-node__children');
      const content = node.querySelector(':scope > .el-tree-node__content');
      return node.classList.contains('is-expanded') || node.getAttribute('aria-expanded') === 'true' || content?.getAttribute('aria-expanded') === 'true' || Boolean(children && getComputedStyle(children).display !== 'none' && getComputedStyle(children).visibility !== 'hidden' && children.getClientRects().length > 0);
    });
    // Missing section labels may still be loading inside an already expanded node.
    // Toggle only a visibly collapsed chapter, otherwise wait for the child label.
    if (!rootLeaf && !expanded) await this._click(chapter);
    await waitVisibleByTimer(section,{timeout:directoryBudget('节目录 '+target.sectionLabel,'directory-section'),name:'节目录 '+target.sectionLabel,targetRole:'directory-section'});
    if (await section.count() !== 1) throw new Error('该章节下的节标签无法唯一匹配');
    const cursor = this._sequence;
    const observedList = captureResponseBeforeWait(this.page, {predicate:response => {
      const request = response.request();
      if ((this._requests.get(request) ?? 0) <= cursor || !requestMatches(request, this.origin, LIST_PATH)) return false;
      const url = new URL(request.url());
      return Number(url.searchParams.get('textbookID')) === this.bookId && positive(url.searchParams.get('nodeID'));
    }, timeoutMs:this.timeout});
    let response;
    const clickStartedAt = Date.now();
    try {
      await this._click(section);
      response = await observedList.wait();
    } catch (error) {
      // Read-only evidence distinguishes input checks from the response wait.
      error.directoryClickElapsedMs = Date.now() - clickStartedAt;
      error.selectedScopeAfterClick = await this._selectedScope();
      if(this.focusMode==='background'&&this.windowMode==='minimized') {
        await this.guard({waitForEditors:false});
        const dom=await this.page.evaluate(()=>({
          readyState:document.readyState,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),
          selectedLabels:[...document.querySelectorAll('.el-tree-node.is-current > .el-tree-node__content')].map(e=>e.innerText),
          sectionLabels:[...document.querySelectorAll('.el-tree-node__content')].map(e=>({text:e.innerText,visible:!!e.getClientRects().length})),
          recordNumbers:[...document.querySelectorAll('.shiti-cont .shiti-sort')].map(e=>e.innerText),
        }));
        const folder=path.join(this.dataDir,'directory-input-diagnostics');await fs.mkdir(folder,{recursive:true});
        const file=path.join(folder,`book-${this.bookId}-${randomUUID()}.json`);
        await fs.writeFile(file,JSON.stringify({bookId:this.bookId,target,at:new Date().toISOString(),elapsedMs:error.directoryClickElapsedMs,selectedScope:error.selectedScopeAfterClick,pointer:error.nativePointer??this._lastPointerClick,dom},null,2),{flag:'wx'});
        error.message += '；只读目录输入诊断：'+file;
      }
      throw error;
    } finally { observedList.dispose(); }
    const body = await response.json();
    if (!response.ok() || body?.errno !== 0 || body.errmsg !== 'success' || !Array.isArray(body.data)) throw new Error('平台题目列表业务响应未确认成功');
    if (!await this._scopeMatches(target)) throw new Error('题目列表响应到达时选中目录已改变');
    const nodeID = Number(new URL(response.url()).searchParams.get('nodeID'));
    const records = body.data.map(record => ({
      seqIndex: Number(record.seqIndex), shitiID: Number(record.shitiID), nodeID: Number(record.nodeID),
      question: record.question, answer: record.answer,
      mainPicNum: Number(record.mainPicNum), answerPicNum: Number(record.answerPicNum), haveAnswer: record.haveAnswer,
    }));
    const seen = new Set();
    for (const record of records) {
      if (!positive(record.seqIndex) || !positive(record.shitiID) || record.nodeID !== nodeID || seen.has(record.seqIndex) || typeof record.question !== 'string' || typeof record.answer !== 'string') throw new Error('平台列表题号、身份或目录不一致');
      seen.add(record.seqIndex);
    }
    await this._stableList(records);
    await this.guard();
    if (!await this._scopeMatches(target)) throw new Error('编辑器加载完成前选中目录已改变');
    this._nodeID = nodeID;
    this._directoryRecords = records;
    this._directoryKey = scopeKey(target);
  }

  async list(task) {
    await this.directory(task);
    return this._directoryRecords.map(record => ({ record: record.seqIndex, recordId: record.shitiID, mainPicNum: record.mainPicNum, answerPicNum: record.answerPicNum, haveAnswer: record.haveAnswer }));
  }

  async count(task) { return (await this.list(task)).length; }

  /** Read only visible book directories and the LIST responses their clicks cause. */
  async inventory({ onScope = async () => {} } = {}) {
    await this.guard({ waitForEditors:false });
    await waitVisibleByTimer(this.page.locator('.el-tree-node__content').first(),{timeout:this.timeout});
    const roots = await this.page.evaluate(() => [...document.querySelectorAll('.el-tree-node')].filter(node => !node.parentElement.closest('.el-tree-node')).map(node => {
      const content = node.querySelector(':scope > .el-tree-node__content');
      return { label:String(content?.innerText??'').replace(/\s+/gu,' ').trim(), expandable:Boolean(content?.querySelector('.el-tree-node__expand-icon:not(.is-leaf)')) };
    }));
    if (!roots.length || roots.length > 100 || roots.some(row => !row.label) || new Set(roots.map(row => row.label)).size !== roots.length) throw new Error('全书目录无法唯一验证');
    const scopes = [];
    for (const root of roots) {
      await this.guard({waitForEditors:false});
      const chapter = this.page.locator('.el-tree-node__content').filter({hasText:exactLabel(root.label)});
      if (await chapter.count() !== 1) throw new Error('盘点章节不唯一');
      const node = chapter.locator('xpath=..');
      if (root.expandable) {
        const expanded = await node.evaluate(element => element.classList.contains('is-expanded') || element.getAttribute('aria-expanded') === 'true');
        if (!expanded) await this._click(chapter);
        await waitVisibleByTimer(node.locator('.el-tree-node__children > .el-tree-node > .el-tree-node__content').first(),{timeout:this.timeout});
        const children = await node.evaluate(element => [...element.querySelectorAll(':scope > .el-tree-node__children > .el-tree-node')].map(child => ({label:String(child.querySelector(':scope > .el-tree-node__content')?.innerText??'').replace(/\s+/gu,' ').trim(),nested:Boolean(child.querySelector(':scope > .el-tree-node__content .el-tree-node__expand-icon:not(.is-leaf)'))})));
        if (!children.length || children.some(child => !child.label || child.nested) || new Set(children.map(child => child.label)).size !== children.length) throw new Error('盘点节目录存在空项、重复或未支持层级');
        scopes.push(...children.map(child => ({chapterLabel:root.label,sectionLabel:child.label})));
      } else scopes.push({chapterLabel:root.label,sectionLabel:root.label});
    }
    const results = [];
    for (const scope of scopes) {
      const serverSnapshotAt = new Date().toISOString();
      await this.directory({target:{...scope,record:1}});
      const row = {...scope,nodeID:this._nodeID,at:new Date().toISOString(),serverSnapshotAt,records:structuredClone(this._directoryRecords)};
      results.push(row); await onScope(row,results.length,scopes.length);
    }
    return results;
  }

  _recordLocator(number) {
    return this.page.locator('.shiti-cont').filter({
      has: this.page.locator('.shiti-sort').filter({ hasText: new RegExp(`^\\s*${number}[.、．。]?\\s*$`, 'u') }),
    });
  }

  async _selectRecord(record) {
    const locator = this._recordLocator(record.seqIndex);
    if (await locator.count() !== 1) throw new Error('题号无法唯一匹配');
    await this._click(locator);
    const expected = { seq: record.seqIndex, stem: record.question, answer: record.answer };
    await this.page.waitForFunction(({ seq, stem, answer }) => {
      const norm = html => {
        const node = document.createElement('div');
        node.innerHTML = html;
        const formulaSelector='math-tex,.formula-node[data-latex]';
        const formulaNodes = [...node.querySelectorAll(formulaSelector)].filter(element=>!element.parentElement?.closest(formulaSelector));
        const formulas = formulaNodes.map(element => {
          let latex;
          const wrapper=element.matches('math-tex'),nested=[...element.querySelectorAll('.formula-node[data-latex]')];
          if((wrapper&&nested.length>1)||(!wrapper&&nested.length))throw new Error('公式包含多个嵌套身份');
          const native=wrapper?nested[0]:element;
          if (!native) {
            latex = element.textContent.replace(/\u200b/gu, '').trim();
            if (latex.startsWith('$$') && latex.endsWith('$$')) latex = latex.slice(2, -2).trim();
            else if (latex.startsWith('$') && latex.endsWith('$')) latex = latex.slice(1, -1).trim();
            else if (latex.startsWith('$') || latex.endsWith('$')) throw new Error('math-tex公式定界符不完整');
          } else {
            try { latex = decodeURIComponent(native.getAttribute('data-latex')); }
            catch { throw new Error('公式data-latex编码无效'); }
            latex = latex.replace(/\u200b/gu, '').trim();
          }
          if (!latex) throw new Error('公式LaTeX为空');
          return latex;
        });
        // Saved math-tex carries source LaTeX; the visible formula-node may
        // carry MathJax SVG/text or only a zero-width placeholder. Formula
        // identity is the ordered LaTeX list, separate from ordinary content.
        formulaNodes.forEach(element => element.remove());
        const images = [...node.querySelectorAll('img')].map(element => element.getAttribute('src'));
        return JSON.stringify([node.textContent.replace(/[\s\u200b]+/gu, ''), formulas, images]);
      };
      const selected = document.querySelector('.shiti-cont-checked .shiti-sort');
      const a = document.querySelector('#contentedit .w-e-text');
      const b = document.querySelector('#answeredit .w-e-text');
      const loading = [...document.querySelectorAll('.el-loading-mask,[aria-busy="true"]')].some(element => getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0);
      return !loading && Number(selected?.innerText.trim().replace(/[.、．。]$/u, '')) === seq && a && b && norm(a.innerHTML) === norm(stem) && norm(b.innerHTML) === norm(answer);
    }, expected, { timeout: this.timeout, polling:80 });
    await this.page.waitForFunction(() => ['#contentedit .w-e-text', '#answeredit .w-e-text'].every(selector => [...document.querySelectorAll(`${selector} img`)].filter(image => !image.closest('math-tex,.formula-node[data-latex]')).every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)), null, { timeout: this.timeout, polling:80 });
  }

  async _hashImage(src) {
    let bytes;
    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/u);
      if (!match) throw new Error('回读图片数据 URL 无效');
      bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    } else if (src.startsWith('blob:')) {
      const base64 = await this.page.evaluate(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error('图片读取失败');
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        return btoa(binary);
      }, src);
      bytes = Buffer.from(base64, 'base64');
    } else {
      const url = new URL(src, this.page.url());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('回读图片来源协议不支持');
      // The URL came from a visible, persisted editor image; never synthesize API URLs.
      const response = await this.context.request.get(url.href, { timeout: this.timeout });
      if (!response.ok()) throw new Error('回读图片文件下载失败');
      bytes = await response.body();
    }
    if (!bytes.length) throw new Error('回读图片为空');
    return createHash('sha256').update(bytes).digest('hex');
  }

  async _editorRead(selector) {
    const result = await this.page.locator(selector).evaluate(editor => {
      const alignment = element => getComputedStyle(element).textAlign.replace(/^-webkit-(left|center|right)$/u, '$1');
      const formulaSelector = 'math-tex,.formula-node[data-latex]';
      const formulaNodes = [...editor.querySelectorAll(formulaSelector)].filter(element=>!element.parentElement?.closest(formulaSelector));
      const formulas = formulaNodes.map(element => {
        let latex;
        const wrapper=element.matches('math-tex'),nested=[...element.querySelectorAll('.formula-node[data-latex]')];
        if((wrapper&&nested.length>1)||(!wrapper&&nested.length))throw new Error('公式包含多个嵌套身份');
        const native=wrapper?nested[0]:element;
        if (!native) {
          latex = element.textContent.replace(/\u200b/gu, '').trim();
          if (latex.startsWith('$$') && latex.endsWith('$$')) latex = latex.slice(2, -2).trim();
          else if (latex.startsWith('$') && latex.endsWith('$')) latex = latex.slice(1, -1).trim();
          else if (latex.startsWith('$') || latex.endsWith('$')) throw new Error('math-tex公式定界符不完整');
        } else {
          try { latex = decodeURIComponent(native.getAttribute('data-latex')); }
          catch { throw new Error('公式data-latex编码无效'); }
          latex = latex.replace(/\u200b/gu, '').trim();
        }
        if (!latex) throw new Error('公式LaTeX为空');
        return { latex };
      });
      const ordinaryImages = element => [...element.querySelectorAll('img')].filter(image => !image.closest(formulaSelector));
      const ordinaryText = element => {
        if (!element.querySelector(formulaSelector)) return (element.innerText ?? element.textContent).replace(/\u200b/gu, '');
        const copy = element.cloneNode(true);
        copy.querySelectorAll(formulaSelector).forEach(formula => formula.remove());
        copy.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
        return copy.textContent.replace(/\u200b/gu, '');
      };
      const paragraphs = [...editor.children].map(element => ({ text: ordinaryText(element), align: alignment(element), direction: getComputedStyle(element).direction, imageCount: ordinaryImages(element).length }));
      return {
        html: editor.innerHTML,
        text: formulaNodes.length ? paragraphs.map(paragraph => paragraph.text).join('\n\n') : editor.innerText.replace(/\u200b/gu, ''),
        formulas,
        paragraphs,
        images: ordinaryImages(editor).map(image => ({
          src: image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
          align: alignment(image.closest('p,div') ?? image.parentElement),
        })),
      };
    });
    const native = await this.page.locator(selector).evaluate(readEditorNativeEmphasis);
    const scripts = await this.page.locator(selector).evaluate(readEditorNativeScripts);
    result.literalDollarSafety = await this.page.locator(selector).evaluate(readEditorLiteralDollarSafety);
    result.paragraphs.forEach((paragraph,index)=>{paragraph.nativeEmphasis=native[index];paragraph.nativeScripts=scripts[index];});
    for (const image of result.images) image.sha256 = await this._hashImage(image.src);
    return result;
  }

  _savedPendingMatchesRead(task) {
    const pending=this._pendingWrite;
    return Boolean(pending?.kind==='new-system-append-recovery' && pending.bookId===this.bookId && pending.created===true && ['pending','completed','reconciled'].includes(pending.status) && pending.observedSaveRequests===1 && typeof task?.id==='string' && pending.task?.id===task.id && scopeKey(pending.task.target)===scopeKey(task.target) && pending.task.target.record===task.target.record && isDeepStrictEqual(pending.task.source,task.source) && task.source?.pages && task.source?.answerPages && pending.receipt && verifyNewSystemSave(task,pending.receipt,{bookId:this.bookId}).ok);
  }

  _prewriteEmptyDirectoryMayRetry(task,diagnostic) {
    if(this._busy!==false || this._uncertain!==false || typeof task?.id!=='string' || !task.id || task.review?.status!=='approved' || !Array.isArray(task.review.issues) || task.review.issues.length) return false;
    const pending=this._pendingWrite;
    if(pending) {
      // A prior terminal intention is harmless only for a different task. Do
      // not treat an unknown/rejected save as a clean pre-write state.
      if(pending.schemaVersion!==1 || pending.kind!=='new-system-append-recovery' || pending.bookId!==this.bookId || !positive(pending.nodeID) || !pending.task?.target || !Array.isArray(pending.task.source?.pages) || !Array.isArray(pending.task.source?.answerPages) || !positive(pending.task.source.pages[0]) || !positive(pending.task.source.answerPages[0]) || typeof pending.task.id!=='string' || !pending.task.id || pending.task.id===task.id || (scopeKey(pending.task.target)===scopeKey(task.target) && pending.task.target.record===task.target.record) || !Number.isSafeInteger(pending.observedSaveRequests) || pending.observedSaveRequests<0) return false;
      const validReceipt=Boolean(pending.receipt && verifyNewSystemSave(pending.task,pending.receipt,{bookId:this.bookId}).ok);
      if(pending.receipt && !validReceipt) return false;
      if(pending.status==='completed') {
        if(pending.created!==true || pending.observedSaveRequests!==1 || !validReceipt) return false;
      } else if(pending.status==='reconciled') {
        if(!Number.isFinite(Date.parse(pending.recovery?.checkedAt))) return false;
        if(pending.recovery?.outcome==='saved') {if(!positive(pending.recovery.recordId)) return false;}
        else if(pending.recovery?.outcome!=='not_saved' || pending.observedSaveRequests!==0 || pending.receipt || pending.recovery.recordId!==null) return false;
      } else return false;
    }
    const url=diagnostic?.urlIdentity,dom=diagnostic?.dom,role=diagnostic?.error?.targetRole;
    return Boolean(diagnostic?.captureComplete===true && diagnostic.schemaVersion===1 && diagnostic.kind==='new-system-directory-visibility-diagnostic' && diagnostic.bookId===this.bookId && diagnostic.taskId===task.id && isDeepStrictEqual(diagnostic.target,task.target) && diagnostic.error?.code==='TARGET_VISIBILITY_TIMEOUT' && ['directory-chapter','directory-section'].includes(role) && diagnostic.timer?.targetRole===role && diagnostic.timer?.lastState?.count===0 && diagnostic.timer.lastState.visible===false && url?.validated===true && url.origin===this.origin && url.pathname==='/edu-shop-web/' && url.route===ROUTE && Number(url.textbookID)===this.bookId && url.textbookType==='main' && url.bookOccurrences===1 && url.typeOccurrences===1 && url.hasUrlCredentials===false && dom?.readyState==='complete' && dom.visibility==='visible' && dom.focused===true && [0,1].includes(dom.treeCount) && ['treeNodeCount','contentCount','visibleContentCount','chapterCount','chapterInnerTextCount','sectionCount'].every(key=>dom[key]===0) && ['roots','chapters','sections','ancestors'].every(key=>Array.isArray(dom[key]) && dom[key].length===0) && Array.isArray(dom.loading) && dom.loading.every(entry=>entry.visible===false));
  }

  async _captureDirectoryVisibilityDiagnostic(task,error,attempt) {
    const diagnostic={schemaVersion:1,kind:'new-system-directory-visibility-diagnostic',bookId:this.bookId,taskId:task.id??null,target:structuredClone(task.target),attempt,captureStartedAt:new Date().toISOString(),timer:structuredClone(error.visibilityDiagnostic??null),error:{code:error.code,targetRole:error.targetRole,message:error.message},urlIdentity:null,dom:null};
    try {
    await this.guard({waitForEditors:false});
    const url=new URL(this.page.url()),params=new URLSearchParams(url.hash.split('?')[1]??'');
    diagnostic.urlIdentity={origin:url.origin,pathname:url.pathname,route:url.hash.split('?')[0],textbookID:params.get('textbookID'),textbookType:params.get('textbookType'),bookOccurrences:params.getAll('textbookID').length,typeOccurrences:params.getAll('textbookType').length,hasUrlCredentials:Boolean(url.username||url.password)};
    diagnostic.urlIdentity.validated=url.origin===this.origin && url.pathname==='/edu-shop-web/' && url.hash.split('?')[0]===ROUTE && params.getAll('textbookID').length===1 && Number(params.get('textbookID'))===this.bookId && params.getAll('textbookType').length===1 && params.get('textbookType')==='main' && !url.username && !url.password;
    if(!diagnostic.urlIdentity.validated)throw new Error('只读目录诊断的书籍 URL 无法严格验证，禁止刷新重试');
    diagnostic.dom=await this.page.evaluate(({chapterLabel,sectionLabel})=>{
      const norm=value=>String(value??'').replace(/\s+/gu,' ').trim();
      const visible=element=>{const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&element.getClientRects().length>0;};
      const rect=element=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height};};
      const describe=element=>({innerText:norm(element.innerText),textContent:norm(element.textContent),visible:visible(element),rect:rect(element)});
      const contents=[...document.querySelectorAll('.el-tree-node__content')],chapters=contents.filter(element=>norm(element.textContent)===norm(chapterLabel));
      const sections=chapters.flatMap(element=>[...element.parentElement.querySelectorAll('.el-tree-node__content')].filter(child=>norm(child.textContent)===norm(sectionLabel)));
      const roots=[...document.querySelectorAll('.el-tree-node')].filter(element=>!element.parentElement.closest('.el-tree-node')).map(element=>element.querySelector(':scope > .el-tree-node__content')).filter(Boolean);
      const ancestors=chapters.map(element=>{const result=[];for(let node=element;node&&result.length<8;node=node.parentElement){const style=getComputedStyle(node);result.push({tag:node.tagName,id:node.id,className:String(node.className).slice(0,160),display:style.display,visibility:style.visibility,rect:rect(node)});}return result;});
      return {readyState:document.readyState,title:document.title,visibility:document.visibilityState,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},treeCount:document.querySelectorAll('.el-tree').length,treeNodeCount:document.querySelectorAll('.el-tree-node').length,contentCount:contents.length,visibleContentCount:contents.filter(visible).length,roots:roots.map(describe),chapterCount:chapters.length,chapterInnerTextCount:contents.filter(element=>norm(element.innerText)===norm(chapterLabel)).length,chapters:chapters.map(describe),sectionCount:sections.length,sections:sections.map(describe),ancestors,loading:[...document.querySelectorAll('.el-loading-mask,[aria-busy="true"]')].map(element=>({visible:visible(element),rect:rect(element)}))};
    },{chapterLabel:task.target.chapterLabel,sectionLabel:task.target.sectionLabel});
    await this.guard({waitForEditors:false});
    if(this.page.url()!==url.href)throw new Error('只读目录诊断期间 URL 改变，禁止刷新重试');
    diagnostic.capturedAt=new Date().toISOString();diagnostic.captureComplete=true;
    return diagnostic;
    } catch(captureError) {
      diagnostic.capturedAt=new Date().toISOString();diagnostic.captureComplete=false;diagnostic.captureError=captureError.message;
      captureError.directoryVisibilityDiagnostic=diagnostic;throw captureError;
    }
  }

  async _persistDirectoryVisibilityDiagnostic(task,diagnostic) {
    const pending=this._pendingWrite;
    if(pending?.bookId===this.bookId && typeof task.id==='string' && pending.task?.id===task.id && scopeKey(pending.task.target)===scopeKey(task.target) && pending.task.target.record===task.target.record) {
      pending.directoryVisibilityDiagnostics??=[];pending.directoryVisibilityDiagnostics.push(structuredClone(diagnostic));
      // A read-only diagnostic does not advance the prior save/completion time.
      await this._persistPendingWrite({touchUpdatedAt:false});
      return pending.evidencePath;
    }
    const folder=path.resolve(this.dataDir,'directory-visibility-diagnostics');await fs.mkdir(folder,{recursive:true});
    const file=path.join(folder,`book-${this.bookId}-${randomUUID()}.json`);await fs.writeFile(file,JSON.stringify(diagnostic,null,2),{flag:'wx'});return file;
  }

  async read(task, { refresh = false } = {}) {
    this._validateTarget(task);
    const reload=async()=>{
      // A refresh is valid even when the current page has no selected section.
      await this._reloadForFreshRead();
    };
    if (refresh) {
      try { await reload(); }
      catch (error) {
        if (error?.code === 'TARGET_VISIBILITY_TIMEOUT' && error.targetRole === 'directory-root') {
          // The root wait precedes the ordinary directory-selection catch.
          // Preserve evidence without another reload, click, Plus, or save.
          try {
            const diagnostic = await this._captureDirectoryVisibilityDiagnostic(task,error,1);
            diagnostic.phase = 'refresh-directory-root';
            diagnostic.savedReceiptBound = this._savedPendingMatchesRead(task);
            diagnostic.prewriteEmptyTreeRetryEligible = false;
            error.directoryVisibilityEvidencePath = await this._persistDirectoryVisibilityDiagnostic(task,diagnostic);
          } catch (captureError) {
            if (captureError.directoryVisibilityDiagnostic) {
              const partial = captureError.directoryVisibilityDiagnostic;
              partial.phase = 'refresh-directory-root';
              partial.prewriteEmptyTreeRetryEligible = false;
              try { error.directoryVisibilityEvidencePath = await this._persistDirectoryVisibilityDiagnostic(task,partial); }
              catch (persistError) { error.directoryDiagnosticPersistenceError = persistError.message; }
            }
            error.directoryDiagnosticError = captureError.message;
          }
        }
        throw error;
      }
    }
    const visibilityTimeout=error=>error?.code==='TARGET_VISIBILITY_TIMEOUT' && ['directory-chapter','directory-section'].includes(error.targetRole);
    try {await this.directory(task);}
    catch(firstError) {
      if(!refresh || !visibilityTimeout(firstError))throw firstError;
      const saveKnown=this._savedPendingMatchesRead(task);
      const capture=async(error,attempt)=>{
        let diagnostic;
        try {diagnostic=await this._captureDirectoryVisibilityDiagnostic(task,error,attempt);}
        catch(captureError) {
          if(captureError.directoryVisibilityDiagnostic) {
            const partial=captureError.directoryVisibilityDiagnostic;partial.savedReceiptBound=saveKnown;
            error.directoryVisibilityEvidencePath=await this._persistDirectoryVisibilityDiagnostic(task,partial);
          }
          throw captureError;
        }
        diagnostic.savedReceiptBound=saveKnown;
        diagnostic.prewriteEmptyTreeRetryEligible=this._prewriteEmptyDirectoryMayRetry(task,diagnostic);
        error.directoryVisibilityEvidencePath=await this._persistDirectoryVisibilityDiagnostic(task,diagnostic);
        return diagnostic;
      };
      // Diagnose before considering the one additional pure read. A failed
      // capture/checkpoint never permits another page action.
      let diagnostic;
      try {diagnostic=await capture(firstError,1);}catch(diagnosticError){firstError.directoryDiagnosticError=diagnosticError.message;throw firstError;}
      // The extra reload only repeats directory reading. Recheck the quiet
      // pre-write state after its durable diagnostic; never replay Plus/save.
      if(!saveKnown && !this._prewriteEmptyDirectoryMayRetry(task,diagnostic))throw firstError;
      await reload();
      try {await this.directory(task);}
      catch(secondError) {
        if(visibilityTimeout(secondError)) {
          try {await capture(secondError,2);}catch(diagnosticError){secondError.directoryDiagnosticError=diagnosticError.message;}
          secondError.directoryVisibilityRetryExhausted=true;secondError.cause??=firstError;
        }
        throw secondError;
      }
    }
    const target = task.target;
    const record = this._directoryRecords.find(entry => entry.seqIndex === Number(target.record));
    const base = { bookId: this.bookId, target: { ...target }, count: this._directoryRecords.length };
    if (!record) return { status: 'missing', ...base };
    const expectedID = target.expectedRecordId ?? task.expectedRecordId;
    if (expectedID !== undefined && Number(expectedID) !== record.shitiID) throw new Error('目标题号已对应其他服务器 ID，拒绝继续');
    await this._selectRecord(record);
    const stem = await this._editorRead('#contentedit .w-e-text');
    const answer = await this._editorRead('#answeredit .w-e-text');
    if (!await this._scopeMatches(target)) throw new Error('回读完成前目录发生变化');
    const windowCheck = this.focusMode==='background'&&this.windowMode==='minimized'
      ? {...await this._requireDocumentFocus('回读完成后'),checkedAt:new Date().toISOString()} : null;
    return {
      status: 'found', ...base, recordId: record.shitiID, stem, answer,
      mainPicNum: record.mainPicNum, answerPicNum: record.answerPicNum,
      source: { pages: [record.mainPicNum], answerPages: [record.answerPicNum] }, haveAnswer: record.haveAnswer,
      ...(windowCheck?{windowCheck}:{}),
    };
  }

  async _navigateSources(task) {
    const pages = [task.source?.pages?.[0], task.source?.answerPages?.[0]];
    if (pages.some(value => !positive(value))) throw new Error('正文和答案来源图片序号必须是正整数');
    const inputs = this.page.locator('input.el-input__inner');
    if (await inputs.count() !== 2) throw new Error('来源页码输入框数量改变，拒绝猜测定位');
    for (let side = 0; side < 2; side++) {
      const before = await this.page.evaluate(side => ({
        page: Number(document.querySelectorAll('input.el-input__inner')[side]?.value),
        src: document.querySelectorAll('.cropper-box-canvas img[alt="cropper-img"]')[side]?.src,
      }), side);
      await inputs.nth(side).fill(String(pages[side]));
      if(this.focusMode==='background'&&this.windowMode==='minimized')await this._click(inputs.nth(1-side));
      else await inputs.nth(side).press('Tab');
      await this.page.waitForFunction(({ side, number, before }) => {
        const inputs = document.querySelectorAll('input.el-input__inner');
        const images = document.querySelectorAll('.cropper-box-canvas img[alt="cropper-img"]');
        const image = images[side];
        return Number(inputs[side]?.value) === number && image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && (before.page === number || image.src !== before.src);
      }, { side, number: Number(pages[side]), before }, { timeout: this.timeout, polling:80 });
    }
    return pages.map(Number);
  }

  get usesSystemClipboard() {
    return this.inputMode === 'native-paste' && this.source === 'production' && !this.ownsContext && Boolean(this.page) && process.platform === 'win32';
  }

  async _writeSystemClipboard(payload) { return writeWindowsClipboardHtml(payload); }

  async _requireDocumentFocus(stage) {
    if (this.focusMode === 'background') {
      try { return await requireRecorderDocumentReady(this.page, {focusMode:this.focusMode,windowMode:this.windowMode,guard:()=>this.guard({waitForEditors:false})}); }
      catch (error) { throw new Error(`${stage}: ${error.message}`); }
    }
    // A document-level guard only: prior CUA attachment can enable focus
    // emulation, so hasFocus() does not prove the real Windows foreground window.
    if (!await this.page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())) throw new Error(`${stage}: 录入网页隐藏或没有文档焦点，${this.focusMode === 'background' ? '后台模式已停止且不会自动前置窗口，请检查原 Edge 页面' : '请保持原 Edge 页面处于前台'}`);
  }

  async _writeClipboard(html) {
    if (this.inputMode !== 'native-paste') throw new Error('browser-command 模式禁止访问剪贴板');
    if (this.usesSystemClipboard) {
      // CUA's page bridge can replace navigator.clipboard with a session-local
      // clipboard. An independent extension's native Ctrl+V uses Windows instead.
      // Supply only our prepared payload to the fixed hidden STA helper.
      const text = await this.page.evaluate(html => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.innerText || div.textContent || '';
      }, html);
      return this._writeSystemClipboard({ html, text });
    }
    await this.page.evaluate(async html => {
      const div = document.createElement('div');
      div.innerHTML = html;
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([div.innerText || div.textContent], { type: 'text/plain' }),
      })]);
    }, html);
  }

  async _clipboardPreflight(html) {
    if (this.inputMode === 'browser-command') {
      await this.guard();
      await this._activate();
      await this._requireDocumentFocus('浏览器编辑命令预检前（尚未新增题目）');
      const capable = await this.page.evaluate(() => {
        const selectors = ['#contentedit .w-e-text', '#answeredit .w-e-text'];
        return typeof document.execCommand === 'function' && typeof window.getSelection === 'function'
          && (typeof document.queryCommandSupported !== 'function' || document.queryCommandSupported('insertHTML'))
          && selectors.every(selector => {
            const editors = document.querySelectorAll(selector);
            return editors.length === 1 && editors[0].isContentEditable;
          });
      });
      if (!capable) throw new Error('浏览器编辑命令或两个编辑框能力未确认，尚未新增题目');
      return;
    }
    await this._activate();
    if (this.usesSystemClipboard) {
      await this._requireDocumentFocus('剪贴板预检前');
      try { await this._writeClipboard(html); }
      catch (error) { throw new Error(`Windows 系统剪贴板写入及本次内容回读预检失败，尚未新增题目: ${error.message}`); }
      await this._requireDocumentFocus('剪贴板预检后（尚未新增题目）');
      return;
    }
    const permission = await this.page.evaluate(async () => {
      if (!navigator.permissions?.query || !navigator.clipboard?.write || typeof ClipboardItem !== 'function') return 'unsupported';
      try { return (await navigator.permissions.query({ name: 'clipboard-write' })).state; }
      catch { return 'unsupported'; }
    });
    if (permission !== 'granted') throw new Error(`剪贴板写入权限未确认（${permission}），尚未新增题目`);
    try {
      // A real normal Clipboard API write proves the capability before any draft
      // is created. This never forces an extension-wide/browser permission override.
      await this._writeClipboard(html);
    } catch { throw new Error('正常剪贴板写入预检失败，尚未新增题目'); }
  }

  async _assertLiteralDollarEditors({stemHtml,answerHtml}) {
    if (this.inputMode !== 'browser-command') return;
    for (const [selector,html] of [['#contentedit .w-e-text',stemHtml],['#answeredit .w-e-text',answerHtml]]) {
      if (typeof html !== 'string' || !html.includes('$')) continue;
      const expected = await this.page.evaluate(prepareReviewedLiteralDollarHtml,html);
      await assertEditorLiteralDollarSafety(this.page,selector,expected);
    }
  }

  async _paste(selector, html, { replace = false } = {}) {
    if (this.inputMode === 'browser-command') {
      await this.guard();
      return insertReviewedEditorHtml(this.page, selector, html, { replace, timeoutMs:this.timeout, guard:() => this.guard(), focusMode:this.focusMode, windowMode:this.windowMode });
    }
    await this._activate();
    await this._requireDocumentFocus('原生粘贴准备');
    await this._writeClipboard(html);
    // The hidden native clipboard helper is a separate Windows process.
    // Re-activate the target tab after it returns, as in the successful probe.
    await this._activate();
    const editor = this.page.locator(selector);
    await this._click(editor);
    await this._requireDocumentFocus('原生粘贴前');
    if (replace) {
      await editor.press('Control+KeyA');
      const editorSelection = await editor.evaluate(element => {
        const selection = window.getSelection();
        return document.activeElement === element && selection?.rangeCount > 0 && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
      });
      if (!editorSelection) throw new Error('替换答案的选区不在目标编辑框内，拒绝粘贴');
    }
    await editor.press('Control+KeyV');
    await this.page.waitForFunction(({ selector, html }) => {
      const expected = document.createElement('div');
      expected.innerHTML = html;
      const actual = document.querySelector(selector);
      if (!actual) return false;
      const clean = text => text.replace(/\s+/gu, '');
      return clean(actual.textContent) === clean(expected.textContent) && actual.querySelectorAll('img').length === expected.querySelectorAll('img').length;
    }, { selector, html }, { timeout: this.timeout, polling:80 });
    await assertEditorNativeEmphasis(this.page,selector,html);
    await assertEditorNativeScripts(this.page,selector,html);
  }

  /** Reviewed answer content with the platform's own Add Analysis menu. */
  async _pasteReviewedAnswer(answer, {replace=false}={}) {
    const indices=answer.blocks.flatMap((block,index)=>block.type==='analysis-separator'?[index]:[]);
    if(!indices.length){await this._paste('#answeredit .w-e-text',renderEditorHtml(answer,this.baseDir),{replace});return {analysisButtonClicks:0};}
    if(indices.length!==1)throw new Error('答案只能含一个解析分隔标记');
    const index=indices[0],selector='#answeredit .w-e-text';
    if(this.focusMode==='background'&&this.windowMode==='minimized'){
      // Hidden windows do not reliably deliver the keyboard events wangEditor
      // uses to cache its toolbar selection. Insert the already reviewed fixed
      // platform marker with the same confined browser editing command as text.
      // This invokes ordinary editor input/autosave, not framework or save APIs.
      await this._paste(selector,renderEditorHtml(answer,this.baseDir),{replace});
      await this.page.waitForFunction(selector=>{
        const images=[...document.querySelector(selector).querySelectorAll('img')];
        return images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0&&image.naturalHeight>0);
      },selector,{timeout:this.timeout,polling:80});
      return {analysisButtonClicks:0,analysisSeparatorCount:1,analysisInputMethod:'browser-command-reviewed-native-image'};
    }
    const placeholder='<p style="text-align:left;direction:ltr" dir="ltr" align="left"><br></p>';
    const html=renderEditorHtml({blocks:answer.blocks.slice(0,index)},this.baseDir)+placeholder+renderEditorHtml({blocks:answer.blocks.slice(index+1)},this.baseDir);
    await this._paste(selector,html,{replace});
    const editor=this.page.locator(selector);
    await editor.evaluate((element,index)=>{
      const paragraph=element.children[index];
      if(!paragraph||paragraph.tagName!=='P'||paragraph.textContent.trim()||paragraph.querySelector('img,svg,math-tex,.formula-node'))throw new Error('解析插入位置与已审答案不一致');
      element.focus();const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(true);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    },index);
    await this.page.keyboard.press('Shift');
    await editor.evaluate((element,index)=>{
      const selection=window.getSelection(),paragraph=element.children[index];
      if(document.activeElement!==element||!selection?.isCollapsed||selection.rangeCount!==1||!paragraph.contains(selection.anchorNode)||!paragraph.contains(selection.focusNode))throw new Error('原生解析按钮的光标位置不正确');
    },index);
    await this._click(this.page.locator('#answeredit .w-e-menu').filter({hasText:/^\s*添加解析\s*$/u}));
    const expected=renderEditorHtml(answer,this.baseDir);
    await this.page.waitForFunction(({selector,html})=>{
      const actual=document.querySelector(selector),expected=document.createElement('div');expected.innerHTML=html;
      if(!actual)return false;
      const useful=element=>[...element.children].filter(child=>child.textContent.trim()||child.querySelector('img'));
      const got=useful(actual),want=useful(expected);
      const normalize=value=>value.replace(/[\s\u200b]+/gu,'');
      if(got.length!==want.length)return false;
      return got.every((paragraph,i)=>{
        const images=[...paragraph.querySelectorAll('img')],wanted=[...want[i].querySelectorAll('img')];
        return normalize(paragraph.textContent)===normalize(want[i].textContent)&&images.length===wanted.length&&images.every((image,j)=>image.src===wanted[j].src&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0);
      });
    },{selector,html:expected},{timeout:this.timeout,polling:80});
    await assertEditorNativeEmphasis(this.page,selector,expected);
    await assertEditorNativeScripts(this.page,selector,expected);
    return {analysisButtonClicks:1};
  }

  /** Explicitly authorized answer correction; ordinary batches never overwrite. */
  async replaceAnswer(task, { expectedBefore, checkpoint = async () => {} } = {}) {
    if (this._busy || this._uncertain) throw new Error('上次写入未完成核对，拒绝修改');
    const expectedID = task?.target?.expectedRecordId;
    if (!positive(expectedID) || JSON.stringify(task.target) !== JSON.stringify(expectedBefore?.target) || task.review?.status !== 'approved' || expectedBefore?.review?.status !== 'approved' || JSON.stringify(task.stem) !== JSON.stringify(expectedBefore.stem) || JSON.stringify(task.source) !== JSON.stringify(expectedBefore.source)) throw new Error('答案修正必须明确原题ID、原内容和保持一致的目录、题干及来源');
    this._busy = true;
    let edited = false;
    let saveResponse=null;
    let phase = 'existing-answer-readback';
    try {
      const before = await this.read(expectedBefore, { refresh: true });
      const match = compareNewSystemReadback(expectedBefore, before, { baseDir: this.baseDir, bookId: this.bookId });
      if (!match.ok) throw new Error('原记录与核对基线不符: ' + match.errors.join('; '));
      const priorRecords = structuredClone(this._directoryRecords);
      const count = priorRecords.length;
      const nodeID = this._nodeID;
      const html = renderEditorHtml(task.answer, this.baseDir);
      phase = 'answer-clipboard-preflight';
      const cursor = this._sequence;
      const saves = [];
      const observe = request => { if ((this._requests.get(request) ?? 0) > cursor && request.method() === 'POST' && requestMatches(request, this.origin, SAVE_PATH)) saves.push(request); };
      this.page.on('request', observe);
      try {
        await this._clipboardPreflight(html);
        if (saves.length) throw new Error('预检时出现意外保存');
        await checkpoint({ phase:'write-intent', bookId:this.bookId, recordId:Number(expectedID), record:task.target.record, mutation:'answer-only', priorRecords });
        saveResponse=this._captureSaveResponse(cursor);
        phase = 'replace-answer-native-paste';
        edited = true;
        const formatInput=await this._pasteReviewedAnswer(task.answer,{replace:true});
        await checkpoint({phase:'answer-format-input',...formatInput});
        await this._click(this.page.locator('input.el-input__inner').nth(0),{beforeInput:()=>this._assertLiteralDollarEditors({answerHtml:html})});
        phase = 'answer-save-business-receipt';
        const response=await saveResponse.wait();
        if (saves.length !== 1 || saves[0] !== response.request()) throw new Error('答案修正的保存次数与预期不符');
        const raw=parsePost(response.request());
        const request=reducedRequest(raw);
        const body=await response.json();
        const receipt={bookId:this.bookId,seqIndex:task.target.record,shitiID:safeNumber(body?.data?.shitiID),mainPicNum:task.source.pages[0],answerPicNum:task.source.answerPages[0],request,response:{status:response.status(),body:{errno:body.errno,errmsg:body.errmsg,data:{seqIndex:Number(body?.data?.seqIndex),shitiID:safeNumber(body?.data?.shitiID),haveAnswer:body?.data?.haveAnswer}}}};
        await checkpoint({phase:'receipt',receipt,saveRequests:saves.length});
        const verification=verifyNewSystemSave(task,receipt,{bookId:this.bookId,existingRecordId:Number(expectedID)});
        if (!verification.ok || Number(raw.nodeID)!==nodeID) throw new Error('答案修正业务或题目身份不符: '+verification.errors.join('; '));
        phase = 'corrected-answer-reload';
        const readback=await this.read(task,{refresh:true});
        const comparison=compareNewSystemReadback(task,readback,{baseDir:this.baseDir,bookId:this.bookId});
        await checkpoint({phase:'readback',readback,comparison});
        if (!comparison.ok || readback.count!==count || saves.length!==1) throw new Error('答案修正刷新核对失败: '+comparison.errors.join('; '));
        const withoutTargetAnswer=records=>records.map(r=>r.seqIndex===task.target.record?{...r,answer:null}:r);
        if (!isDeepStrictEqual(withoutTargetAnswer(priorRecords),withoutTargetAnswer(this._directoryRecords))) throw new Error('答案修正改变了其他题目或本题题干、来源、身份');
        receipt.preservedRecords=count;
        return {receipt,readback,comparison,saveRequests:saves.length,preservedRecords:count,plusClicks:0,...formatInput};
      } finally {saveResponse?.dispose();this.page.off('request',observe);}
    } catch(error) {
      if(edited)this._uncertain=true;
      throw new Error(`[${phase}] ${error.message}`,{cause:error});
    } finally {this._busy=false;}
  }

  get pendingWrite() { return this._pendingWrite ? structuredClone(this._pendingWrite) : null; }

  async _persistPendingWrite({touchUpdatedAt=true}={}) {
    if (!this._pendingWrite) return;
    const pending = this._pendingWrite;
    if(touchUpdatedAt)pending.updatedAt = new Date().toISOString();
    const folder = path.resolve(this.dataDir, 'new-system-recovery');
    if (!pending.evidencePath) pending.evidencePath = path.join(folder, `book-${this.bookId}-${randomUUID()}.pending.json`);
    const relative = path.relative(folder, pending.evidencePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') throw new Error('待恢复证据路径越界');
    await fs.mkdir(folder, { recursive:true });
    const temporary = pending.evidencePath + `.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(pending, null, 2), { flag:'wx' });
    await fs.rename(temporary, pending.evidencePath);
  }

  async append(task, { checkpoint = async () => {} } = {}) {
    if (this._busy || this._uncertain || this._pendingWrite?.status === 'pending') throw new Error('上次新增效果尚未核验，必须先核对恢复，拒绝再次写入');
    this._busy = true;
    let created = false;
    let saveResponse=null;
    let appendInput=null,modelReadiness=null,saveTrigger=null;
    let phase = 'directory';
    try {
      await this.directory(task);
      const number = Number(task.target.record);
      const priorRecords = structuredClone(this._directoryRecords);
      const numbers = this._directoryRecords.map(record => record.seqIndex);
      if (numbers.includes(number)) throw new Error('目标题号已存在，执行器只追加，不覆盖');
      if (numbers.some((value, index) => value !== index + 1) || number !== numbers.length + 1) throw new Error('目标必须是当前目录紧接着的下一题，目录题号不能有缺口');
      phase = 'source-pages';
      const [mainPicNum, answerPicNum] = await this._navigateSources(task);
      phase = 'render-content';
      const stemHtml = await renderEditorHtml(task.stem, this.baseDir);
      const answerHtml = await renderEditorHtml(task.answer, this.baseDir);
      phase = 'clipboard-preflight';
      await this._clipboardPreflight(answerHtml);
      const freshPending = { schemaVersion:1, kind:'new-system-append-recovery', status:'pending', bookId:this.bookId, nodeID:this._nodeID, task:structuredClone(task), priorRecords, phase:'before-plus', created:false, observedSaveRequests:0, receipt:null, startedAt:new Date().toISOString(), evidencePath:path.join(path.resolve(this.dataDir,'new-system-recovery'),`book-${this.bookId}-${randomUUID()}.pending.json`) };
      const freshIdentity = structuredClone(appendIntentIdentity(freshPending)), freshObservation = this.#pageObservation;
      this._pendingWrite = freshPending;
      phase = 'durable-write-intent';
      await this._persistPendingWrite(); // Durable before any draft or editing.
      if (this._pendingWrite !== freshPending || !isDeepStrictEqual(appendIntentIdentity(freshPending),freshIdentity)
        || this.#pageObservation !== freshObservation || this.page !== freshObservation?.page || this.context !== freshObservation?.context) {
        this.#liveAppendObservation = null; this._uncertain = true;
        throw new Error('保存原始意图期间对象或页面观察已改变，保留写入锁');
      }
      // This capability exists only for a fresh append, never deserialization.
      this.#liveAppendObservation = { pending:freshPending, observation:freshObservation,
        identity:freshIdentity, observedSaveRequests:freshPending.observedSaveRequests };
      const cursor = this._sequence;
      saveResponse=this._captureSaveResponse(cursor);
      phase = 'create-draft';
      if (this.usesSystemClipboard) await this._requireDocumentFocus('新增题目之前（尚未新增题目）');
      // A click may mutate the UI before its transport reports an error.
      created = true;
      this._pendingWrite.created = true;
      this._uncertain = true;
      await this._click(this.page.locator('.shiti-operate-btn .el-icon-plus'));
      phase = 'blank-draft-readback';
      await this.page.waitForFunction(() => ['#contentedit .w-e-text', '#answeredit .w-e-text'].every(selector => {
        const editor = document.querySelector(selector);
        return editor && !editor.innerText.trim() && editor.querySelectorAll('img,.formula-node').length === 0;
      }), null, { timeout: this.timeout, polling:80 });
      // Answer first: it must remain unsaved until the complete stem is pasted.
      phase = 'answer-native-paste-readback';
      const answerInput=await this._pasteReviewedAnswer(task.answer);
      phase = 'stem-native-paste-readback';
      const stemInput=await this._paste('#contentedit .w-e-text', stemHtml);
      appendInput={answer:answerInput??null,stem:stemInput??null};
      // Normal windows save through the verified source-input blur. Minimized
      // windows await the application model and activate the actual Save UI.
      if(this.focusMode==='background'&&this.windowMode==='minimized'){
        const requireNoEarlierSave=()=>{
          if(this._pendingWrite!==freshPending||freshPending.observedSaveRequests!==0||freshPending.receipt||freshPending.receiptConflict)
            throw new Error('新增保存之前已观察到保存或意图改变，保留写入锁');
        };
        requireNoEarlierSave();
        phase='append-model-readiness';
        modelReadiness=await waitForAppendAutosaveReady(this,task,{stemHtml,answerHtml,mainPicNum,answerPicNum});
        requireNoEarlierSave();
        freshPending.appendInput=structuredClone(appendInput);
        freshPending.modelReadiness=structuredClone(modelReadiness);
        await this._persistPendingWrite();
        requireNoEarlierSave();
        // Activate the real Save UI once while retaining the stem focus. Moving
        // focus to this button would also run the platform's native blur save.
        phase='save-business-receipt';
        saveTrigger=await this._click(this.page.locator('button.top-btn').filter({hasText:/^\s*保存\s*$/u}),{preserveEditorFocus:true,beforeInput:async()=>{
          requireNoEarlierSave();
          const snapshot=await this.page.evaluate(readAppendAutosaveSnapshot,{bookId:this.bookId,nodeID:this._nodeID,record:number,
            mainPicNum,answerPicNum,stemHtml,answerHtml,priorRecordIds:priorRecords.map(record=>record.shitiID)});
          requireNoEarlierSave();
          if(snapshot.ready!==true||snapshot.fatal.length||snapshot.differences.length||!isDeepStrictEqual(snapshot.identity,modelReadiness.identity)
            ||snapshot.url!==modelReadiness.windowCheck.url||snapshot.timeOrigin!==modelReadiness.windowCheck.timeOrigin){
            const error=new Error('保存按钮点击之前模型、已审内容或页面绑定改变，保留写入锁');
            error.appendModelReadiness={lastSnapshot:snapshot,windowCheck:modelReadiness.windowCheck};throw error;
          }
          await this._assertLiteralDollarEditors({stemHtml,answerHtml});
          requireNoEarlierSave();
        }});
        freshPending.saveTrigger=structuredClone(saveTrigger);
      }else{
        phase = 'save-business-receipt';
        saveTrigger=await this._click(this.page.locator('input.el-input__inner').nth(0),{beforeInput:()=>this._assertLiteralDollarEditors({stemHtml,answerHtml})});
      }
      const response = await saveResponse.wait();
      const requestBody = parsePost(response.request());
      const request = reducedRequest(requestBody);
      const body = await response.json();
      const recordID = safeNumber(body?.data?.shitiID);
      if (!response.ok() || body?.errno !== 0 || body.errmsg !== 'success' || !recordID || Number(body?.data?.seqIndex) !== number || body?.data?.haveAnswer !== true) throw new Error('新增自动保存业务结果未确认成功');
      if (request.bookId !== this.bookId || request.seqIndex !== number || request.mainPicNum !== mainPicNum || request.answerPicNum !== answerPicNum || request.shitiID !== undefined || Number(requestBody.nodeID) !== this._nodeID) throw new Error('新增请求的书、目录、题号、来源或身份不符合预期');
      const receipt = {
        bookId: this.bookId, seqIndex: number, shitiID: recordID, mainPicNum, answerPicNum,
        request, response: { status: response.status(), body: { errno: body.errno, errmsg: body.errmsg, data: { seqIndex: Number(body.data.seqIndex), shitiID: recordID, haveAnswer: body.data.haveAnswer } } },
        ...(modelReadiness?{appendInput,modelReadiness,saveTrigger}:{}),
      };
      phase = 'receipt-checkpoint';
      this._pendingWrite.receipt = structuredClone(receipt);
      this._pendingWrite.phase = phase;
      await this._persistPendingWrite();
      await checkpoint(receipt);
      // Reload before any further editing or Plus. It binds the saved server ID and
      // prevents the observed undefined-ID duplicate-creation race.
      phase = 'saved-record-reload-readback';
      const persisted = await this.read({ ...task, target: { ...task.target, expectedRecordId: recordID } }, { refresh: true });
      if (persisted.status !== 'found' || persisted.recordId !== recordID || persisted.count !== numbers.length + 1) throw new Error('保存后刷新回读的服务器身份或题目数量不一致');
      phase = 'prior-records-preservation';
      if (!isDeepStrictEqual(priorRecords, this._directoryRecords.slice(0, priorRecords.length))) throw new Error('保存后原有题目内容、身份、顺序或来源发生变化');
      receipt.preservedPriorRecords = priorRecords.length;
      receipt.reloadReadback = {schemaVersion:1,kind:'new-system-reload-readback',taskId:task.id,bookId:this.bookId,recordId:recordID,checkedAt:new Date().toISOString(),readback:structuredClone(persisted)};
      this._pendingWrite.status = 'completed';
      this._pendingWrite.phase = 'completed';
      await this._persistPendingWrite();
      this._uncertain = false;
      return receipt;
    } catch (error) {
      if (created) this._uncertain = true;
      if(modelReadiness||error.appendModelReadiness||phase==='append-model-readiness'||this.focusMode==='background'&&this.windowMode==='minimized'&&phase==='save-business-receipt'){
        try{
          const folder=path.resolve(this.dataDir,'append-save-input-diagnostics');await fs.mkdir(folder,{recursive:true});
          const diagnosticPath=path.join(folder,`book-${this.bookId}-${randomUUID()}.json`);
          await fs.writeFile(diagnosticPath,JSON.stringify({schemaVersion:1,kind:'new-system-append-save-input-diagnostic',bookId:this.bookId,taskId:task.id,
            phase,error:error.message,capturedAt:new Date().toISOString(),appendInput,modelReadiness,readinessFailure:error.appendModelReadiness??null,
            saveTrigger:saveTrigger??error.nativePointer??null,observedSaveRequests:this._pendingWrite?.observedSaveRequests??null},null,2),{flag:'wx'});
          if(this._pendingWrite)this._pendingWrite.inputDiagnosticPath=diagnosticPath;
        }catch(diagnosticError){error.diagnosticError=diagnosticError.message;}
      }
      if (phase === 'answer-native-paste-readback') {
        // Preserve the failed draft before recovery reloads it. Read only the
        // owned answer editor and its selection; never inspect other tabs.
        try {
          const snapshot = await this.page.evaluate(() => {
            const editor = document.querySelector('#answeredit .w-e-text');
            const selection = window.getSelection();
            return {
              url:location.href, timeOrigin:performance.timeOrigin,
              visibilityState:document.visibilityState, hasFocus:document.hasFocus(),
              answerHtml:editor?.innerHTML ?? null,
              activeEditor:document.activeElement === editor,
              selection:selection ? {
                rangeCount:selection.rangeCount, collapsed:selection.isCollapsed,
                anchorInEditor:Boolean(editor?.contains(selection.anchorNode)),
                focusInEditor:Boolean(editor?.contains(selection.focusNode)),
                anchorOffset:selection.anchorOffset, focusOffset:selection.focusOffset,
              } : null,
              images:[...(editor?.querySelectorAll('img') ?? [])].map(image => ({src:image.src,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight})),
            };
          });
          const folder = path.resolve(this.dataDir, 'answer-input-diagnostics');
          await fs.mkdir(folder, {recursive:true});
          const diagnosticPath = path.join(folder, `book-${this.bookId}-${randomUUID()}.json`);
          await fs.writeFile(diagnosticPath, JSON.stringify({bookId:this.bookId,taskId:task.id,phase,error:error.message,capturedAt:new Date().toISOString(),snapshot},null,2), {flag:'wx'});
          if (this._pendingWrite) this._pendingWrite.inputDiagnosticPath = diagnosticPath;
        } catch (diagnosticError) { error.diagnosticError = diagnosticError.message; }
      }
      if (this._pendingWrite?.status === 'pending') {
        this._pendingWrite.phase = phase;
        this._pendingWrite.created = created;
        this._pendingWrite.error = error.message;
        try { await this._persistPendingWrite(); }
        catch (persistError) { error = new Error(`${error.message}; 待恢复证据保存失败: ${persistError.message}`, { cause:error }); this._uncertain = true; }
      }
      const failure = new Error(`[${phase}] ${error.message}`, { cause: error });
      failure.phase = phase;
      throw failure;
    } finally { saveResponse?.dispose();this._busy = false; }
  }

  async reconcileHistoricalNetwork(task, {root,context,pendingPath,historicalNetworkEvidencePath,evidencePath,promote,validatorProfile}={}) {
    if(this._busy)throw new Error('写入仍在执行，不能并发历史核对');
    if(validatorProfile!==undefined&&this.source!=='fixture')throw new Error('生产历史核对不接受自定义证明规则');
    if(typeof promote!=='function')throw new Error('历史核对必须持有程序进度事务检查点');
    this._uncertain=true;this._busy=true;
    const page=this.page, browserContext=page?.context(), browser=browserContext?.browser?.(), channels=[];
    let continuous=true, saves=0,recoveryPending=null;
    const assert=(condition,message)=>{if(!condition)throw new Error(message);};
    const invalidate=()=>{continuous=false;};
    const watch=(emitter,entries)=>{
      assert(emitter&&['on','off','listeners'].every(key=>typeof emitter[key]==='function'),'当前历史核对缺少独立页面观察能力');
      const removed=(event,listener)=>{if(entries.some(([name,fn])=>name===event&&fn===listener))invalidate();};
      entries.push(['removeListener',removed],['removeListener',(event,listener)=>removed(event,listener)]);
      for(const [event,listener] of entries){emitter.on(event,listener);channels.push([emitter,event,listener]);}
    };
    const check=()=>assert(continuous&&saves===0&&this.page===page&&this.context===browserContext&&page.context()===browserContext
      &&browserContext.browser()===browser&&browser.isConnected()&&!page.isClosed()
      &&channels.every(([emitter,event,listener])=>emitter.listeners(event).includes(listener)),'历史核对期间页面/连接观察改变或出现新的保存请求，保留写入锁');
    try {
      watch(page,[['request',request=>{if(request.method()==='POST'&&requestMatches(request,this.origin,SAVE_PATH))saves++;}],['close',invalidate],['crash',invalidate]]);
      watch(browserContext,[['close',invalidate]]);watch(browser,[['disconnected',invalidate]]);check();
      await this.guard({waitForEditors:false});check();
      const frozen=await readHistoricalNetworkEvidence(root,historicalNetworkEvidencePath,{context,pendingPath});check();
      const validation=validateHistoricalNetworkRecovery(frozen.input,validatorProfile===undefined?{}:{profile:validatorProfile});
      assert(validation.valid&&validation.proof,'冻结原MCP历史不能证明未发送保存：'+validation.errors.join('; '));
      const pending=JSON.parse(frozen.input.pendingBytes),candidate=validation.proof;
      assert(pending.bookId===this.bookId&&isDeepStrictEqual(pending.task,task)&&candidate.manifestHash===context.state.manifestHash
        &&isDeepStrictEqual(JSON.parse(frozen.input.failedBatch.manifestBytes),context.manifest)
        &&isDeepStrictEqual(JSON.parse(frozen.input.failedBatch.stateBytes),context.state),'历史证明没有绑定当前原任务/题单/进度');
      assert(!pending.receipt&&!pending.receiptConflict&&(!this._pendingWrite||isDeepStrictEqual(appendIntentIdentity(this._pendingWrite),appendIntentIdentity(pending)))
        &&!this._pendingWrite?.receipt&&!this._pendingWrite?.receiptConflict&&!this._pendingWrite?.observedSaveRequests&&!this.#liveAppendObservation?.observedSaveRequests,'当前意图或已知保存证据与历史未保存证明冲突');
      assert(await writableWorkspacePath(root,pending.evidencePath)===frozen.originalPendingPath,'原保存意图证据路径未绑定原文件');check();recoveryPending=pending;
      const found=await this.read(task,{refresh:true});check();
      assert(found.status==='missing'&&found.bookId===this.bookId&&found.count===pending.priorRecords.length&&this._nodeID===pending.nodeID
        &&isDeepStrictEqual(found.target,task.target)&&isDeepStrictEqual(this._directoryRecords,pending.priorRecords),'当前刷新后目标题或完整原目录基线改变');
      await frozen.recheck();check();
      const output=await writableWorkspacePath(root,evidencePath),checkedAt=new Date().toISOString();
      const historicalNetworkProof={...candidate,bundleSha256:frozen.bundleSha256,originalPendingPath:frozen.originalPendingPath,
        currentManifest:frozen.currentManifest,currentState:frozen.currentState,
        freshConfirmation:{schemaVersion:1,kind:'fresh-read-after-frozen-network-history',checkedAt,nodeID:pending.nodeID,
          priorRecordIds:pending.priorRecords.map(record=>record.shitiID),targetMissing:true,priorRecordsUnchanged:true,noNewSaveObserved:true,evidencePath:output}};
      const result={...found,recovery:{outcome:'not_saved',writeUnlocked:true,bookId:this.bookId,taskId:task.id,recordId:null,nodeID:pending.nodeID,
        priorRecordIds:pending.priorRecords.map(record=>record.shitiID),priorRecordsUnchanged:true,targetRecordUnique:false,fullContentCompared:false,
        liveNoSaveRequests:false,historicalNetworkProof,evidencePath:output}};
      assert(validHistoricalNetworkRecoveryProof(historicalNetworkProof,{bookId:this.bookId,taskId:task.id,target:task.target,manifestHash:context.state.manifestHash,...(validatorProfile===undefined?{}:{profile:validatorProfile})}),'历史核对最终证明字段不完整');
      // Reserve a distinct audit path without publishing an unlock before the
      // pending and program-state transaction has actually completed.
      const unknown=()=>({...found,recovery:{outcome:'unknown',writeUnlocked:false,bookId:this.bookId,taskId:task.id,evidencePath:output}});
      await fs.writeFile(output,JSON.stringify(unknown(),null,2),{flag:'wx'});check();
      await frozen.recheck();check();
      // Historical qualification does not create a fresh append capability.
      this._pendingWrite=structuredClone(pending);this._pendingWrite.status='reconciled';
      this._pendingWrite.recovery={outcome:'not_saved',recordId:null,checkedAt,historicalNetworkProof};
      let rollback;
      try {
        await this._persistPendingWrite();check();
        await frozen.recheck({originalPending:false});check();
        rollback=await promote(result,check);assert(typeof rollback==='function','历史核对缺少原进度事务回退保护');check();
        await fs.writeFile(output,JSON.stringify(result,null,2));check();
      } catch(error) {
        this._pendingWrite.status='pending';this._pendingWrite.recovery={outcome:'unknown',errors:[error.message],checkedAt:new Date().toISOString()};
        this._pendingWrite.observedSaveRequests=Math.max(this._pendingWrite.observedSaveRequests,saves);
        try {await this._persistPendingWrite();await fs.writeFile(output,JSON.stringify(unknown(),null,2));}
        finally {if(rollback)await rollback(error);}
        throw error;
      }
      this._uncertain=false;
      return result;
    } catch(error) {
      if(recoveryPending&&(saves>0||!continuous)){
        this._pendingWrite??=structuredClone(recoveryPending);this._pendingWrite.status='pending';
        this._pendingWrite.observedSaveRequests=Math.max(this._pendingWrite.observedSaveRequests,saves);
        this._pendingWrite.recovery={outcome:'unknown',errors:[error.message],checkedAt:new Date().toISOString()};
        await this._persistPendingWrite();
      }
      throw error;
    } finally {for(const [emitter,event,listener] of channels)emitter.off(event,listener);this._busy=false;}
  }

  async reconcile(task, options = {}) {
    if (this._busy) throw new Error('写入仍在执行，不能并发恢复');
    const live = this.#liveAppendObservation;
    // Latch an observed mutation/gap even when validation below rejects early.
    if (live) this.#hasLiveAppendObservation(live.pending);
    const supplied = options.pendingWrite;
    const pending = supplied ?? this._pendingWrite;
    if (!pending || (!supplied && !this._uncertain && pending.status !== 'pending')) return this.read(task, { ...options, refresh:true });
    this._uncertain = true;
    const prior = pending.priorRecords;
    const ids = new Set();
    if (pending.schemaVersion !== 1 || pending.kind !== 'new-system-append-recovery' || !['pending','completed','reconciled'].includes(pending.status) || pending.bookId !== this.bookId || !positive(pending.nodeID) || !isDeepStrictEqual(pending.task, task) || task.review?.status !== 'approved' || !Array.isArray(task.review.issues) || task.review.issues.length || !Array.isArray(prior) || prior.length !== task.target.record - 1 || !Number.isSafeInteger(pending.observedSaveRequests) || pending.observedSaveRequests < 0) throw new Error('待恢复意图、已审题单或原记录基线不完整，保留写入锁');
    for (const [index, record] of prior.entries()) {
      if (record.seqIndex !== index + 1 || !positive(record.shitiID) || ids.has(record.shitiID) || record.nodeID !== pending.nodeID || !positive(record.mainPicNum) || !positive(record.answerPicNum) || typeof record.question !== 'string' || typeof record.answer !== 'string' || typeof record.haveAnswer !== 'boolean') throw new Error('待恢复原记录身份、完整内容或来源无效，保留写入锁');
      ids.add(record.shitiID);
    }
    const sameLiveIdentity = live && isDeepStrictEqual(appendIntentIdentity(pending),live.identity)
      && isDeepStrictEqual(appendIntentIdentity(live.pending),live.identity);
    if (sameLiveIdentity) {
      live.observedSaveRequests = Math.max(live.observedSaveRequests,
        Number.isSafeInteger(live.pending.observedSaveRequests) ? live.pending.observedSaveRequests : 0, pending.observedSaveRequests);
      live.pending.observedSaveRequests = live.observedSaveRequests;
      if (pending.receipt && !live.pending.receipt) live.pending.receipt = structuredClone(pending.receipt);
      else if (pending.receipt && !isDeepStrictEqual(pending.receipt,live.pending.receipt)) {
        live.receiptConflict = true; live.observation.continuous = false;
      }
      if (pending.receiptConflict === true || live.pending.receiptConflict === true || live.receiptConflict) {
        live.receiptConflict = true; live.pending.receiptConflict = true; live.observation.continuous = false;
      }
    }
    // A continuity gap removes the no-SAVE capability, not a known receipt.
    const retainedReceipt = sameLiveIdentity ? live.pending.receipt : null;
    const liveObservation = this.#hasLiveAppendObservation(live?.pending)
      && isDeepStrictEqual(appendIntentIdentity(pending), live.identity);
    if (liveObservation) {
      live.observedSaveRequests = Math.max(live.observedSaveRequests, live.pending.observedSaveRequests, pending.observedSaveRequests);
      live.pending.observedSaveRequests = live.observedSaveRequests;
      this._pendingWrite = live.pending;
    } else {
      if (live) live.observation.continuous = false;
      this._pendingWrite = structuredClone(pending);
      if (sameLiveIdentity) this._pendingWrite.observedSaveRequests = live.observedSaveRequests;
      if (sameLiveIdentity && live.receiptConflict) this._pendingWrite.receiptConflict = true;
      if (!this._pendingWrite.receipt && retainedReceipt) this._pendingWrite.receipt = structuredClone(retainedReceipt);
    }
    this._pendingWrite.status = 'pending'; // Re-prove restored confirmations too.
    const result = await this.read(task, { refresh:true });
    const current = this._directoryRecords;
    const errors = [];
    let outcome = 'unknown';
    if (this._nodeID !== pending.nodeID || result.bookId !== pending.bookId || scopeKey(result.target) !== scopeKey(task.target)) errors.push('刷新目录或书籍身份改变');
    else if (result.status === 'missing') {
      if (!isDeepStrictEqual(current, prior) || result.count !== prior.length) errors.push('缺失目标但原列表发生变化');
      else if (!liveObservation || !this.#hasLiveAppendObservation(this._pendingWrite) || live.observedSaveRequests !== 0 || this._pendingWrite.observedSaveRequests !== 0 || this._pendingWrite.receipt || pending.receipt) errors.push('存在保存请求或已丢失同连接观察，不能证明未保存');
      else outcome = 'not_saved';
    } else if (result.status === 'found') {
      if (this._pendingWrite.receiptConflict === true || sameLiveIdentity && live.receiptConflict) errors.push('同一保存意图存在相互冲突的已知回执，保留写入锁');
      if (current.length !== prior.length + 1 || !isDeepStrictEqual(current.slice(0, prior.length), prior)) errors.push('原记录完整内容、身份、顺序或来源改变');
      const added = current.at(-1);
      if (added?.seqIndex !== task.target.record || added?.nodeID !== pending.nodeID || added?.shitiID !== result.recordId || ids.has(result.recordId) || added?.mainPicNum !== task.source.pages[0] || added?.answerPicNum !== task.source.answerPages[0] || added?.haveAnswer !== true) errors.push('新增记录身份、来源或答案标记不符');
      const compared = compareNewSystemReadback(task, result, { baseDir:this.baseDir, bookId:this.bookId });
      errors.push(...compared.errors);
      for (const receipt of new Set([pending.receipt, this._pendingWrite.receipt, retainedReceipt].filter(Boolean))) {
        errors.push(...verifyNewSystemSave(task, receipt, { bookId:this.bookId }).errors);
        if (receipt.shitiID !== result.recordId) errors.push('保存回执与服务器ID不同');
      }
      if (!errors.length) outcome = 'saved';
    } else errors.push('刷新结果不明确');
    if (errors.length || outcome === 'unknown') {
      this._pendingWrite.recovery = { outcome:'unknown', errors, checkedAt:new Date().toISOString() };
      await this._persistPendingWrite();
      return { ...result, recovery:{ outcome:'unknown', writeUnlocked:false, errors, evidencePath:this._pendingWrite.evidencePath } };
    }
    this._pendingWrite.status = 'reconciled';
    this._pendingWrite.recovery = { outcome, recordId:result.recordId ?? null, checkedAt:new Date().toISOString() };
    await this._persistPendingWrite();
    // A SAVE or observation gap during the durable checkpoint cannot unlock.
    if (outcome === 'not_saved' && (!this.#hasLiveAppendObservation(this._pendingWrite) || live.observedSaveRequests !== 0 || this._pendingWrite.observedSaveRequests !== 0 || this._pendingWrite.receipt)) {
      this._pendingWrite.status = 'pending';
      const errors = ['未保存证明持久化期间存在保存请求或连续观察已丢失，保留写入锁'];
      this._pendingWrite.recovery = { outcome:'unknown', errors, checkedAt:new Date().toISOString() };
      await this._persistPendingWrite();
      return { ...result, recovery:{ outcome:'unknown', writeUnlocked:false, errors, evidencePath:this._pendingWrite.evidencePath } };
    }
    this._uncertain = false; // Only after full proof and its durable checkpoint.
    return { ...result, recovery:{ outcome, writeUnlocked:true, taskId:task.id, bookId:this.bookId, recordId:result.recordId ?? null, nodeID:pending.nodeID, priorRecordIds:prior.map(record=>record.shitiID), priorRecordsUnchanged:true, targetRecordUnique:outcome === 'saved', fullContentCompared:outcome === 'saved', liveNoSaveRequests:outcome === 'not_saved', evidencePath:this._pendingWrite.evidencePath, receiptKnown:Boolean(pending.receipt || this._pendingWrite.receipt || retainedReceipt) } };
  }

  async close() {
    if (this.#pageObservation) this.#pageObservation.continuous = false;
    if (this.ownsContext) await this.context?.close();
    this.page = null;
    this.context = null;
  }
}
