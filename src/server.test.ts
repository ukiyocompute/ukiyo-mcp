import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApiCall,registerTools,type ApiCall} from './server.js';
function collect(call:ApiCall){const tools=new Map<string,any>();registerTools({tool:(name:string,_d:string,_s:unknown,run:any)=>tools.set(name,run)} as never,call);return tools;}
test('public inventory defaults to production and omits bearer token',async()=>{
 const seen:any[]=[];const call=createApiCall({},(async(url,init)=>{seen.push({url,init});return new Response('{"data":[]}');}) as typeof fetch);
 for(const p of ['/offers','/gpus'])assert.deepEqual(await call(p),[]);
 assert.equal(seen[0].url,'https://pay.u-kiyo.ai/api/v1/offers');assert.equal(seen[0].init.headers.authorization,undefined);
});
test('authenticated operations require scoped token and attach it to fixed origin',async()=>{
 await assert.rejects(()=>createApiCall({})('/me'),{code:'UNAUTHENTICATED'});
 const seen:any[]=[];const call=createApiCall({UKIYO_API_URL:'http://127.0.0.1:9999',UKIYO_API_TOKEN:'test-token'},(async(url,init)=>{seen.push({url,init});return new Response('{"data":{"ok":true}}');}) as typeof fetch);
 assert.deepEqual(await call('/me'),{ok:true});assert.equal(seen[0].init.headers.authorization,'Bearer test-token');assert.equal(seen[0].init.redirect,'error');assert.ok(seen[0].init.signal);
 await call('/deployments/x/credentials/reveal',{method:'POST'});assert.equal(seen[1].init.headers['content-type'],undefined);
 await call('/rentals',{method:'POST',body:'{}'});assert.equal(seen[2].init.headers['content-type'],'application/json');
});
test('unsafe origins and malformed API success fail closed',async()=>{
 for(const url of ['http://example.com','https://u:p@example.com','https://example.com/path','https://example.com/?token=x'])assert.throws(()=>createApiCall({UKIYO_API_URL:url}));
 await assert.rejects(()=>createApiCall({},(async()=>new Response('not-json')) as typeof fetch)('/offers'),{code:'INVALID_API_RESPONSE'});
});
test('customer-safe backend codes, request ID and HTTP status survive tool errors',async()=>{
 for(const code of ['INSUFFICIENT_BALANCE','SCOPE_REQUIRED','KEY_BUDGET_EXCEEDED','CONCURRENCY_LIMIT','COMPUTE_TEMPORARILY_UNAVAILABLE','DEPLOYMENT_NOT_FOUND']){
  const call=createApiCall({UKIYO_API_TOKEN:'test-token'},(async()=>new Response(JSON.stringify({error:{code,message:'Customer-safe explanation',requestId:'req-test'}}),{status:403})) as typeof fetch);
  const result=await collect(call).get('list_deployments')({});
  assert.equal(result.isError,true);assert.deepEqual(result.structuredContent.error,{code,message:'Customer-safe explanation',status:403,requestId:'req-test'});
 }
});
test('unexpected failures never serialize stack traces or credential contents',async()=>{
 const result=await collect(async()=>{throw new Error('secret-stack-data');}).get('list_deployments')({});
 assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('secret-stack-data'));
});
