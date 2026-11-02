import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {domainMatches,utcCookieTime,difference,collect,sample} from '../../skills/webhelm/scripts/auth-cookie-audit.mjs';
import {classify,visit} from '../../skills/webhelm/scripts/auth-keepalive-visit.mjs';

function cookieFixture(callback){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-cookie-test-'));
  const profile=path.join(dir,'chrome'),dbPath=path.join(profile,'Default','Cookies');
  fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,top_frame_site_key TEXT,
    encrypted_value BLOB,value TEXT,expires_utc INTEGER,creation_utc INTEGER,last_update_utc INTEGER,
    last_access_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,is_persistent INTEGER)`);
  db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'channels.weixin.qq.com','sessionid','/','',Buffer.from('SECRET-AUTH-VALUE'),'',
    0,0,123,0,1,1,1,1);
  db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    '.google.com','SECRET-COOKIE-NAME','/','',Buffer.from('SECRET-GOOGLE'),'',
    0,0,0,0,1,1,1,0);
  db.close();
  try{return callback({dir,profile,dbPath});}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('Chrome Cookie domain boundary and timestamp conversion',()=>{
  assert.equal(domainMatches('.accounts.google.com','google.com'),true);
  assert.equal(domainMatches('notgoogle.com','google.com'),false);
  assert.equal(domainMatches('google.com.attacker.invalid','google.com'),false);
  assert.equal(utcCookieTime(0),null);
  assert.equal(utcCookieTime(11644473600*1_000_000),0);
});

test('cookie audit only publishes keyed metadata and site counts',()=>cookieFixture(({dir,profile,dbPath})=>{
  const collected=collect(dbPath,Buffer.alloc(32,0x61));
  assert.equal(Object.values(collected.wechat)[0].watched_name,'sessionid');
  assert.equal(JSON.stringify(collected).includes('SECRET-AUTH-VALUE'),false);
  assert.equal(JSON.stringify(collected).includes('SECRET-COOKIE-NAME'),false);
  const event=sample({profile,dataDir:path.join(dir,'private')});
  assert.equal(event.sites.wechat.count,1);
  assert.equal(event.sites.google_store.count,1);
  assert.equal(JSON.stringify(event).includes('SECRET'),false);
  const second=sample({profile,dataDir:path.join(dir,'private'),site:'wechat',status:'logged_in'});
  assert.equal(second.sites.wechat.added,0);
  assert.deepEqual(second.observed_status,{wechat:'logged_in'});
}));

test('diff classifies rotation and expiry changes',()=>{
  const a={fingerprint:'one',expires_at:2000,updated_at:5},b={fingerprint:'two',expires_at:3000,updated_at:6};
  assert.deepEqual(difference({wechat:{a}},{wechat:{a:b,b}}).wechat,
    {added:1,removed:0,value_rotated:1,expiry_extended:1,expiry_shortened:0,last_update_changed:1});
});

test('read-only site observations are not inferred from cookie presence',()=>{
  assert.deepEqual(classify('wechat','内容管理 数据中心'),['logged_in','backend_visible']);
  assert.deepEqual(classify('wechat','加载失败，点击重试'),['page_error','page_load_failed']);
  assert.deepEqual(classify('google_store','signin/confirmidentifier'),['login_required','login_redirect']);
  assert.deepEqual(classify('google_store','Switch Publisher Account Menu Add a new item'),['logged_in','backend_visible']);
  assert.deepEqual(classify('xiaohongshu','发布 消息 我'),['unknown','feed_only']);
});

test('keepalive always stops only the session it opened on snapshot failure',async()=>{
  const calls=[];
  const run=async(_program,args)=>{
    calls.push(args);
    if(args[1]==='start')return {session_id:'owned-session'};
    if(args[1]==='exec')throw Error('CommandTimeout');
    if(args[1]==='stop')return {release_error:null};
    return {};
  };
  const response=await visit('wechat','https://example.com',run,async()=>({}));
  assert.equal(response.session_closed,true);
  assert.equal(response.error,'CommandTimeout');
  assert.ok(calls.some(x=>x[1]==='stop'&&x[2]==='owned-session'));
});
