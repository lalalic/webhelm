import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionBadge} from '../../runtime/extension/session-badge.mjs';

test('active Sessions, not available pool slots, drive badge count',()=>{
  for(const [sessions,expected] of [[0,'0'],[1,'1'],[3,'3'],[8,'8'],[99,'99'],[100,'99+']]){
    const badge=sessionBadge({connected:true,sessionCount:sessions});
    assert.equal(badge.text,expected);
    assert.match(badge.title,new RegExp(sessions+' active Session'));
    assert.equal(badge.color,sessions===0?'#667085':'#345FD5');
  }
});
test('missing or stale daemon never incorrectly shows zero sessions',()=>{
  assert.equal(sessionBadge({connected:false,sessionCount:0}).text,'!');
  assert.equal(sessionBadge({connected:true,sessionCount:null}).text,'?');
  assert.equal(sessionBadge({connected:true,sessionCount:-1}).text,'?');
});
