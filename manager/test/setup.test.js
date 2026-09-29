import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
function fixture(initialized,setupToken){
 const pool={query:async sql=>sql.includes('manager_rate_limits')?{rows:[{count:1}]}:{rows:[{initialized}]}};
 return createApp(pool,{publicOrigin:'http://localhost:8080',setupToken,trustProxyHops:0});
}
async function request(app,url,method='GET',body){
 const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method,headers:body?{'content-type':'application/json'}:{},socket:{remoteAddress:'127.0.0.1'}});
 const response={status:200,headers:{},setHeader(k,v){this.headers[k]=v},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers)},end(body){this.body=String(body)}};
 await app(req,response);return response;
}
test('owner setup is enabled only before initialization and with a valid-length token',async()=>{
 for(const [initialized,token,enabled] of [[false,undefined,false],[false,'short',false],[false,'x'.repeat(32),true],[true,'x'.repeat(32),false]]){
  const response=await request(fixture(initialized,token),'/api/setup');assert.deepEqual(JSON.parse(response.body),{setupRequired:!initialized,setupEnabled:enabled});assert.ok(!response.body.includes('xxxxxxxx'));assert.equal(response.headers['Cache-Control'],'no-store');
 }
});
test('wrong owner token stays forbidden with an actionable explanation',async()=>{
 const response=await request(fixture(false,'x'.repeat(32)),'/api/setup','POST',{setupToken:'wrong'});assert.equal(response.status,403);assert.match(JSON.parse(response.body).error,/Railway/);
});
test('public landing page does not need database access and preserves CSP',async()=>{
 const app=createApp({query:()=>{throw Error('DB must not be used')}},{publicOrigin:'http://localhost:8080'});
 const response=await request(app,'/');assert.equal(response.status,200);assert.match(response.body,/of the <em>future/);assert.match(response.body,/Apple Passwords/);assert.match(response.body,/Planned/);assert.match(response.headers['Content-Security-Policy'],/script-src 'self'/);
});
