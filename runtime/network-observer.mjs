// Generic, bounded, per-CDP-session response observer. No platform-specific
// endpoints or identifiers here. Never persist request/response bodies.
export function observeNetwork(browser, sessionId, {url, method='POST'}={}) {
  if(typeof url!=='string'||!/^https:\/\//.test(url)||typeof method!=='string')
    throw new TypeError('observe_network requires an exact HTTPS URL and HTTP method');
  const maxBytes=256*1024, records=new Map(), removers=[];
  let armed=false,closed=false,overflow=false;
  const on=(name,fn)=>removers.push(browser.on(name,(p,owner)=>{
    if(!closed&&armed&&owner===sessionId){try{fn(p)}catch{}}
  }));
  const append=(rec,data,initial=false)=>{
    if(closed||typeof data!=='string'||!data)return;
    const bytes=Buffer.from(data,'base64');
    if(rec.bytes+bytes.length>maxBytes){rec.truncated=true;return}
    rec.bytes+=bytes.length;
    if(initial)rec.chunks.unshift(bytes);else rec.chunks.push(bytes);
  };
  on('Network.requestWillBeSent',p=>{
    if(records.has(p.requestId)){records.get(p.requestId).ambiguous=true;return}
    if(p.request?.url!==url||p.request?.method!==method)return;
    if(records.size>=4){overflow=true;return}
    const rec={requestId:p.requestId,postData:typeof p.request.postData==='string'&&p.request.postData.length<=32768?p.request.postData:null,
      status:null,mime:null,ambiguous:false,truncated:false,bytes:0,chunks:[],body:null};
    records.set(p.requestId,rec);
    if(rec.postData===null&&p.request.hasPostData)void browser.send('Network.getRequestPostData',{requestId:p.requestId},sessionId).then(r=>{
      if(!closed&&typeof r.postData==='string'&&r.postData.length<=32768)rec.postData=r.postData;
    }).catch(()=>{});
  });
  on('Network.responseReceived',p=>{
    const rec=records.get(p.requestId);if(!rec)return;
    rec.status=p.response?.status;rec.mime=p.response?.mimeType;
    if(p.response?.url!==url){rec.ambiguous=true;return}
    if(rec.status<200||rec.status>=300||!/(?:event-stream|ndjson)/i.test(rec.mime||''))return;
    void browser.send('Network.streamResourceContent',{requestId:p.requestId},sessionId).then(r=>append(rec,r.bufferedData,true)).catch(()=>{});
  });
  on('Network.dataReceived',p=>{const rec=records.get(p.requestId);if(rec)append(rec,p.data)});
  on('Network.loadingFinished',p=>{
    const rec=records.get(p.requestId);
    if(!rec||rec.status<200||rec.status>=300||!/(?:event-stream|ndjson)/i.test(rec.mime||''))return;
    void browser.send('Network.getResponseBody',{requestId:p.requestId},sessionId).then(r=>{
      if(closed||typeof r.body!=='string')return;
      const bytes=Buffer.from(r.body,r.base64Encoded?'base64':'utf8');
      if(bytes.length<=maxBytes)rec.body=bytes.toString('utf8');
    }).catch(()=>{});
  });
  return {
    arm(){if(closed)throw Error('network observer closed');if(armed)throw Error('network observer already armed');armed=true},
    snapshot(){
      if(closed)return {overflow:true,requests:[]};
      return {overflow,requests:[...records.values()].map(r=>({request_id:r.requestId,post_data:r.postData,status:r.status,mime:r.mime,
        ambiguous:r.ambiguous,truncated:r.truncated,body:r.body??Buffer.concat(r.chunks).toString('utf8')}))};
    },
    close(){if(closed)return;closed=true;for(const off of removers)off();records.clear()}
  };
}
