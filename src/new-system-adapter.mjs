import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import { renderEditorHtml, compareNewSystemReadback, verifyNewSystemSave } from './new-system-core.mjs';
import { writeWindowsClipboardHtml } from './windows-html-clipboard.mjs';
import { insertReviewedEditorHtml } from './browser-editor-command.mjs';
import { checkedPointerClick } from './checked-pointer-click.mjs';
import { waitVisibleByTimer } from './timer-visible-wait.mjs';
import { captureResponseBeforeWait } from './deferred-response-wait.mjs';

const SITE = 'https://easylearn.baidu.com';
const LIST_PATH = '/edushop/textbook/detail/shitilist';
const SAVE_PATH = '/edushop/textbook/myproducecommit/editshiti';
const ROUTE = '#/content-manager/teaching-content';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const label = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const scopeKey = target => JSON.stringify([label(target.chapterLabel), label(target.sectionLabel)]);
const exactLabel = value => new RegExp(`^\\s*${label(value).split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+')}\\s*$`, 'u');

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
  constructor({ baseDir, dataDir, profileDir, page = null, source = 'production', origin = SITE, timeout = 20000, inputMode = 'native-paste' } = {}) {
    if (!['native-paste', 'browser-command'].includes(inputMode)) throw new Error('inputMode 必须是 native-paste 或 browser-command');
    this.inputMode = inputMode;
    this.baseDir = path.resolve(baseDir ?? process.cwd());
    this.dataDir = path.resolve(dataDir ?? path.join(this.baseDir, 'data'));
    this.profileDir = path.resolve(profileDir ?? path.join(this.dataDir, 'new-system-edge-profile'));
    this.source = source;
    this.origin = new URL(origin).origin;
    this.timeout = timeout;
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
    this._observedPage = page;
    page.on('request', request => {
      this._requests.set(request, ++this._sequence);
      if (this._pendingWrite?.status === 'pending' && requestMatches(request, this.origin, SAVE_PATH) && request.method() === 'POST') this._pendingWrite.observedSaveRequests += 1;
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        this._directoryKey = null;
        this._directoryRecords = [];
        this._nodeID = null;
      }
    });
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
      const parent = node?.parentElement?.closest('.el-tree-node');
      const chapter = parent?.querySelector(':scope > .el-tree-node__content');
      const sectionLabel = norm(section?.innerText);
      return { chapterLabel: chapter ? norm(chapter.innerText) : sectionLabel, sectionLabel };
    });
  }

  async _scopeMatches(target) {
    const selected = await this._selectedScope();
    return selected.chapterLabel === label(target.chapterLabel) && selected.sectionLabel === label(target.sectionLabel);
  }

  async _click(locator) {
    // Reload can leave the extension's tab in the background. Re-select the
    // guarded page before each pointer operation instead of relying on the
    // once-per-command activation before that reload.
    await this.page.bringToFront();
    return checkedPointerClick(this.page, locator, { timeout:this.timeout, guard:() => this.guard({waitForEditors:false}) });
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

  async directory(task) {
    const target = this._validateTarget(task);
    // Reload may leave no section selected and both editors hidden. Validate
    // identity first; editor visibility becomes required after scope selection.
    await this.guard({ waitForEditors: false });
    await this.page.bringToFront();
    if (this._directoryKey === scopeKey(target) && await this._scopeMatches(target)) {
      await this._stableList(this._directoryRecords);
      await this.guard();
      return;
    }
    // Clicking an already selected section need not emit LIST. A fresh adapter
    // has no authoritative cached list, so reload instead of waiting for a
    // request the UI has no reason to send. Never synthesize/replay an API call.
    if (await this._scopeMatches(target)) {
      await this.page.reload({ waitUntil:'domcontentloaded' });
      await this.page.bringToFront();
      this._directoryKey = null;
      this._directoryRecords = [];
      this._nodeID = null;
      await this.guard({ waitForEditors:false });
      if (await this._scopeMatches(target)) throw new Error('刷新后目录仍已选中且无可信列表，拒绝等待不存在的列表请求');
    }
    const chapter = this.page.locator('.el-tree-node__content').filter({ hasText: exactLabel(target.chapterLabel) });
    // The directory tree itself loads asynchronously after reload. An immediate
    // count of zero is not evidence that the chapter is absent.
    await waitVisibleByTimer(chapter,{timeout:this.timeout,name:'章节 '+target.chapterLabel,targetRole:'directory-chapter'});
    if (await chapter.count() !== 1) throw new Error('章节标签无法唯一匹配');
    const chapterNode = chapter.locator('xpath=..');
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
    await waitVisibleByTimer(section,{timeout:this.timeout,name:'节目录 '+target.sectionLabel,targetRole:'directory-section'});
    if (await section.count() !== 1) throw new Error('该章节下的节标签无法唯一匹配');
    const cursor = this._sequence;
    const responsePromise = this.page.waitForResponse(response => {
      const request = response.request();
      if ((this._requests.get(request) ?? 0) <= cursor || !requestMatches(request, this.origin, LIST_PATH)) return false;
      const url = new URL(request.url());
      return Number(url.searchParams.get('textbookID')) === this.bookId && positive(url.searchParams.get('nodeID'));
    }, { timeout: this.timeout });
    // Handle rejection immediately, including when click itself throws.
    responsePromise.catch(() => {});
    await this._click(section);
    const response = await responsePromise;
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
      await this.guard({ waitForEditors: false });
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.bringToFront();
      this._directoryKey = null;this._directoryRecords=[];this._nodeID=null;
    };
    if (refresh) await reload();
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
    return {
      status: 'found', ...base, recordId: record.shitiID, stem, answer,
      mainPicNum: record.mainPicNum, answerPicNum: record.answerPicNum,
      source: { pages: [record.mainPicNum], answerPages: [record.answerPicNum] }, haveAnswer: record.haveAnswer,
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
      await inputs.nth(side).press('Tab');
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
    // A document-level guard only: prior CUA attachment can enable focus
    // emulation, so hasFocus() does not prove the real Windows foreground window.
    if (!await this.page.evaluate(() => document.hasFocus())) throw new Error(`${stage}: 录入网页没有文档焦点，请保持原 Edge 页面处于前台`);
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
      await this.page.bringToFront();
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
    await this.page.bringToFront();
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

  async _paste(selector, html, { replace = false } = {}) {
    if (this.inputMode === 'browser-command') {
      await this.guard();
      return insertReviewedEditorHtml(this.page, selector, html, { replace, timeoutMs:this.timeout, guard:() => this.guard() });
    }
    await this.page.bringToFront();
    await this._requireDocumentFocus('原生粘贴准备');
    await this._writeClipboard(html);
    // The hidden native clipboard helper is a separate Windows process.
    // Re-activate the target tab after it returns, as in the successful probe.
    await this.page.bringToFront();
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
        await this._paste('#answeredit .w-e-text', html, {replace:true});
        await this._click(this.page.locator('input.el-input__inner').nth(0));
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
        return {receipt,readback,comparison,saveRequests:saves.length,preservedRecords:count,plusClicks:0};
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
      this._pendingWrite = { schemaVersion:1, kind:'new-system-append-recovery', status:'pending', bookId:this.bookId, nodeID:this._nodeID, task:structuredClone(task), priorRecords, phase:'before-plus', created:false, observedSaveRequests:0, receipt:null, startedAt:new Date().toISOString() };
      phase = 'durable-write-intent';
      await this._persistPendingWrite(); // Durable before any draft or editing.
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
      await this._paste('#answeredit .w-e-text', answerHtml);
      phase = 'stem-native-paste-readback';
      await this._paste('#contentedit .w-e-text', stemHtml);
      // wangEditor handles Tab as an insertion command. Blur by clicking the
      // already verified source-page input instead, without changing its value.
      phase = 'save-business-receipt';
      await this._click(this.page.locator('input.el-input__inner').nth(0));
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

  async reconcile(task, options = {}) {
    if (this._busy) throw new Error('写入仍在执行，不能并发恢复');
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
    const liveObservation = !supplied && pending === this._pendingWrite;
    this._pendingWrite = structuredClone(pending);
    this._pendingWrite.status = 'pending'; // Re-prove restored confirmations too.
    const result = await this.read(task, { refresh:true });
    const current = this._directoryRecords;
    const errors = [];
    let outcome = 'unknown';
    if (this._nodeID !== pending.nodeID || result.bookId !== pending.bookId || scopeKey(result.target) !== scopeKey(task.target)) errors.push('刷新目录或书籍身份改变');
    else if (result.status === 'missing') {
      if (!isDeepStrictEqual(current, prior) || result.count !== prior.length) errors.push('缺失目标但原列表发生变化');
      else if (!liveObservation || this._pendingWrite.observedSaveRequests !== 0 || pending.receipt) errors.push('存在保存请求或已丢失同连接观察，不能证明未保存');
      else outcome = 'not_saved';
    } else if (result.status === 'found') {
      if (current.length !== prior.length + 1 || !isDeepStrictEqual(current.slice(0, prior.length), prior)) errors.push('原记录完整内容、身份、顺序或来源改变');
      const added = current.at(-1);
      if (added?.seqIndex !== task.target.record || added?.nodeID !== pending.nodeID || added?.shitiID !== result.recordId || ids.has(result.recordId) || added?.mainPicNum !== task.source.pages[0] || added?.answerPicNum !== task.source.answerPages[0] || added?.haveAnswer !== true) errors.push('新增记录身份、来源或答案标记不符');
      const compared = compareNewSystemReadback(task, result, { baseDir:this.baseDir, bookId:this.bookId });
      errors.push(...compared.errors);
      if (pending.receipt) {
        errors.push(...verifyNewSystemSave(task, pending.receipt, { bookId:this.bookId }).errors);
        if (pending.receipt.shitiID !== result.recordId) errors.push('保存回执与服务器ID不同');
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
    this._uncertain = false; // Only after full proof and its durable checkpoint.
    return { ...result, recovery:{ outcome, writeUnlocked:true, taskId:task.id, bookId:this.bookId, recordId:result.recordId ?? null, nodeID:pending.nodeID, priorRecordIds:prior.map(record=>record.shitiID), priorRecordsUnchanged:true, targetRecordUnique:outcome === 'saved', fullContentCompared:outcome === 'saved', liveNoSaveRequests:outcome === 'not_saved', evidencePath:this._pendingWrite.evidencePath, receiptKnown:Boolean(pending.receipt) } };
  }

  async close() {
    if (this.ownsContext) await this.context?.close();
    this.page = null;
    this.context = null;
  }
}
