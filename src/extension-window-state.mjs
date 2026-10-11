const states = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const error = message => new Error('Recorder extension window bridge: ' + message);

/** A connection-owned, inactive extension page supplies only window state.
 * It never reads the status page DOM, takes snapshots, or exports console data.
 * The official extension and its command allowlist remain unchanged. */
export function installExtensionRecorderWindowBridge({ browser, model, extensionId }) {
  if (!browser || !model || !/^[a-p]{32}$/u.test(extensionId)
      || !(model._tabSessions instanceof Map) || !(model._knownTabs instanceof Map)
      || typeof model._sendToExtension !== 'function' || typeof model._attachTab !== 'function'
      || typeof model.sendCommand !== 'function') throw error('unsupported transport');
  if (browser.__textbookRecorderWindowBridge) throw error('bridge already installed');
  const helperUrl = `chrome-extension://${extensionId}/status.html`;
  let helper, attempted = false, failed = false, cleanupAttempted = false, busy = false;
  let normalBinding;

  function bind(page) {
    if (!page || page.isClosed() || page.context().browser() !== browser) throw error('page owner changed');
    let impl;
    try { impl = page._connection.toImpl(page); } catch { throw error('page implementation unavailable'); }
    const targetId = impl?.delegate?._targetId;
    const sessionId = impl?.delegate?._mainFrameSession?._client?._sessionId;
    if (typeof targetId !== 'string' || !targetId || typeof sessionId !== 'string' || !sessionId) throw error('top-level page session unavailable');
    const matches = [...model._tabSessions.values()].filter(s => s.targetInfo?.targetId === targetId && s.sessionId === sessionId);
    if (matches.length !== 1 || !positive(matches[0].tabId)) throw error('page tab binding is not unique');
    const session = matches[0], url = page.url();
    if (typeof url !== 'string' || !/^https:\/\//u.test(url)) throw error('unsupported recorder page');
    return { page, session, targetId, sessionId, tabId:session.tabId, url };
  }
  function assertBinding(binding) {
    const current = bind(binding.page);
    if (current.session !== binding.session || current.targetId !== binding.targetId
        || current.sessionId !== binding.sessionId || current.tabId !== binding.tabId
        || current.url !== binding.url) throw error('page tab binding changed');
  }
  function assertHelper() {
    if (!helper?.session || typeof helper.targetId !== 'string' || !helper.targetId
        || typeof helper.sessionId !== 'string' || !helper.sessionId || helper.session.tabId !== helper.tabId
        || model._tabSessions.get(helper.tabId) !== helper.session
        || helper.session.targetInfo?.targetId !== helper.targetId
        || helper.session.sessionId !== helper.sessionId) throw error('helper identity changed');
  }
  async function runtime(expression, binding) {
    assertBinding(binding); assertHelper();
    let result;
    try { result = await model.sendCommand(helper.sessionId, 'Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true }); }
    catch { throw error('helper command failed'); }
    assertBinding(binding); assertHelper();
    if (result?.exceptionDetails || !result?.result || !Object.hasOwn(result.result, 'value')) throw error('helper command did not return proof');
    return result.result.value;
  }
  async function ensureHelper(binding) {
    if (helper?.session) { assertHelper(); return; }
    if (attempted) throw error('helper creation already attempted');
    // Placement metadata is used only to create an inactive helper. Actual book
    // window identity and state must subsequently come from live Chrome APIs.
    const placement = model._knownTabs.get(binding.tabId)?.windowId;
    if (!positive(placement)) throw error('helper placement unavailable');
    assertBinding(binding); attempted = true;
    let tab;
    try { tab = await model._sendToExtension('chrome.tabs.create', [{ url:helperUrl, active:false, windowId:placement }]); }
    catch { throw error('helper creation outcome unknown'); }
    if (!positive(tab?.id) || !(tab.url === helperUrl || tab.pendingUrl === helperUrl && (!tab.url || tab.url === 'about:blank'))
        || tab.windowId !== placement || tab.active !== false) throw error('inactive helper creation not confirmed');
    helper = { tabId:tab.id, placement, targetId:null, sessionId:null, session:null };
    assertBinding(binding);
    let session;
    try { session = await model._attachTab(helper.tabId); } catch { throw error('helper attachment outcome unknown'); }
    helper.session = session; helper.targetId = session?.targetInfo?.targetId; helper.sessionId = session?.sessionId;
    assertBinding(binding); assertHelper();
    const readiness = `location.href === ${JSON.stringify(helperUrl)} && chrome.runtime.id === ${JSON.stringify(extensionId)} && typeof chrome.tabs.get === 'function' && typeof chrome.windows.get === 'function'`;
    const deadline = Date.now() + 3000;
    while (await runtime(readiness, binding) !== true) {
      if (Date.now() >= deadline) throw error('helper did not load');
      await new Promise(resolve => setTimeout(resolve, 50)); assertBinding(binding); assertHelper();
    }
  }
  async function manage(page, action) {
    if (!['read','minimize'].includes(action)) throw error('unsupported action');
    if (failed || cleanupAttempted || busy) throw error('connection window bridge is unavailable');
    busy = true;
    try {
      const binding = bind(page);
      await ensureHelper(binding); assertBinding(binding);
      const evaluateProof = async proofAction => {
      const expression = `(async () => {
        if (location.href !== ${JSON.stringify(helperUrl)} || chrome.runtime.id !== ${JSON.stringify(extensionId)}) throw new Error('Helper origin changed');
        const tabId=${binding.tabId}, expectedUrl=${JSON.stringify(binding.url)};
        const first=await chrome.tabs.get(tabId), own=await chrome.tabs.get(${helper.tabId});
        if(first.id!==tabId || first.url!==expectedUrl || own.id!==${helper.tabId} || own.url!==${JSON.stringify(helperUrl)} || own.windowId!==first.windowId || own.active!==false) throw new Error('Tab window binding changed');
        const before=await chrome.windows.get(first.windowId,{populate:false});
        const again=await chrome.tabs.get(tabId);
        if(again.id!==tabId || again.url!==expectedUrl || again.windowId!==first.windowId || before.id!==first.windowId) throw new Error('Tab window binding changed');
        if(${JSON.stringify(proofAction)}==='minimize' && before.state!=='minimized') await chrome.windows.update(before.id,{state:'minimized'});
        const after=await chrome.windows.get(before.id,{populate:false}), last=await chrome.tabs.get(tabId), lastOwn=await chrome.tabs.get(${helper.tabId});
        if(last.id!==tabId || last.url!==expectedUrl || last.windowId!==before.id || after.id!==before.id || lastOwn.windowId!==before.id || lastOwn.active!==false) throw new Error('Tab window binding changed');
        return {tabId,windowId:after.id,windowState:after.state};
      })()`;
      const receipt = await runtime(expression, binding);
      // Keep diagnostics limited to fixed reason codes and known state enums.
      // Never export arbitrary helper values, tab URLs, or page content.
      let invalid;
      if (!receipt || Object.keys(receipt).sort().join(',') !== 'tabId,windowId,windowState') invalid = 'receipt-shape';
      else if (receipt.tabId !== binding.tabId) invalid = 'tab-binding';
      else if (!positive(receipt.windowId)) invalid = 'window-id';
      else if (!states.has(receipt.windowState)) invalid = 'window-state';
      if (invalid) throw error('invalid window proof (' + invalid + ')');
      return receipt;
      };
      let receipt = await evaluateProof(action);
      const initialWindowId = receipt.windowId;
      // The native window transition can lag behind windows.update's response.
      // Request it only once, then confirm using the same binding and read-only
      // expressions. A bad identity/receipt is never a reason to keep polling.
      const deadline = performance.now() + 1000;
      while (action === 'minimize' && receipt.windowState !== 'minimized' && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))));
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        let timer;
        try {
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(error('invalid window proof (minimization-confirmation-timeout)')), remaining); });
          receipt = await Promise.race([
            timeout,
            evaluateProof('read'),
          ]);
        } finally { clearTimeout(timer); }
        if (performance.now() >= deadline) throw error('invalid window proof (minimization-confirmation-timeout)');
        if (receipt.windowId !== initialWindowId) throw error('invalid window proof (window-binding-changed)');
      }
      if (action === 'minimize' && receipt.windowState !== 'minimized') throw error('invalid window proof (minimization-not-confirmed:' + receipt.windowState + ')');
      return { ...receipt };
    } catch (cause) { failed = true; throw cause; }
    finally { busy = false; }
  }
  async function prepareNormalWindow(page) {
    if (failed || cleanupAttempted || busy) throw error('connection window bridge is unavailable');
    busy = true;
    try {
      const binding = bind(page);
      if (normalBinding && (normalBinding.page !== page || normalBinding.session !== binding.session
          || normalBinding.targetId !== binding.targetId || normalBinding.sessionId !== binding.sessionId
          || normalBinding.tabId !== binding.tabId)) throw error('normal window page binding changed');
      normalBinding ??= binding;
      const readDocument = async () => {
        assertBinding(binding);
        const value = await page.evaluate(() => ({url:location.href,timeOrigin:performance.timeOrigin}));
        assertBinding(binding);
        if (value?.url !== binding.url || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) throw error('document identity unavailable');
        return value;
      };
      const document = await readDocument();
      const checkDocument = async () => {
        const current = await readDocument();
        if (current.url !== document.url || current.timeOrigin !== document.timeOrigin) throw error('document identity changed');
      };
      await ensureHelper(binding); await checkDocument();
      const header = `if(location.href!==${JSON.stringify(helperUrl)} || chrome.runtime.id!==${JSON.stringify(extensionId)}) throw new Error('Helper origin changed');
        const tabId=${binding.tabId}, helperId=${helper.tabId}, expectedUrl=${JSON.stringify(binding.url)}, helperUrl=${JSON.stringify(helperUrl)};`;
      const readProof = async () => {
        await checkDocument();
        const proof = await runtime(`(async()=>{${header}
          const first=await chrome.tabs.get(tabId), own=await chrome.tabs.get(helperId);
          if(first.id!==tabId || first.url!==expectedUrl || own.id!==helperId || own.url!==helperUrl || own.active!==false || own.windowId!==first.windowId) throw new Error('Tab window binding changed');
          const window=await chrome.windows.get(first.windowId,{populate:true});
          const last=await chrome.tabs.get(tabId), lastOwn=await chrome.tabs.get(helperId);
          if(window.id!==first.windowId || last.id!==tabId || last.url!==expectedUrl || last.windowId!==window.id || lastOwn.id!==helperId || lastOwn.url!==helperUrl || lastOwn.windowId!==window.id || lastOwn.active!==false) throw new Error('Tab window binding changed');
          const tabs=window.tabs;
          const independent=Array.isArray(tabs) && tabs.length===2 && tabs.filter(t=>t.id===tabId && t.url===expectedUrl && t.windowId===window.id && t.active===true).length===1 && tabs.filter(t=>t.id===helperId && t.url===helperUrl && t.windowId===window.id && t.active===false).length===1;
          return {tabId,windowId:window.id,windowState:window.state,bookTabActive:last.active,helperTabActive:lastOwn.active,windowFocused:window.focused,independent};
        })()`, binding);
        await checkDocument();
        if (!proof || Object.keys(proof).sort().join(',') !== 'bookTabActive,helperTabActive,independent,tabId,windowFocused,windowId,windowState'
            || proof.tabId !== binding.tabId || !positive(proof.windowId) || !states.has(proof.windowState)
            || typeof proof.bookTabActive !== 'boolean' || proof.helperTabActive !== false
            || typeof proof.windowFocused !== 'boolean' || typeof proof.independent !== 'boolean') throw error('invalid normal window proof');
        return proof;
      };
      const proof = await readProof();
      const ready = value => value.independent && value.windowState === 'normal' && value.bookTabActive === true
        && value.helperTabActive === false && value.windowFocused === false;
      // Moving an already debugger-attached tab to another window closes its
      // Playwright Page on the supported extension transport. Preserve that
      // continuous identity: this method may only reuse an existing window.
      if (!ready(proof)) throw error('normal window is not ready for read-only reuse; attached tabs will not be moved');
      return {tabId:binding.tabId,windowId:proof.windowId,windowState:'normal',bookTabActive:true,helperTabActive:false,windowFocused:false,created:false,documentTimeOrigin:document.timeOrigin};
    } catch (cause) { failed = true; throw cause; }
    finally { busy = false; }
  }
  async function cleanup() {
    if (cleanupAttempted) return { removed:false, reason:'already-attempted' };
    if (busy) throw error('window operation still running');
    cleanupAttempted = true;
    if (!helper?.session) return { removed:false, reason:attempted?'identity-unconfirmed':'not-created' };
    try { assertHelper(); } catch { return { removed:false, reason:'identity-changed' }; }
    try {
      // Verify the owned helper's actual URL immediately before removing its ID.
      const proof=await model.sendCommand(helper.sessionId,'Runtime.evaluate',{expression:`location.href === ${JSON.stringify(helperUrl)} && chrome.runtime.id === ${JSON.stringify(extensionId)}`,returnByValue:true});
      assertHelper();
      if (proof?.exceptionDetails || proof?.result?.value !== true) return { removed:false, reason:'identity-changed' };
      await model._sendToExtension('chrome.tabs.remove', [helper.tabId]);
      return { removed:true };
    } catch { return { removed:false, reason:'removal-unconfirmed' }; }
  }
  Object.defineProperty(browser, '__textbookRecorderWindowBridge', { value:Object.freeze({ manage, prepareNormalWindow, cleanup }) });
  // MCP disposes the default context before calling browser.close; a default
  // context close can disconnect CDP itself, so clean up before either path.
  for (const context of browser.contexts?.() ?? []) {
    const closeContext = context.close.bind(context);
    context.close = async (...args) => { await cleanup(); return closeContext(...args); };
  }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => { await cleanup(); return close(...args); };
  return browser.__textbookRecorderWindowBridge;
}
