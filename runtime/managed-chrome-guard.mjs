// A daemon-owned, non-overlapping health loop. Do not use a separate worker or
// close a user's Chrome windows to recover the managed browser.
export function createManagedChromeGuard(check, {intervalMs=15000, onError=()=>{}}={}) {
  if(typeof check!=='function')throw TypeError('health check must be a function');
  let timer=null, inFlight=null, stopped=false;
  let last={status:'not_checked'};
  const tick=()=>{
    if(stopped)return Promise.resolve(last);
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      try{last={status:'healthy',...(await check())};}
      catch(error){last={status:'degraded',error:String(error?.message||error)};onError(error);}
      finally{inFlight=null;}
      return last;
    })();
    return inFlight;
  };
  return {
    tick,
    start(){if(timer)return;stopped=false;timer=setInterval(()=>{void tick()},intervalMs);timer.unref?.();void tick()},
    stop(){stopped=true;if(timer)clearInterval(timer);timer=null},
    status(){return {...last}}
  };
}
