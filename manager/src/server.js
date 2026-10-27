import { createServer } from 'node:http';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
const pool=createPool(process.env.DATABASE_URL);
await migrate(pool);
const hops=Number(process.env.TRUST_PROXY_HOPS||0);
if(!Number.isInteger(hops)||hops<0||hops>3)throw new Error('TRUST_PROXY_HOPS must be 0–3.');
const server=createServer({requestTimeout:30000,headersTimeout:10000},createApp(pool,{
  publicOrigin:process.env.PUBLIC_ORIGIN||'http://localhost:8080',setupToken:process.env.SETUP_TOKEN,signupOpen:process.env.SIGNUP!=='closed',
  trustProxyHops:hops
}));
server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('TerminAI manager listening'));
const cleanup=setInterval(()=>pool.query("DELETE FROM manager_rate_limits WHERE resets_at<now()-interval '1 day'; DELETE FROM manager_sessions WHERE expires_at<now()-interval '30 days'").catch(()=>console.error('Manager maintenance failed')),3600000);
cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(cleanup);server.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();});
