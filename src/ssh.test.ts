import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,statSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeSsh} from './cli/ssh.js';
const access={host:'127.0.0.1',port:22,username:'root',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'};
test('shared SSH materializes private key mode 600, keeps token out of child env and cleans up on success/failure',async()=>{
 const previous=process.env.HOME; const home=mkdtempSync(join(tmpdir(),'mcp-ssh-test-'));process.env.HOME=home;mkdirSync(join(home,'.ukiyo'),{mode:0o700});
 try{for(const outcome of ['success','exit','timeout']) {
  let key='';
  const runner=((file:string,args:string[],options:any,cb:any)=>{
   assert.equal(file,'ssh');key=args[args.indexOf('-i')+1]!;
   assert.equal(statSync(key).mode&0o777,0o600);assert.equal(readFileSync(key,'utf8'),access.privateKey);
   assert.equal(options.env.UKIYO_API_TOKEN,undefined);assert.ok(args.includes('BatchMode=yes'));assert.equal(args.at(-1),"'sh' '-lc' 'nvidia-smi'");
   queueMicrotask(()=>cb(outcome==='success'?null:outcome==='exit'?{code:7}:{killed:true},'output','stderr'));return {};
  }) as never;
  const run=executeSsh('deployment-1',access,['sh','-lc','nvidia-smi'],1,runner);
  if(outcome==='timeout')await assert.rejects(run,/timed out/);else assert.equal((await run).exitCode,outcome==='success'?0:7);
  assert.ok(!existsSync(key));assert.ok(!existsSync(join(key,'..')));
 }}finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});
test('shared SSH refuses symlinked credential directories',async()=>{
 const previous=process.env.HOME;const home=mkdtempSync(join(tmpdir(),'mcp-ssh-unsafe-'));process.env.HOME=home;symlinkSync(tmpdir(),join(home,'.ukiyo'));
 try{await assert.rejects(executeSsh('deployment-1',access,['true']),/Unsafe/);}finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});
