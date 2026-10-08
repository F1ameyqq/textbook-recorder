/** Visibility polling without utility-world requestAnimationFrame dependency. */
export async function waitVisibleByTimer(locator,{timeout=20000,name='目标',targetRole=null}={}) {
  const startedAt=new Date().toISOString();
  const deadline=Date.now()+timeout;
  let lastState=null;
  while(Date.now()<deadline) {
    const state=await locator.evaluateAll(nodes=>({count:nodes.length,visible:nodes.some(node=>{const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;})}));
    lastState={count:state.count,visible:state.visible};
    if(state.count>1)throw new Error('可见目标无法唯一匹配');
    if(state.visible)return;
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  const error=new Error(name+'在时限内未显示，停止操作');error.code='TARGET_VISIBILITY_TIMEOUT';error.targetRole=targetRole;error.visibilityDiagnostic={name,targetRole,startedAt,endedAt:new Date().toISOString(),timeout,lastState};throw error;
}
