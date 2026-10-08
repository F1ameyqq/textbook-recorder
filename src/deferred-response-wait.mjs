/** Listen before editing, but spend the response timeout only when wait() starts. */
export function captureResponseBeforeWait(page,{predicate,timeoutMs=20000}={}) {
  if(!page || typeof page.on!=='function' || typeof page.off!=='function' || typeof predicate!=='function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1)throw new Error('A page, response predicate, and positive timeout are required');
  let terminal=false,matched=false,response=null,error=null,waiting=null,timer=null,consumed=false;
  const cleanup=()=>{if(timer!==null){clearTimeout(timer);timer=null;}page.off('response',onResponse);page.off('close',onClose);page.off('crash',onCrash);};
  const settle=(failure,value=null)=>{
    if(terminal)return;
    terminal=true;error=failure;response=value;cleanup();
    if(waiting){if(error)waiting.reject(error);else waiting.resolve(response);waiting=null;}
  };
  const onResponse=value=>{
    if(terminal || matched)return;
    Promise.resolve().then(()=>predicate(value)).then(matches=>{
      if(!matches || terminal || matched)return;
      matched=true;response=value;page.off('response',onResponse);
      // Keep close/crash guards until the cached response is consumed. A page
      // lost during editing must not make its earlier response appear usable.
      if(waiting)settle(null,value);
    }).catch(failure=>{if(!matched)settle(failure);});
  };
  const onClose=()=>settle(new Error('Page closed while observing save response'));
  const onCrash=()=>settle(new Error('Page crashed while observing save response'));
  page.on('response',onResponse);page.on('close',onClose);page.on('crash',onCrash);
  return {
    async wait() {
      if(consumed)throw new Error('Save response wait may be consumed only once');
      consumed=true;
      if(terminal){if(error)throw error;return response;}
      if(matched){settle(null,response);return response;}
      return new Promise((resolve,reject)=>{
        waiting={resolve,reject};
        timer=setTimeout(()=>{const timeoutError=new Error(`Timeout ${timeoutMs}ms exceeded while waiting for event "response"`);timeoutError.name='TimeoutError';timeoutError.code='SAVE_RESPONSE_TIMEOUT';settle(timeoutError);},timeoutMs);
      });
    },
    dispose() {if(!terminal)settle(new Error('Save response observation disposed'));else cleanup();},
  };
}
