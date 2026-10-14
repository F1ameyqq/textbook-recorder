import { readRecorderWindowState, validateBrowserFocusMode, validateBrowserWindowMode } from './browser-focus.mjs';
import { assertOwnedHeadlessPage } from './owned-headless-browser.mjs';

// Read actual browser state. Never emulate focus or change visibility properties.
export function recorderDocumentSnapshot() {
  return { url: location.href, timeOrigin: performance.timeOrigin,
    visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    readyState: document.readyState, prerendering: document.prerendering === true,
    usable: Boolean(document.documentElement && document.body) };
}

export function assertRecorderDocumentSnapshot(state, binding) {
  if (!state?.usable || !['interactive', 'complete'].includes(state.readyState) || state.prerendering
      || !['visible', 'hidden'].includes(state.visibilityState) || typeof state.hasFocus !== 'boolean'
      || typeof state.url !== 'string' || !Number.isFinite(state.timeOrigin)) throw new Error('Recorder document is not ready for input');
  if (binding && (state.url !== binding.url || state.timeOrigin !== binding.timeOrigin)) throw new Error('Recorder document changed during input checks');
}

/** Background input binds the actual recorder window without requiring OS
 * focus. Normal windows must keep a visible document; minimized windows may
 * hide it. Active editor and selection remain independent input checks. */
export async function requireRecorderDocumentReady(page, { focusMode = 'foreground', windowMode = 'normal',
  guard = async () => {}, windowReader = readRecorderWindowState } = {}) {
  validateBrowserFocusMode(focusMode); validateBrowserWindowMode(windowMode);
  if (focusMode === 'foreground' && windowMode !== 'normal') throw new Error('minimized/headless 只支持 background 模式');
  await guard();
  const before = await page.evaluate(recorderDocumentSnapshot);
  assertRecorderDocumentSnapshot(before);
  if (windowMode === 'headless') {
    const proof = assertOwnedHeadlessPage(page);
    if (before.visibilityState !== 'visible') throw new Error('Owned headless document is hidden');
    await guard();
    const after = await page.evaluate(recorderDocumentSnapshot);
    assertRecorderDocumentSnapshot(after, before);
    if (after.visibilityState !== 'visible') throw new Error('Owned headless document became hidden');
    const next = assertOwnedHeadlessPage(page);
    if (next.browserBindingId !== proof.browserBindingId) throw new Error('Owned headless browser binding changed');
    return { ...after, minimized: false, ...proof };
  }
  if (focusMode !== 'background') {
    if (before.visibilityState !== 'visible' || !before.hasFocus) throw new Error('Recorder document is hidden or has lost DOM focus');
    return { ...before, minimized: false };
  }
  const actual = await windowReader(page, guard);
  const actualState = actual?.windowState;
  const validId = Number.isSafeInteger(actual?.windowId) && actual.windowId > 0
    || typeof actual?.windowId === 'string' && /^[1-9]\d*$/u.test(actual.windowId);
  if (!validId || (windowMode === 'minimized' ? actualState !== 'minimized'
    : !['normal','maximized','fullscreen'].includes(actualState))) {
    const state = actualState === undefined ? 'missing' : ['normal','minimized','maximized','fullscreen'].includes(actualState) ? actualState : 'invalid';
    const prefix = windowMode === 'minimized' ? '指定教材页的窗口未保持最小化，停止输入' : '指定教材页没有可确认的正常窗口，停止输入';
    throw new Error(`${prefix} (window-proof validId=${validId},state=${state})`);
  }
  if (windowMode === 'normal' && before.visibilityState !== 'visible') throw new Error('Recorder background document is hidden');
  await guard();
  const after = await page.evaluate(recorderDocumentSnapshot);
  assertRecorderDocumentSnapshot(after, before);
  if (windowMode === 'normal' && after.visibilityState !== 'visible') throw new Error('Recorder background document became hidden');
  return { ...after, minimized: windowMode === 'minimized', windowId: actual.windowId, windowState:actual.windowState };
}

/** A committed navigation can legitimately expose a loading document without
 * a body. Only directory reading may wait for this transition; input checks
 * above still require a ready document immediately. Node polling keeps one
 * deadline and never emulates readiness, visibility, focus or window state. */
