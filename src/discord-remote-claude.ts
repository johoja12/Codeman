/** Resolve the profile of the sole interactive Claude process attached to the exact remote pane. */
import type { SessionRemote } from './types/session.js';
import { remoteTmuxLocation } from './tmux-manager.js';
import { shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import { runDiscordRemoteRead } from './discord-file-transfers.js';
import {
  REMOTE_CODEX_RESUME_PROBE,
  REMOTE_CODEX_ENV_READER,
  parseDiscordRuntime,
} from './discord-remote-conversation.js';
// Share the bounded pane/process inventory and OS-specific environment decoder. Only the selected config key differs.
export function remoteClaudeRuntimeProbe(): string {
  return (
    REMOTE_CODEX_RESUME_PROBE.slice(0, REMOTE_CODEX_RESUME_PROBE.indexOf('# Locate the command')) +
    REMOTE_CODEX_ENV_READER.replace("b'CODEX_HOME'", "b'CLAUDE_CONFIG_DIR'") +
    String.raw`
import hashlib
agents=[]
values={'--model','--effort','--settings','--permission-mode','--allowedTools','--disallowedTools','--add-dir','--system-prompt','--append-system-prompt','--output-format','--input-format','--mcp-config','--agent','--agents','--fallback-model','--max-budget-usd','--tools','--setting-sources','--plugin-dir'}
flags={'--dangerously-skip-permissions','--allow-dangerously-skip-permissions','--verbose','--debug','--continue','-c','--disable-slash-commands','--strict-mcp-config','--no-chrome','--chrome'}
commands={}
for pid in owned:
 try:argv=shlex.split(procs[pid][1])
 except Exception:continue
 if argv and os.path.basename(argv[0])=='claude':commands[pid]=argv
def controlling(pid):
 parent=procs[pid][0];seen=set()
 while parent in owned:
  if parent in seen:raise Exception('invalid process ancestry')
  seen.add(parent)
  if parent in commands:return False
  parent=procs[parent][0]
 return True
for pid,argv in commands.items():
 if not controlling(pid):continue
 ids=[];ok=True;i=1
 while i<len(argv):
  arg=argv[i];name=arg.split('=',1)[0]
  if name in ('--resume','-r','--session-id'):
   if '=' in arg:value=arg.split('=',1)[1]
   else:
    i+=1;value=argv[i] if i<len(argv) else ''
   if not re.fullmatch(uuid,value,re.I):ok=False;break
   ids.append(value)
  elif name in values:
   if '=' not in arg:
    i+=1
    if i>=len(argv):ok=False;break
  elif arg not in flags:ok=False;break
  i+=1
 # Sibling controllers remain ambiguous; nested CLI jobs do not control this pane.
 agents.append((pid,ids[0] if ok and len(ids)==1 else None,ok and len(ids)<=1))
if len(agents)!=1 or not agents[0][2]:raise Exception('ambiguous Claude process')
pid,identity,_=agents[0]
def stamp():
 value=subprocess.check_output(['ps','-ww','-p',str(pid),'-o','lstart=','-o','command='],text=True,timeout=4)
 if not value.strip() or len(value)>65536:raise Exception('process changed')
 return value
before=stamp();env=runtime_environment(pid);base=env.get('HOME','');home=env.get('CLAUDE_CONFIG_DIR')
if not home:home=os.path.join(base,'.claude') if os.path.isabs(base) else None
if home and home.startswith('~/') and os.path.isabs(base):home=os.path.join(base,home[2:])
if home and not os.path.isabs(home):
 if sys.platform=='darwin':
  lines=subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True,timeout=4)
  paths=[line[1:] for line in lines.splitlines() if line.startswith('n')]
  if len(paths)!=1:raise Exception('runtime cwd unavailable')
  cwd=paths[0]
 else:cwd=os.readlink('/proc/'+str(pid)+'/cwd')
 if not os.path.isabs(cwd):raise Exception('runtime cwd unavailable')
 home=os.path.join(cwd,home)
if not home or len(home)>4096 or any(ord(c)<32 for c in home):raise Exception('runtime home unavailable')
if stamp()!=before:raise Exception('process changed')
print(json.dumps({'id':identity,'configHome':os.path.normpath(home),'fingerprint':hashlib.sha256((str(root)+':'+str(pid)+':'+before).encode()).hexdigest()}))
`
  );
}
export async function probeRemoteClaudeRuntime(remote: SessionRemote, sessionId: string) {
  return parseDiscordRuntime(
    await runDiscordRemoteRead(
      remote,
      withRemotePathBootstrap(
        'python3 -c ' +
          shellescape(remoteClaudeRuntimeProbe()) +
          ' ' +
          shellescape(JSON.stringify({ location: remoteTmuxLocation(remote, sessionId) }))
      )
    )
  );
}
