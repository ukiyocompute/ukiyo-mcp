import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer, type ApiCall} from './server.js';
import {ApiError} from './cli/client.js';
const id='11111111-1111-4111-8111-111111111111';
async function session(call:ApiCall, options:Parameters<typeof buildServer>[1] = {}) {
 const server=buildServer(call,options);const client=new Client({name:'acceptance',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close();}};
}
test('eight action tools, structured IDs, prepaid rent payload and explicit idempotency',async()=>{
 const calls:Array<{path:string;init?:RequestInit}>=[];
 const s=await session(async(path,init)=>{calls.push({path,...(init?{init}:{})});return {rentalId:id,deploymentId:id};});
 try{
  assert.deepEqual((await s.client.listTools()).tools.map(t=>t.name).sort(),['get_account','get_rental','list_deployments','list_gpus','list_offers','rent_gpu','run_command','terminate_gpu']);
  const r=await s.client.callTool({name:'rent_gpu',arguments:{offerId:id,budgetMinor:500,idempotencyKey:'rental-one'}});
  assert.deepEqual(r.structuredContent,{data:{rentalId:id,deploymentId:id}});
  assert.equal(calls[0]!.path,'/rentals');assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)),{offerId:id,budgetMinor:500});
  assert.equal((calls[0]!.init?.headers as any)['idempotency-key'],'rental-one');
  const invalid=await s.client.callTool({name:'rent_gpu',arguments:{offerId:id,budgetMinor:500}});assert.equal(invalid.isError,true);assert.equal(calls.length,1);
 }finally{await s.close();}
});
test('termination polls until confirmed; never treats acceptance/404/failure as cleanup',async()=>{
 let polls=0;
 const s=await session(async(path)=>path.endsWith('/terminate')?{accepted:true}:{id,status:++polls===1?'TERMINATING':'TERMINATED'},{pollIntervalMs:1});
 try{const r=await s.client.callTool({name:'terminate_gpu',arguments:{deploymentId:id,timeoutSeconds:1}});assert.equal((r.structuredContent as any).data.status,'TERMINATED');assert.equal(polls,2);}finally{await s.close();}
 const stuck=await session(async()=>({id,status:'TERMINATING'}),{pollIntervalMs:1});
 try{const r=await stuck.client.callTool({name:'terminate_gpu',arguments:{deploymentId:id,timeoutSeconds:1}});assert.equal(r.isError,true);assert.equal((r.structuredContent as any).error.code,'WAIT_TIMEOUT');}finally{await stuck.close();}
});
test('run_command keeps credentials internal and redacts key output',async()=>{
 const secret='-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----';let ran=false;
 const s=await session(async()=>({host:'127.0.0.1',port:22,username:'root',privateKey:secret}),{execute:async(_id,access,command)=>{ran=true;assert.equal(access.privateKey,secret);assert.deepEqual(command,['sh','-lc','nvidia-smi']);return {exitCode:0,stdout:secret,stderr:''};}});
 try{const r=await s.client.callTool({name:'run_command',arguments:{deploymentId:id,command:'nvidia-smi'}});assert.ok(ran);assert.equal((r.structuredContent as any).data.exitCode,0);assert.ok(!JSON.stringify(r).includes('SECRET'));assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));}finally{await s.close();}
});
test('get_rental waiting preserves failure/reversal state and ordinary reads map exactly',async()=>{
 const calls:string[]=[];let polls=0;
 const s=await session(async path=>{calls.push(path);return path.startsWith('/rentals/')?{rentalId:id,status:++polls===1?'PROVISIONING':'FAILED',credits:{reversalStatus:'PENDING'}}:{source:path};},{pollIntervalMs:1});
 try{
  for(const name of ['get_account','list_gpus','list_offers','list_deployments'])await s.client.callTool({name,arguments:{}});
  assert.deepEqual(calls,['/me','/gpus','/offers','/deployments']);
  const r=await s.client.callTool({name:'get_rental',arguments:{rentalId:id,waitForActive:true,timeoutSeconds:1}});
  assert.equal((r.structuredContent as any).data.status,'FAILED');assert.equal((r.structuredContent as any).data.credits.reversalStatus,'PENDING');
  const read=await s.client.callTool({name:'get_rental',arguments:{rentalId:id}});assert.equal((read.structuredContent as any).data.rentalId,id);
 }finally{await s.close();}
});
test('termination failure or missing deployment remains error, never a cleanup success',async()=>{
 for(const failureAt of ['post','poll']){
  const s=await session(async path=>{if(failureAt==='post'||!path.endsWith('/terminate'))throw new ApiError(404,'DEPLOYMENT_NOT_FOUND','Not found',null);return {accepted:true};});
  try{const r=await s.client.callTool({name:'terminate_gpu',arguments:{deploymentId:id}});assert.equal(r.isError,true);assert.equal((r.structuredContent as any).error.code,'DEPLOYMENT_NOT_FOUND');}finally{await s.close();}
 }
});
test('nonzero remote exit is structured tool error; transport exceptions cannot leak key',async()=>{
 for(const transportFails of [false,true]){
  const s=await session(async()=>({privateKey:'not-for-model'}),{execute:async()=>{if(transportFails)throw new Error('not-for-model');return {exitCode:9,stdout:'output',stderr:'command failed'};}});
  try{const r=await s.client.callTool({name:'run_command',arguments:{deploymentId:id,command:'false'}});assert.equal(r.isError,true);assert.ok(!JSON.stringify(r).includes('not-for-model'));if(!transportFails)assert.equal((r.structuredContent as any).data.exitCode,9);}finally{await s.close();}
 }
});
