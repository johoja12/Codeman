#!/usr/bin/env node
// Read-only real-pane/remote benchmark. No frames, identities, paths or credentials are exported.
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
process.env.VITEST='read-only-benchmark';
const directory=resolve(process.argv[2]??'dist'),extension=directory.endsWith('/src')?'ts':'js';
const module=async name=>import(pathToFileURL(resolve(directory,name+'.'+extension)).href);
const {TmuxCaptureBatcher}=await module('tmux-capture-batcher');
const {PythonInspectionWorker}=await module('python-inspection-worker');
const {REMOTE_CODEX_RUNTIME_PROBE,parseDiscordRuntime}=await module('discord-remote-conversation');
const {RemoteFrameSshPool}=await module('remote-frame-ssh-pool');
const {buildSshConnectionArgv,remoteSshTarget}=await module('remote-hosts');
const {resolveTmuxSocketName}=await module('config/instance');
const execute=promisify(execFile),socket=resolveTmuxSocketName();
const hz=Number((await execute('getconf',['CLK_TCK'])).stdout.trim());
const masterPids=new Set();
function stat(pid){try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' ');}catch{return undefined;}}
function helpers(){const self=stat(process.pid);let ticks=Number(self[13])+Number(self[14]);const children=new Set(fs.readFileSync(`/proc/self/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
 for(const pid of new Set([...children,...masterPids])){const s=stat(pid);if(s)ticks+=Number(s[11])+Number(s[12]);}return ticks/hz*1000;}
async function measure(kind,operation){const cpu=process.cpuUsage(),h=helpers(),t=performance.now();await operation();const used=process.cpuUsage(cpu);return{kind,wallMs:+(performance.now()-t).toFixed(2),nodeCpuMs:+((used.user+used.system)/1000).toFixed(2),helperAndMasterCpuMs:+(helpers()-h).toFixed(2)};}
const sessions=(await(await fetch('http://127.0.0.1:3002/api/sessions',{signal:AbortSignal.timeout(5000)})).json()).data;
const names=[...new Set((await execute('tmux',['-L',socket,'list-panes','-a','-F','#{session_name}'])).stdout.trim().split('\n'))].filter(n=>/^codeman-[a-f0-9-]+$/.test(n));assert(names.length>=1);
const requests=Array.from({length:16},(_,i)=>({name:names[i%names.length],ansi:i>=names.length}));
const options={encoding:'utf8',timeout:1500,maxBuffer:256*1024};
let commands=0;const frames=new TmuxCaptureBatcher(socket,async(...args)=>{commands++;return execute(...args);});
const worker=new PythonInspectionWorker(REMOTE_CODEX_RUNTIME_PROBE);const pools=[];const result={livePanes:names.length,captureRequests:16,captures:[],profiles:[],ssh:[]};
try{
 for(let round=0;round<3;round++)for(const mode of round%2?['after','before']:['before','after']){
  commands=0;const sample=await measure(mode,async()=>{
   const values=await Promise.all(requests.map(r=>mode==='after'?frames.capture(r.name,{ansi:r.ansi}):
    (async()=>{commands++;return(await execute('tmux',['-L',socket,'capture-pane','-p',...(r.ansi?['-e']:[]),'-t',r.name],options)).stdout;})()));
   assert(values.every(v=>v!==null));
  });result.captures.push({...sample,tmuxCommands:commands});
 }
 const local=sessions.find(s=>s.mode==='codex'&&!s.remote&&!s.docker&&names.includes('codeman-'+s.id.slice(0,8)));assert(local,'No local Codex pane');
 const args=JSON.stringify({location:{socket,sessionName:'codeman-'+local.id.slice(0,8)}});
 const reference=parseDiscordRuntime((await execute('python3',['-c',REMOTE_CODEX_RUNTIME_PROBE,args],{encoding:'buffer',timeout:15000,maxBuffer:16384})).stdout);assert(reference);
 const warm=await worker.read([args]);assert.deepEqual(parseDiscordRuntime(warm),reference);
 for(let round=0;round<3;round++)for(const mode of round%2?['after','before']:['before','after']){
  result.profiles.push(await measure(mode,async()=>{
   const data=mode==='after'?await worker.read([args]):(await execute('python3',['-c',REMOTE_CODEX_RUNTIME_PROBE,args],{encoding:'buffer',timeout:15000,maxBuffer:16384})).stdout;
   assert(data);assert.deepEqual(parseDiscordRuntime(data),reference);
  }));
 }
 const remotes=[...new Map(sessions.filter(s=>s.remote).map(s=>[s.remote.hostId,s.remote])).values()].slice(0,2);
 for(const [index,remote]of remotes.entries()){
  const pool=new RemoteFrameSshPool();pools.push(pool);const base=buildSshConnectionArgv(remote),target=remoteSshTarget(remote),opts={timeout:15000,maxBuffer:1024};
  const warmup=await measure('warmup',()=>pool.capture(base,target,'true',undefined,opts));
  const owned=[...pool.sockets.values()];assert.equal(owned.length,1,'Explicit user SSH control settings prevent this comparison');
  const check=await execute('ssh',[...base,'-S',owned[0].path,'-O','check',target],opts);const match=/pid=(\d+)/.exec(check.stderr);assert(match);masterPids.add(Number(match[1]));
  const samples=[];
  for(let round=0;round<3;round++)for(const mode of round%2?['after','before']:['before','after'])samples.push(await measure(mode,()=>mode==='after'?pool.capture(base,target,'true',undefined,opts):execute('ssh',[...base,target,'true'],opts)));
  result.ssh.push({hostIndex:index+1,warmup,samples});
 }
 fs.writeFileSync(process.argv[3]??'/tmp/codeman-workers-benchmark.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({benchmarksCompleted:true,livePanes:names.length,remoteHosts:result.ssh.length}));
}finally{frames.close();worker.close();await Promise.all(pools.map(pool=>pool.close()));}
