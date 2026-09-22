import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, canReadConversation, canWriteConversation, catalogAllowed, opaqueToken, digest } from '../src/security.js';
import { catalog } from '../src/catalog.js';
test('salted scrypt hashes verify and reject invalid passwords',async()=>{
  const a=await hashPassword('a long test password'),b=await hashPassword('a long test password');
  assert.notEqual(a,b);assert.equal(await verifyPassword('a long test password',a),true);
  assert.equal(await verifyPassword('wrong',a),false);assert.equal(await verifyPassword('unknown account'),false);
  await assert.rejects(hashPassword('short'));
});
test('private conversations never grant administrator or cross-role access',()=>{
  const conversation={owner_id:'alice',visibility:'owner',allowed_roles:['member']};
  assert.equal(canReadConversation(conversation,{role:'admin'},'bob'),false);
  assert.equal(canReadConversation(conversation,{role:'member'},'alice'),true);
  conversation.visibility='company';assert.equal(canReadConversation(conversation,{role:'admin'},'bob'),false);
  assert.equal(canReadConversation(conversation,{role:'member'},'bob'),true);
  assert.equal(canWriteConversation(conversation,{role:'viewer'},'alice'),false);
});
test('MCP assignments fail closed and use fixed installation descriptors',()=>{
  assert.equal(catalogAllowed([],{role:'owner',classification:'general'}),false);
  assert.equal(catalogAllowed([{subject_type:'classification',subject:'marketing'}],{role:'member',classification:'marketing'}),true);
  const entries=catalog({googleAdsUrl:'https://attacker.invalid'});
  assert.deepEqual(entries.map(e=>e.id),['chrome-devtools','google-ads']);
  assert.ok(entries[0].installation.args.includes('--isolated'));
  assert.ok(entries[0].installation.args.includes('--no-usage-statistics'));
  assert.ok(!JSON.stringify(entries).includes('attacker.invalid'));
  assert.match(entries[1].installation.args[2],/@[0-9a-f]{40}$/);
});
test('session tokens are opaque high entropy values; persisted form is a digest',()=>{
  const token=opaqueToken();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(token,opaqueToken());assert.match(digest(token),/^[a-f0-9]{64}$/);
});
