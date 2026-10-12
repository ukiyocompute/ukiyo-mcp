import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError, UkiyoClient } from './cli/client.js';
import { executeSsh, type SshAccess } from './cli/ssh.js';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Values are unwrapped API data, never credentials serialized to the model. */
export type ApiCall = (path: string, init?: RequestInit) => Promise<unknown>;
export type ToolOptions = { pollIntervalMs?: number; execute?: typeof executeSsh };
const PUBLIC_PATHS = new Set(['/offers','/gpus']);
export function createApiCall(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): ApiCall {
  const base = new URL(env.UKIYO_API_URL ?? 'https://pay.u-kiyo.ai');
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      !(base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname))) throw new Error('Use an HTTPS API origin. HTTP is allowed only on loopback.');
  const client = new UkiyoClient({baseUrl:base.origin,...(env.UKIYO_API_TOKEN?{token:env.UKIYO_API_TOKEN}:{}),fetcher});
  return async (path,init) => {
    const value = await client.request(path,{...init,authenticated:!PUBLIC_PATHS.has(path),signal:AbortSignal.timeout(30000)});
    if (value === null || typeof value !== 'object') throw new ApiError(502,'INVALID_API_RESPONSE','The API returned an invalid response. Retry shortly.',null);
    return value;
  };
}
function redact(value: unknown): any {
  if (typeof value === 'string') return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[REDACTED]').replace(/uk_[a-f0-9]{12}\.[A-Za-z0-9_-]{32}/g,'[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/^(privateKey|secret|token|password)$/i.test(key)?'[REDACTED]':redact(v)]));
  return value;
}
function result(value: Record<string,unknown>, isError = false) {
  const safe = redact(value);
  return {content:[{type:'text' as const,text:JSON.stringify(safe)}],structuredContent:safe,...(isError?{isError:true}:{})};
}
async function safeRun(run:()=>Promise<unknown>) {
  try { const data=await run(); return result({data},typeof (data as any)?.exitCode==='number' && (data as any).exitCode!==0); }
  catch(error) {
    if(error instanceof ApiError) return result({error:{code:error.code,message:error.message,status:error.status,
      ...((error.body as any)?.error?.requestId?{requestId:(error.body as any).error.requestId}:{}),
      ...(error.code==='WAIT_TIMEOUT'?{context:error.body}:{})}},true);
    return result({error:{code:'TRANSPORT_ERROR',message:'The request or SSH operation could not complete. Check connectivity and inspect the existing rental before retrying. Reuse the same rental idempotency key.'}},true);
  }
}
const id = z.string().uuid();
const timeoutSeconds = z.number().int().min(1).max(600).default(60).describe('Maximum wait in seconds. Timeout does not cancel the rental or prove cleanup.');
export function registerTools(server: McpServer, call: ApiCall, options: ToolOptions = {}) {
  const pause = () => new Promise(resolve=>setTimeout(resolve,options.pollIntervalMs ?? 1000));
  async function poll(path:string, seconds:number, done:(value:any)=>boolean) {
    const deadline=Date.now()+seconds*1000;
    for(;;) {
      const value=await call(path);
      if(done(value)) return value;
      if(Date.now()>=deadline) throw new ApiError(0,'WAIT_TIMEOUT','State is not confirmed. Inspect the same rental/deployment; do not create a replacement.',{path,lastStatus:(value as any)?.status});
      await pause();
    }
  }
  server.tool('get_account','Read the authenticated account, scoped key limits and prepaid balance. No owner credential is needed.',{},()=>safeRun(()=>call('/me')));
  server.tool('list_gpus','List GPU models with current customer pricing from the API. Use list_offers for a rentable offer ID.',{},()=>safeRun(()=>call('/gpus')));
  server.tool('list_offers','Discover current GPU offers, counts, prices and offer IDs. Pricing and eligibility are controlled by the API.',{},()=>safeRun(()=>call('/offers')));
  server.tool('rent_gpu','Spend prepaid credits to create one autonomous rental within scoped token limits. Reuse the SAME idempotencyKey and parameters after a timeout; never create a replacement blindly. Returns rentalId and deploymentId; use get_rental to wait for ACTIVE.',{
    offerId:id.describe('Exact offer ID from list_offers.'),budgetMinor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('USD cents to spend; 500 means $5. The backend enforces all budget limits.'),
    idempotencyKey:z.string().trim().min(1).max(128).describe('Unique key per intended rental; keep it unchanged for retries.')
  },({offerId,budgetMinor,idempotencyKey})=>safeRun(()=>call('/rentals',{method:'POST',headers:{'idempotency-key':idempotencyKey},body:JSON.stringify({offerId,budgetMinor})})));
  server.tool('get_rental','Read rental/deployment correlation, status, quote, failure and credit-reversal state. Optionally wait for ACTIVE or a final failure.',{
    rentalId:id.describe('rentalId returned by rent_gpu.'),waitForActive:z.boolean().default(false),timeoutSeconds
  },({rentalId,waitForActive,timeoutSeconds:seconds})=>safeRun(()=>waitForActive?poll(`/rentals/${rentalId}`,seconds,v=>['ACTIVE','FAILED','TERMINATED'].includes(v?.status)):call(`/rentals/${rentalId}`)));
  server.tool('list_deployments','Inspect deployments accessible to the scoped token.',{},()=>safeRun(()=>call('/deployments')));
  server.tool('run_command','Execute a shell command over SSH on an ACTIVE deployment. The private key stays local and is deleted after execution; returns only deploymentId, stdout, stderr and exitCode. Commands may modify the rented GPU.',{
    deploymentId:id,command:z.string().min(1).max(32768).refine(s=>!s.includes('\0')).describe('Remote shell command, for example nvidia-smi.'),timeoutSeconds
  },({deploymentId,command,timeoutSeconds:seconds})=>safeRun(async()=>{
    const access=await call(`/deployments/${deploymentId}/credentials/reveal`,{method:'POST'}) as SshAccess;
    if(!options.execute) {
      try { mkdirSync(join(homedir(),'.ukiyo'),{mode:0o700}); } catch(error:any) {if(error.code!=='EEXIST')throw error;}
    }
    const output=await (options.execute ?? executeSsh)(deploymentId,access,['sh','-lc',command],seconds);
    // Defense in depth even if a remote process echoes the exact key material.
    const clean=(text:string)=>typeof access.privateKey==='string'&&access.privateKey.length?text.split(access.privateKey).join('[REDACTED]'):text;
    return {deploymentId,exitCode:output.exitCode,stdout:clean(output.stdout),stderr:clean(output.stderr)};
  }));
  server.tool('terminate_gpu','Irreversibly destroy this deployment and forfeit remaining prepaid runtime. Authorized scoped manage action; no per-rental approval step. Waits for API-confirmed TERMINATED, not merely request acceptance. Timeout means cleanup is unconfirmed.',{
    deploymentId:id,timeoutSeconds
  },({deploymentId,timeoutSeconds:seconds})=>safeRun(async()=>{
    await call(`/deployments/${deploymentId}/terminate`,{method:'POST',body:JSON.stringify({reason:'USER_REQUESTED'})});
    return poll(`/deployments/${deploymentId}`,seconds,v=>v?.id===deploymentId&&v?.status==='TERMINATED');
  }));
  return server;
}
export function buildServer(call: ApiCall, options: ToolOptions = {}) {
  return registerTools(new McpServer({name:'ukiyo',version:'0.2.0'}),call,options);
}
