import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime/extension');
const html = readFileSync(path.join(extensionDir, 'helm.html'), 'utf8');
const page = readFileSync(path.join(extensionDir, 'workspace-page.mjs'), 'utf8');
const ids = ['workspace-name', 'slot-number', 'status-label', 'description', 'help-text'];

function evaluate(query) {
  const elements = new Map(ids.map(id => [id, {textContent: ''}]));
  const document = {
    title: '',
    getElementById(id) {
      assert.ok(elements.has(id), `Unknown element: ${id}`);
      return elements.get(id);
    },
  };
  const location = new URL('chrome-extension://kkkpgmhpoeceojalkpfdidffdfnlgdog/helm.html' + query);
  vm.runInNewContext(page, {document, location, URLSearchParams}, {timeout: 1000});
  return {title: document.title, values: Object.fromEntries([...elements].map(([key, value]) => [key, value.textContent]))};
}

test('idle page contains accessible content and all dynamic destinations', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<main aria-labelledby="page-title">/);
  assert.match(html, /role="status"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /viewport/);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(page, /innerHTML|document\.write/);
});

test('idle URL displays correct workspace, status and slot without faking daemon health', () => {
  const result = evaluate('?workspace=Harness&role=idle&slot=0');
  assert.equal(result.title, 'WebHelm · Idle');
  assert.equal(result.values['workspace-name'], 'Harness');
  assert.equal(result.values['slot-number'], '0');
  assert.match(result.values['status-label'], /Idle/);
  assert.match(result.values.description, /reused automatically/);
  assert.match(result.values['help-text'], /not daemon connectivity/);
});

test('lease URL preserves the exact existing tab identity title contract', () => {
  const result = evaluate('?workspace=Harness&role=lease&slot=483');
  assert.equal(result.title, '__WEBHELM_TAB_483__');
  assert.equal(result.values['slot-number'], '483');
  assert.equal(result.values['status-label'], 'Reserved for a task');
});

test('missing or invalid parameters are never shown as idle or daemon ready', () => {
  const wakeup = evaluate('?webhelm_wakeup=1');
  assert.equal(wakeup.title, 'WebHelm');
  assert.equal(wakeup.values['workspace-name'], 'Not assigned');
  assert.equal(wakeup.values['slot-number'], '—');
  assert.equal(wakeup.values['status-label'], '');
  const malformed = evaluate('?workspace=Harness&role=lease&slot=hi');
  assert.equal(malformed.title, 'WebHelm');
  assert.equal(malformed.values['slot-number'], '—');
});

test('workspace query is rendered as text, not injected as HTML', () => {
  const attack = '<img src=x onerror=alert(1)>';
  const result = evaluate('?workspace=' + encodeURIComponent(attack) + '&role=idle&slot=99');
  assert.equal(result.values['workspace-name'], attack);
  assert.match(result.values['status-label'], /Idle/);
  assert.doesNotMatch(page, /innerHTML/);
});

test('legacy workspace.html still preserves existing lease identity',()=>{
  const elements = new Map(ids.map(id=>[id,{textContent:''}]));
  const document = {title:'',getElementById:id=>elements.get(id)};
  const location = new URL('chrome-extension://kkkpgmhpoeceojalkpfdidffdfnlgdog/workspace.html?workspace=Harness&role=lease&slot=75');
  vm.runInNewContext(page,{document,location,URLSearchParams},{timeout:1000});
  assert.equal(document.title,'__BW_TAB_75__');
});