export async function waitForRecorderDocumentReady(page, { focusMode='background', windowMode='normal',
  guard=async()=>{}, windowReader=readRecorderWindowState, timeoutMs=20000, pollMs=80,
  now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)) }={}) {
  validateBrowserFocusMode(focusMode);validateBrowserWindowMode(windowMode);
  if(focusMode!=='background')throw new Error('Directory readiness waiting is restricted to background reads');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>1000)
    throw new Error('Invalid directory document readiness deadline');
  const started=now(),deadline=started+timeoutMs;let binding,windowBinding,browserBinding,lastState,attempts=0;
  const timeout=()=>{
    const error=new Error(`Recorder document readiness timed out (readyState=${lastState?.readyState??'unknown'}, usable=${lastState?.usable??'unknown'}, visibility=${lastState?.visibilityState??'unknown'})`);
    error.code='DOCUMENT_READINESS_TIMEOUT';error.documentReadiness={timeoutMs,attempts,elapsedMs:Math.max(0,now()-started),
      lastState:lastState?{readyState:lastState.readyState,usable:lastState.usable,visibilityState:lastState.visibilityState}:null};return error;
  };
  const bounded=async action=>{
    const remaining=deadline-now();if(remaining<=0)throw timeout();let timer;
    try{const result=await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeout()),remaining);})]);
      if(now()>=deadline)throw timeout();return result;
    }finally{clearTimeout(timer);}
  };
  while(true){
    await bounded(guard);
    if(page.isClosed?.())throw new Error('Recorder document closed during readiness waiting');
    const state=await bounded(()=>page.evaluate(recorderDocumentSnapshot));lastState=state;attempts++;
    if(!state||typeof state.usable!=='boolean'||!['loading','interactive','complete'].includes(state.readyState)||state.prerendering
      ||!['visible','hidden'].includes(state.visibilityState)||typeof state.hasFocus!=='boolean'||typeof state.url!=='string'||!Number.isFinite(state.timeOrigin))
      throw new Error('Recorder document is not ready for input');
    if(binding&&(state.url!==binding.url||state.timeOrigin!==binding.timeOrigin))throw new Error('Recorder document changed during readiness waiting');
    binding??=state;
    if(windowMode!=='minimized'&&state.visibilityState!=='visible')
      throw new Error(windowMode==='headless'?'Owned headless document is hidden':'Recorder background document is hidden');
    if(state.readyState!=='loading'){
      const ready=await bounded(()=>requireRecorderDocumentReady(page,{focusMode,windowMode,guard,windowReader}));
      assertRecorderDocumentSnapshot(ready,binding);
      if(windowBinding!==undefined&&String(ready.windowId)!==windowBinding)throw new Error('Recorder window identity changed during readiness waiting');
      if(browserBinding!==undefined&&ready.browserBindingId!==browserBinding)throw new Error('Owned headless browser binding changed during readiness waiting');
      return ready;
    }
    if(windowMode==='headless'){
      const proof=assertOwnedHeadlessPage(page);
      if(browserBinding!==undefined&&proof.browserBindingId!==browserBinding)throw new Error('Owned headless browser binding changed during readiness waiting');
      browserBinding=proof.browserBindingId;
    }else{
      const actual=await bounded(()=>windowReader(page,guard)),validId=Number.isSafeInteger(actual?.windowId)&&actual.windowId>0
        ||typeof actual?.windowId==='string'&&/^[1-9]\d*$/u.test(actual.windowId);
      if(!validId||(windowMode==='minimized'?actual.windowState!=='minimized':!['normal','maximized','fullscreen'].includes(actual.windowState)))
        throw new Error(windowMode==='minimized'?'指定教材页的窗口未保持最小化，停止输入':'指定教材页没有可确认的正常窗口，停止输入');
      if(windowBinding!==undefined&&String(actual.windowId)!==windowBinding)throw new Error('Recorder window identity changed during readiness waiting');
      windowBinding=String(actual.windowId);
    }
    await bounded(()=>sleep(Math.min(pollMs,Math.max(1,deadline-now()))));
  }
}
