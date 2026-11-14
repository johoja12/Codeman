import { discordDisplayText } from './discord-display-text.js';
import {
  probeRemoteDiscordConversation,
  probeRemoteDiscordRuntime,
  type RemoteDiscordRuntime,
} from './discord-remote-conversation.js';
import { getCli } from './config/cli-registry/registry.js';
import { nativeExecutions, type DiscordNativeExecution } from './discord-native-execution.js';
/** Read-only, exact-conversation history. No cwd guesses, model turns, tool results or reasoning. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { codexMessageFromLine, isCodexInjectedContext } from './codex-rollout-format.js';
import { shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import { runDiscordRemoteRead } from './discord-file-transfers.js';
import type { SessionRemote } from './types/session.js';
const exec = promisify(execFile);
interface NativeHistoryRow {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown; stop_reason?: string; model?: unknown };
  effort?: unknown;
  perTurnEffort?: unknown;
  payload?: {
    thread_id?: string;
    type?: string;
    output?: unknown;
    role?: string;
    content?: unknown;
    message?: unknown;
    item?: {
      type?: string;
      content?: unknown;
      kind?: string;
      id?: string;
      status?: string;
      savedPath?: string;
      failure?: unknown;
    };
  };
  attachment?: { type?: string; origin?: { kind?: string }; commandMode?: string; prompt?: string; timestamp?: string };
}
function textBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}
function codexVisibleRow(row: NativeHistoryRow): unknown {
  const p = row.payload;
  if (!p) return row;
  if (row.type === 'response_item' && p.type && p.type !== 'message') return undefined;
  const content = (value: unknown) =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.filter(
            (v): v is { type: string; text: string } =>
              !!v &&
              typeof v === 'object' &&
              ['input_text', 'output_text', 'text'].includes(v.type) &&
              typeof v.text === 'string'
          )
        : value;
  return {
    ...row,
    payload: {
      ...p,
      content: content(p.content),
      message: content(p.message),
      item: p.item ? { ...p.item, content: content(p.item.content) } : undefined,
    },
  };
}
export interface DiscordHistoryTurn {
  cursor: string;
  role: 'user' | 'assistant' | 'tool';
  timestamp: string;
  text: string;
  phase?: 'commentary' | 'final_answer';
}
export interface DiscordGeneratedImage {
  id: string;
  cursor: string;
  timestamp: string;
}
export type DiscordReportedEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'ultracode';
export interface DiscordHistory {
  conversationId: string;
  turns: DiscordHistoryTurn[];
  reportedSettings?: { model: string; effort?: DiscordReportedEffort; cursor: string; timestamp: string };
  generatedImages?: DiscordGeneratedImage[];
  partial: boolean;
  executions?: DiscordNativeExecution[];
  notice?: string;
  verifiedAfter?: string;
  scannedCursor?: string;
  hasMore?: boolean;
}
export interface DiscordHistorySource {
  mode: string;
  conversationId?: string | null;
  remote?: SessionRemote;
  configHome?: string;
  includeTools?: boolean;
  after?: string;
}
export class DiscordHistoryReadError extends Error {
  constructor(readonly code: string) {
    super(
      code === 'cursor_missing'
        ? 'Saved history position is beyond the transcript; reconnect requires review'
        : code === 'cursor_changed'
          ? 'Saved history record changed; live replay paused for safety'
          : code === 'record_too_large'
            ? 'A transcript record exceeds the bounded recovery size'
            : code === 'profile_unverified'
              ? 'Remote Codex profile could not be verified; check its launch profile'
              : code === 'profile_changed'
                ? 'Remote Codex profile or process changed during history read; retry after reconnecting'
                : 'History recovery is unavailable'
    );
  }
}
export function discordHistoryFailureReason(error: unknown): string {
  if (error instanceof DiscordHistoryReadError) return error.message;
  if (error instanceof Error && error.message === 'Exact Claude/Codex conversation identity is unavailable')
    return 'Native conversation identity is not verified';
  return 'Transcript read or delivery failed';
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounded inventory and bounded tail. Exact UUID only; ambiguous copies are unavailable. */
const HISTORY_SCRIPT = String.raw`
import os,sys,json,stat,base64,hashlib,re
s=json.loads(sys.argv[1]);mode=s['format'];ident=s['id'];limit=2*1024*1024
def fail(code):
 print(json.dumps({'error':code}));sys.exit(0)
root=os.path.expanduser(s.get('home') or os.environ.get('CLAUDE_CONFIG_DIR' if mode=='claude-jsonl' else 'CODEX_HOME') or ('~/.claude' if mode=='claude-jsonl' else '~/.codex'))
home=root
root=os.path.join(root,'projects' if mode=='claude-jsonl' else 'sessions');found=[];count=0
for parent,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(parent,d))]
 depth=os.path.relpath(parent,root).count(os.sep)
 if depth>5: dirs[:]=[];continue
 for name in files:
  count+=1
  if count>16384: raise Exception('inventory limit')
  match=(name==ident+'.jsonl') if mode=='claude-jsonl' else name.endswith('-'+ident+'.jsonl')
  if not match: continue
  path=os.path.join(parent,name)
  if os.path.islink(path) or not stat.S_ISREG(os.lstat(path).st_mode): continue
  found.append(path)
if len(found)!=1: raise Exception('missing or ambiguous transcript')
def generated(v,cursor):
 if mode!='codex-rollout' or not isinstance(v,dict) or v.get('type')!='event_msg':return None
 p=v.get('payload');i=p.get('item') if isinstance(p,dict) else None
 if not isinstance(i,dict) or p.get('type')!='item_completed' or p.get('thread_id')!=ident:return None
 image=i.get('id')
 if i.get('type')!='Extension' or i.get('kind')!='image_gen.generation' or i.get('status')!='completed' or i.get('failure') is not None:return None
 if not isinstance(image,str) or not re.fullmatch(r'exec-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',image):return None
 if i.get('savedPath')!=os.path.join(home,'generated_images',ident,image+'.png'):return None
 return {'id':image,'cursor':cursor,'timestamp':v.get('timestamp') if isinstance(v.get('timestamp'),str) else ''}
f=os.open(found[0],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 info=os.fstat(f)
 if not stat.S_ISREG(info.st_mode): raise Exception('not regular')
 head=os.read(f,65536).split(b'\n')[0]
 if mode=='codex-rollout':
  meta=json.loads(head)
  if meta.get('type')!='session_meta' or meta.get('payload',{}).get('id')!=ident: raise Exception('identity mismatch')
 if s.get('image'):
  image=s['image'];cursor=image['cursor'];parts=cursor.split(':')
  if len(parts)!=3 or parts[0]!=ident:raise Exception('image conversation mismatch')
  with os.fdopen(os.dup(f),'rb') as stream:
   stream.seek(int(parts[1]));line=stream.readline(16*1024*1024+1)
  if not line.endswith(b'\n') or len(line)>16*1024*1024 or hashlib.sha256(line[:-1]).hexdigest()[:16]!=parts[2]:raise Exception('image event changed')
  proof=generated(json.loads(line),cursor)
  if not proof or proof['id']!=image['id']:raise Exception('image event unverified')
  fds=[]
  try:
   parent=os.open(os.path.realpath(home),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(parent)
   for part in ['generated_images',ident]:
    parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);fds.append(parent)
   imagefd=os.open(image['id']+'.png',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent);fds.append(imagefd)
   st=os.fstat(imagefd)
   if not stat.S_ISREG(st.st_mode) or st.st_size>8*1024*1024:raise Exception('image is unavailable or oversized')
   data=bytearray()
   while len(data)<=8*1024*1024:
    chunk=os.read(imagefd,min(65536,8*1024*1024+1-len(data)))
    if not chunk:break
    data.extend(chunk)
   if len(data)>8*1024*1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):raise Exception('invalid generated PNG')
   sys.stdout.buffer.write(data)
  finally:
   for fd in reversed(fds):os.close(fd)
  sys.exit(0)
 after=s.get('after');scanned=None;images=[];projected=[]
 def project_message(line,at):
  # Preserve every visible text block and the original record's exact cursor.
  # Only recognized image blocks may be omitted; unknown content stays fail-closed.
  if mode!='codex-rollout':return None
  try:v=json.loads(line)
  except Exception:return None
  if not isinstance(v,dict) or v.get('type')!='response_item':return None
  p=v.get('payload')
  if not isinstance(p,dict) or p.get('type')!='message' or p.get('role') not in ('user','assistant'):return None
  blocks=p.get('content')
  if not isinstance(blocks,list) or not blocks:return None
  text=[];image=False
  for b in blocks:
   if not isinstance(b,dict):return None
   if b.get('type') in ('input_text','output_text','text') and isinstance(b.get('text'),str):text.append(b)
   elif b.get('type')=='input_image' and set(b).issubset({'type','image_url','detail'}) and isinstance(b.get('image_url'),str):image=True
   else:return None
  if not image:return None
  value={'type':'response_item','timestamp':v.get('timestamp'),'payload':{'type':'message','role':p['role'],'content':text}}
  if 'phase' in p:value['payload']['phase']=p['phase']
  if len(json.dumps(value).encode())>limit:return None
  return {'offset':at,'hash':hashlib.sha256(line[:-1]).hexdigest()[:16],'value':value}

 if after:
  parts=after.split(':');offset=int(parts[1])
  if offset>=info.st_size:fail('cursor_missing')
  def ignored_large(line):
   try:v=json.loads(line)
   except Exception:return False
   # Keep chat/unknown records fail-closed. Only known non-chat rows can advance
   # the exact hashed checkpoint without exporting their potentially huge body.
   if mode!='codex-rollout' or not isinstance(v,dict):return False
   if v.get('type') in ('compacted','turn_context'):return True
   p=v.get('payload')
   if s.get('tools') or not isinstance(p,dict) or p.get('role') in ('user','assistant'):return False
   if v.get('type')=='response_item':return p.get('type') in ('function_call_output','custom_tool_call_output')
   i=p.get('item')
   return v.get('type')=='event_msg' and p.get('type')=='item_completed' and isinstance(i,dict) and i.get('role') not in ('user','assistant') and i.get('type')=='Extension' and i.get('kind')=='image_gen.generation'
  with os.fdopen(os.dup(f),'rb') as stream:
   stream.seek(offset);anchor=stream.readline(16*1024*1024+1)
   if len(anchor)>16*1024*1024:fail('record_too_large')
   if not anchor.endswith(b'\n') or hashlib.sha256(anchor[:-1]).hexdigest()[:16]!=parts[2]:fail('cursor_changed')
   try: anchored_image=generated(json.loads(anchor),after) if b'image_gen.generation' in anchor else None
   except Exception: anchored_image=None
   if anchored_image:offset+=len(anchor)
   elif len(anchor)>limit:
    if not ignored_large(anchor) and project_message(anchor,offset) is None:fail('record_too_large')
    offset+=len(anchor)
   stream.seek(offset);chunks=[];size=0;budget=limit+(len(anchor) if len(anchor)<=limit else 0)
   scanned=after;skipped_end=None
   while True:
    at=stream.tell();line=stream.readline(16*1024*1024+1)
    if len(line)>16*1024*1024:fail('record_too_large')
    if not line or not line.endswith(b'\n'):break
    cursor=ident+':'+str(at)+':'+hashlib.sha256(line[:-1]).hexdigest()[:16]
    try: image=generated(json.loads(line),cursor) if b'image_gen.generation' in line else None
    except Exception:image=None
    if image:
     images.append(image);scanned=cursor;skipped_end=at+len(line);break
    if len(line)>limit:
     projection=project_message(line,at)
     if projection is not None:
      if size+len(json.dumps(projection).encode())>budget:break
      projected.append(projection)
     elif not ignored_large(line):fail('record_too_large')
     scanned=cursor;skipped_end=at+len(line)
     break
    if size+len(line)>budget:break
    chunks.append(line);size+=len(line);scanned=cursor
   data=b''.join(chunks)
   # A skipped metadata row is itself the next verified anchor, never a guessed offset.
   read_end=skipped_end if skipped_end is not None else offset+len(data)
   more=read_end<info.st_size
 else:
  offset=max(0,info.st_size-limit);os.lseek(f,offset,0);data=os.read(f,limit)
  if offset:
   end=data.find(b'\n')
   if end<0:fail('record_too_large')
   offset+=end+1;data=data[end+1:]
  end=data.rfind(b'\n');data=data[:end+1] if end>=0 else b''
  more=offset+len(data)<info.st_size
 print(json.dumps({'offset':offset,'data':base64.b64encode(data).decode(),'partial':offset>0,'verifiedAfter':after,'hasMore':more,'scannedCursor':scanned,'images':images,**({'projected':projected} if projected else {})}))
finally: os.close(f)
`;
export function discordHistoryCommand(source: DiscordHistorySource, image?: DiscordGeneratedImage): string {
  const format = getCli(source.mode)?.capabilities.transcript;
  if (
    !source.conversationId ||
    !UUID.test(source.conversationId) ||
    !['claude-jsonl', 'codex-rollout'].includes(format ?? '')
  )
    throw new Error('Exact Claude/Codex conversation identity is unavailable');
  if (source.after && !new RegExp(`^${source.conversationId}:[0-9]{1,16}:[a-f0-9]{16}$`).test(source.after))
    throw new Error('Invalid history recovery cursor');
  if (source.after && !Number.isSafeInteger(Number(source.after.split(':')[1])))
    throw new Error('Invalid history recovery offset');
  if (
    image &&
    (!/^exec-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(image.id) ||
      !new RegExp(`^${source.conversationId}:[0-9]{1,16}:[a-f0-9]{16}$`).test(image.cursor) ||
      !Number.isSafeInteger(Number(image.cursor.split(':')[1])) ||
      getCli(source.mode)?.capabilities.transcript !== 'codex-rollout')
  )
    throw new Error('Invalid generated image identity');
  return withRemotePathBootstrap(
    'python3 -c ' +
      shellescape(HISTORY_SCRIPT) +
      ' ' +
      shellescape(
        JSON.stringify({
          format,
          id: source.conversationId,
          home: source.configHome,
          after: source.after,
          tools: source.includeTools === true,
          image,
        })
      )
  );
}
export function parseDiscordHistory(source: DiscordHistorySource, raw: string): DiscordHistory {
  const format = getCli(source.mode)?.capabilities.transcript;
  const packet = JSON.parse(raw) as {
    offset: number;
    data: string;
    partial: boolean;
    error?: string;
    verifiedAfter?: string;
    hasMore?: boolean;
    scannedCursor?: string;
    images?: DiscordGeneratedImage[];
    projected?: Array<{ offset: number; hash: string; value: NativeHistoryRow }>;
  };
  if (packet.error) throw new DiscordHistoryReadError(packet.error);
  if (source.after && packet.verifiedAfter !== source.after) throw new DiscordHistoryReadError('cursor_changed');
  if (
    !Number.isSafeInteger(packet.offset) ||
    packet.offset < 0 ||
    typeof packet.data !== 'string' ||
    packet.data.length > 6 * 1024 * 1024
  )
    throw new Error('Invalid history packet');
  if (
    packet.scannedCursor &&
    (!source.after ||
      !new RegExp(`^${source.conversationId}:[0-9]{1,16}:[a-f0-9]{16}$`).test(packet.scannedCursor) ||
      !Number.isSafeInteger(Number(packet.scannedCursor.split(':')[1])) ||
      Number(packet.scannedCursor.split(':')[1]) < Number(source.after.split(':')[1]))
  )
    throw new DiscordHistoryReadError('cursor_changed');
  const content = Buffer.from(packet.data, 'base64');
  let offset = packet.offset;
  const rows: Array<{ value: NativeHistoryRow; offset: number; hash: string }> = [];
  for (const line of content.toString('utf8').split('\n')) {
    if (line) {
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value))
          rows.push({
            value: value as NativeHistoryRow,
            offset,
            hash: createHash('sha256').update(line).digest('hex').slice(0, 16),
          });
      } catch {
        /* partial or malformed record */
      }
    }
    offset += Buffer.byteLength(line) + 1;
  }
  if (packet.projected !== undefined) {
    if (!source.after || format !== 'codex-rollout' || !Array.isArray(packet.projected) || packet.projected.length > 1)
      throw new Error('Invalid projected history record');
    for (const row of packet.projected) {
      const p = row?.value?.payload;
      if (
        !Number.isSafeInteger(row?.offset) ||
        row.offset < Number(source.after.split(':')[1]) ||
        !/^[a-f0-9]{16}$/.test(row.hash) ||
        row.value.type !== 'response_item' ||
        p?.type !== 'message' ||
        (p.role !== 'user' && p.role !== 'assistant') ||
        !Array.isArray(p.content) ||
        p.content.some(
          (b) =>
            !b ||
            typeof b !== 'object' ||
            !['input_text', 'output_text', 'text'].includes(b.type) ||
            typeof b.text !== 'string'
        ) ||
        Buffer.byteLength(JSON.stringify(row.value)) > 2 * 1024 * 1024 ||
        packet.scannedCursor !== `${source.conversationId}:${row.offset}:${row.hash}` ||
        rows.some((r) => r.offset >= row.offset)
      )
        throw new Error('Invalid projected history record');
      rows.push(row);
    }
  }
  const turns: DiscordHistoryTurn[] = [];
  let reportedSettings: DiscordHistory['reportedSettings'];
  const generatedImages: DiscordGeneratedImage[] = [];
  const addImage = (image: DiscordGeneratedImage) => {
    if (
      generatedImages.length >= 4 ||
      !/^exec-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(image.id) ||
      !new RegExp(`^${source.conversationId}:[0-9]{1,16}:[a-f0-9]{16}$`).test(image.cursor) ||
      !Number.isSafeInteger(Number(image.cursor.split(':')[1])) ||
      typeof image.timestamp !== 'string' ||
      image.timestamp.length > 100
    )
      throw new Error('Invalid generated image metadata');
    if (!generatedImages.some((i) => i.cursor === image.cursor)) generatedImages.push(image);
  };
  if (packet.images !== undefined) {
    if (
      !Array.isArray(packet.images) ||
      packet.images.length > 4 ||
      (packet.images.length > 0 && format !== 'codex-rollout')
    )
      throw new Error('Invalid generated image metadata');
    for (const image of packet.images) addImage(image);
  }
  for (const { value: e, offset, hash } of rows) {
    let role: 'user' | 'assistant' | 'tool' | undefined,
      text = '',
      phase: DiscordHistoryTurn['phase'],
      timestamp = typeof e.timestamp === 'string' ? e.timestamp : '';
    const item = e.payload?.item;
    if (
      format === 'codex-rollout' &&
      e.type === 'event_msg' &&
      e.payload?.type === 'item_completed' &&
      e.payload.thread_id === source.conversationId &&
      item?.type === 'Extension' &&
      item.kind === 'image_gen.generation' &&
      item.status === 'completed' &&
      item.failure == null &&
      typeof item.id === 'string' &&
      typeof item.savedPath === 'string' &&
      item.savedPath.endsWith(`/generated_images/${source.conversationId}/${item.id}.png`)
    )
      addImage({
        id: item.id,
        timestamp,
        cursor: `${source.conversationId}:${offset}:${hash}`,
      });
    if (source.includeTools) {
      let output = '';
      if (
        format === 'codex-rollout' &&
        e.type === 'response_item' &&
        e.payload?.type === 'function_call_output' &&
        typeof e.payload.output === 'string'
      )
        output = e.payload.output;
      if (
        format === 'claude-jsonl' &&
        e.type === 'user' &&
        !e.isSidechain &&
        (!e.sessionId || e.sessionId === source.conversationId) &&
        Array.isArray(e.message?.content)
      ) {
        output = e.message.content
          .filter(
            (x): x is { type: string; content: unknown } => !!x && typeof x === 'object' && x.type === 'tool_result'
          )
          .map((x) =>
            typeof x.content === 'string'
              ? x.content
              : Array.isArray(x.content)
                ? x.content
                    .filter(textBlock)
                    .map((y) => y.text)
                    .join('\n')
                : ''
          )
          .join('\n');
      }
      if (output)
        turns.push({
          role: 'tool',
          text: output.slice(0, 2000),
          timestamp,
          cursor: `${source.conversationId}:${offset}:${hash}`,
        });
    }
    if (format === 'codex-rollout') {
      const msg = codexMessageFromLine(codexVisibleRow(e));
      if (!msg || (msg.injectionProne && isCodexInjectedContext(msg.text))) continue;
      role = msg.role;
      text = msg.text;
      if (role === 'assistant' && (msg.phase === 'commentary' || msg.phase === 'final_answer')) phase = msg.phase;
    } else {
      if (e.isSidechain || e.isMeta || e.isCompactSummary || (e.sessionId && e.sessionId !== source.conversationId))
        continue;
      // Native metadata only; transcript prose, synthetic replies and other sessions cannot report settings.
      const model = e.message?.model;
      if (
        format === 'claude-jsonl' &&
        !!source.conversationId &&
        UUID.test(source.conversationId) &&
        e.type === 'assistant' &&
        e.sessionId === source.conversationId &&
        typeof model === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(model) &&
        Number.isFinite(Date.parse(timestamp))
      ) {
        const validEffort = (v: unknown): v is DiscordReportedEffort =>
          typeof v === 'string' && /^(low|medium|high|xhigh|max|ultra|ultracode)$/.test(v);
        const effort = validEffort(e.perTurnEffort) ? e.perTurnEffort : validEffort(e.effort) ? e.effort : undefined;
        reportedSettings = {
          model,
          ...(effort ? { effort } : {}),
          timestamp,
          cursor: `${source.conversationId}:${offset}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
        };
      }
      let body = e.message?.content;
      if (
        e.type === 'attachment' &&
        e.attachment?.type === 'queued_command' &&
        e.attachment.origin?.kind === 'human' &&
        e.attachment.commandMode === 'prompt'
      ) {
        role = 'user';
        body = e.attachment.prompt;
        timestamp = e.attachment.timestamp || timestamp;
      } else if (e.type === 'user' || e.type === 'assistant') role = e.type;
      if (!role) continue;
      if (role === 'assistant') {
        if (e.message?.stop_reason === 'tool_use') phase = 'commentary';
        else if (e.message?.stop_reason === 'end_turn' || e.message?.stop_reason === 'stop_sequence')
          phase = 'final_answer';
      }
      text =
        typeof body === 'string'
          ? body
          : Array.isArray(body)
            ? body
                .filter(textBlock)
                .map((x) => x.text)
                .join('\n')
            : '';
      if (
        role === 'user' &&
        /^(?:<local-command|<command-name>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:)/i.test(
          text.trim()
        )
      )
        continue;
    }
    if (!role || !text.trim()) continue;
    const prev = turns.at(-1);
    if (prev?.role === role && prev.text === text) {
      if (prev.phase === phase || phase === undefined) continue;
      // Native mirror rows may omit phase. Keep their stable cursor while applying explicit metadata.
      if (prev.phase === undefined) {
        prev.phase = phase;
        continue;
      }
      // An explicit final answer can repeat commentary verbatim; it still needs its own delivery.
    }
    turns.push({
      role,
      text,
      ...(phase ? { phase } : {}),
      timestamp,
      cursor: `${source.conversationId}:${offset}:${hash}`,
    });
  }
  const executions = nativeExecutions(
    format ?? 'none',
    source.conversationId!,
    rows.map((r) => ({
      value: r.value,
      cursor: `${source.conversationId}:${r.offset}:${r.hash}`,
    })),
    turns
  );
  const last = rows.at(-1);
  return {
    conversationId: source.conversationId!,
    turns,
    ...(reportedSettings ? { reportedSettings } : {}),
    ...(generatedImages.length ? { generatedImages } : {}),
    partial: packet.partial === true,
    executions,
    ...(source.after
      ? {
          verifiedAfter: packet.verifiedAfter,
          hasMore: packet.hasMore === true,
          scannedCursor:
            packet.scannedCursor ?? (last ? `${source.conversationId}:${last.offset}:${last.hash}` : undefined),
        }
      : {}),
  };
}
export async function readDiscordGeneratedImage(
  source: DiscordHistorySource,
  image: DiscordGeneratedImage
): Promise<{ name: string; data: Uint8Array }> {
  const command = discordHistoryCommand(source, image);
  const bytes = source.remote
    ? await runDiscordRemoteRead(source.remote, command)
    : (await exec('sh', ['-c', command], { encoding: 'buffer', timeout: 30000, maxBuffer: 8 * 1024 * 1024 + 1 }))
        .stdout;
  const data = Buffer.from(bytes);
  if (data.length > 8 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Generated image could not be verified');
  return { name: image.id + '.png', data };
}
export async function readDiscordHistory(source: DiscordHistorySource): Promise<DiscordHistory> {
  const command = discordHistoryCommand(source);
  const raw = source.remote
    ? await runDiscordRemoteRead(source.remote, command)
    : (await exec('sh', ['-c', command], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return parseDiscordHistory(source, String(raw));
}
export function historyPage(
  history: DiscordHistory,
  before?: string,
  limit = 12
): { turns: DiscordHistoryTurn[]; older?: string } {
  const end = before ? history.turns.findIndex((t) => t.cursor === before) : history.turns.length;
  if (end < 0) throw new Error('History cursor expired or conversation changed; request history again');
  const start = Math.max(0, end - Math.min(20, Math.max(1, limit)));
  return { turns: history.turns.slice(start, end), older: start > 0 ? history.turns[start].cursor : undefined };
}

const remoteRuntimeHomes = new WeakMap<
  import('./session.js').Session,
  { scope: string; runtime: RemoteDiscordRuntime }
>();
function remoteHistoryScope(
  session: import('./session.js').Session,
  resumeId: string | null = session.nativeResumeId
): string {
  const remote = session.remote;
  return JSON.stringify([
    session.mode,
    remote?.hostId,
    remote?.host,
    remote?.username,
    remote?.port,
    remote?.remotePath,
    remote?.codexCommandProfileId,
    remote?.commands?.codex,
    resumeId,
    session.codexConfig?.resumeSessionId,
    session.envOverrideValue('CODEX_HOME'),
    session.nativeModelSettingsRevision,
  ]);
}

/** Adapts live Session metadata; never guesses by shared directory or falls back to terminal redraws. */
async function withDiscordSessionHistorySource<T>(
  session: import('./session.js').Session,
  options: { includeTools?: boolean; after?: string } | undefined,
  recoveredId: string | undefined,
  read: (source: DiscordHistorySource) => Promise<T>
): Promise<T> {
  if (session.docker) throw new Error('Container history is not available through this reader');
  const format = getCli(session.mode)?.capabilities.transcript;
  let id =
    format === 'claude-jsonl'
      ? session.claudeSessionId
      : (session.nativeResumeId ?? session.codexConfig?.resumeSessionId);
  const key = format === 'claude-jsonl' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  let configHome = session.envOverrideValue(key) ?? (!session.remote ? process.env[key] : undefined);
  if (configHome && !configHome.startsWith('~/'))
    configHome = session.remote
      ? posix.isAbsolute(configHome)
        ? configHome
        : posix.resolve(session.remote.remotePath, configHome)
      : resolve(session.workingDir, configHome);
  if (recoveredId && !session.remote) {
    if (format !== 'codex-rollout' || session.docker || (id && id !== recoveredId))
      throw new DiscordHistoryReadError('profile_changed');
    id = recoveredId;
  }
  // Resumed conversations can have an older owner; background runs may share our marker.
  // Discover by ownership only while no native conversation is pinned.
  if (format === 'codex-rollout' && !session.remote && !recoveredId && !id) {
    const { findOwnedCodexConversation, resolveEffectiveCodexHome } =
      await import('./checkpoint-conversation-identity.js');
    id =
      (
        await findOwnedCodexConversation({
          codexHome: resolveEffectiveCodexHome(configHome, session.workingDir),
          sessionId: session.id,
          nativeResumeId: id ?? undefined,
          lastSubmitAt: session.lastSubmitAt,
        })
      )?.id ?? id;
  }
  if (session.docker) throw new Error('Container history is not available through this reader');
  const remote = session.remote;
  const resumeIdBefore = session.nativeResumeId;
  const scope = remoteHistoryScope(session);
  if (recoveredId && remote) {
    if (!remote || format !== 'codex-rollout' || (id && id !== recoveredId))
      throw new DiscordHistoryReadError('profile_changed');
    id = recoveredId;
  }
  let runtime: RemoteDiscordRuntime | undefined;
  let discovered: string | undefined;
  try {
    if (format === 'codex-rollout' && remote && !configHome) {
      const cached = remoteRuntimeHomes.get(session);
      runtime =
        cached?.scope === scope
          ? cached.runtime
          : await probeRemoteDiscordRuntime(remote, session.id).catch(() => undefined);
      if (!runtime && !(session.paneExit && id)) throw new DiscordHistoryReadError('profile_unverified');
      if (runtime?.id && id && runtime.id !== id) throw new DiscordHistoryReadError('profile_changed');
      if (runtime) {
        configHome = runtime.configHome;
        if (!id) discovered = runtime.id;
      }
    } else if (format === 'codex-rollout' && remote && !id) {
      discovered = await probeRemoteDiscordConversation(remote, session.id).catch(() => undefined);
    }
    id ??= discovered;
    const history = await read({
      mode: session.mode,
      conversationId: id,
      remote,
      configHome,
      includeTools: options?.includeTools,
      after: options?.after,
    });
    if (remote) {
      if (runtime) {
        const fresh = await probeRemoteDiscordRuntime(remote, session.id).catch(() => undefined);
        if (
          !(session.paneExit && !fresh) &&
          (!fresh ||
            fresh.fingerprint !== runtime.fingerprint ||
            fresh.configHome !== runtime.configHome ||
            fresh.id !== runtime.id)
        )
          throw new DiscordHistoryReadError('profile_changed');
      }
    }
    const compatibleAdoption = session.nativeResumeId === id && remoteHistoryScope(session, resumeIdBefore) === scope;
    if (session.remote !== remote || (remoteHistoryScope(session) !== scope && !compatibleAdoption))
      throw new DiscordHistoryReadError('profile_changed');
    // The exact native file/header and current owned runtime must both confirm the binding first.
    if (discovered && !session.nativeResumeId) session.setNativeResumeId(discovered);
    if (runtime) remoteRuntimeHomes.set(session, { scope: remoteHistoryScope(session), runtime });
    return history;
  } catch (error) {
    remoteRuntimeHomes.delete(session);
    throw error;
  }
}
export async function readDiscordSessionHistory(
  session: import('./session.js').Session,
  options?: { includeTools?: boolean; after?: string },
  recoveredId?: string
): Promise<DiscordHistory> {
  return withDiscordSessionHistorySource(session, options, recoveredId, readDiscordHistory);
}
export async function readDiscordSessionGeneratedImage(
  session: import('./session.js').Session,
  image: DiscordGeneratedImage
): Promise<{ name: string; data: Uint8Array }> {
  return withDiscordSessionHistorySource(session, undefined, undefined, (source) =>
    readDiscordGeneratedImage(source, image)
  );
}
export function renderHistory(turns: DiscordHistoryTurn[], options: { includeTimestamps?: boolean } = {}): string {
  return turns
    .filter((t) => t.role !== 'assistant' || !!discordDisplayText(t.text).trim())
    .map(
      (t) =>
        `**${t.role === 'user' ? 'You' : t.role === 'tool' ? 'Tool output' : 'Assistant'}**${options.includeTimestamps === false ? '' : ' ' + (t.timestamp || '(time unavailable)')}\n${t.role === 'assistant' ? discordDisplayText(t.text) : t.text}`
    )
    .join('\n\n');
}
export async function discordHistoryControl(
  session: import('./session.js').Session,
  command: string
): Promise<{ text: string; file?: { name: string; data: Uint8Array } }> {
  if (command === 'status') {
    const state = session.toState();
    return {
      text: `**${state.name || state.id}** · ${state.mode}\nHost: ${state.remote?.label || 'local'}\nState: ${state.paneExit ? 'agent exited' : session.activityProjection.activityStatus}\n${session.isWorking ? 'Working' : 'No running task observed'}${state.remote ? ' · SSH transport' : ''}`,
    };
  }
  const match = /^history(?: (\S+))?$/.exec(command);
  if (!match && command !== 'transcript')
    return {
      text: 'Commands: !codeman status · !codeman history [cursor] · !codeman transcript · !codeman file /absolute/path',
    };
  try {
    const history = await readDiscordSessionHistory(session);
    const label = history.partial ? 'Partial history: bounded recent transcript.' : 'Conversation history';
    if (command === 'transcript')
      return {
        text: label + ' · user-visible messages only',
        file: { name: 'conversation.txt', data: Buffer.from(renderHistory(history.turns)) },
      };
    const page = historyPage(history, match?.[1]);
    return {
      text: `${label}\n${renderHistory(page.turns) || 'No user-visible turns yet.'}${page.older ? '\n\nLoad older: !codeman history ' + page.older : ''}`,
    };
  } catch {
    return {
      text: 'History unavailable: exact native conversation identity, Python 3, or its transcript is missing/unavailable. No terminal history was guessed. Try again after reconnecting; other CLIs require the web UI.',
    };
  }
}
