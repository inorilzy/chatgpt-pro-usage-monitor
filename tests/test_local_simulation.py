from pathlib import Path
from playwright.sync_api import sync_playwright
import json, time, traceback

ROOT=Path(__file__).resolve().parents[1]
# Optional: pip install playwright; install a Chromium browser locally.
SCRIPT=(ROOT/'chatgpt-pro-usage-monitor.user.js').read_text(encoding='utf-8')
KEY='chatgpt-pro-usage-estimator:state:v1'
SHIM=r'''
(() => {
 window.__testErrors=[];
 window.addEventListener('error', e=>window.__testErrors.push(String(e.message)));
 window.addEventListener('unhandledrejection', e=>window.__testErrors.push(String(e.reason)));
 window.__GM=window.__initialGM || {};
 window.__testLocation=new URL('https://chatgpt.example.invalid/c/alpha');
 for(const method of ['pushState','replaceState']) history[method]=function(state,unused,url){if(url)window.__testLocation=new URL(url,window.__testLocation)};
 window.unsafeWindow=new Proxy(window,{get(t,k){
   if(k==='location')return window.__testLocation;
   if(k==='postMessage')return data=>setTimeout(()=>{
     const event=new MessageEvent('message',{origin:location.origin,data});
     Object.defineProperty(event,'source',{value:window.unsafeWindow});
     window.dispatchEvent(event);
   },0);
   return Reflect.get(t,k,t);
 }});
 window.GM_getValue=(k,d)=>window.__GM[k]===undefined?d:JSON.parse(JSON.stringify(window.__GM[k]));
 window.GM_setValue=(k,v)=>{window.__GM[k]=JSON.parse(JSON.stringify(v))};
 window.GM_listValues=()=>Object.keys(window.__GM); window.GM_deleteValue=k=>{delete window.__GM[k]};
 class MockXHR extends EventTarget {
  constructor(){super();this.readyState=0;this.status=0;this.responseType='';}
  open(method,url){this.method=method;this.url=url;this.readyState=1;}
  getResponseHeader(k){return 'application/json';}
  send(body){const f=String(this.url).includes('/ces/')?{body:{}}:window.__fixtures.shift()||{body:{}};setTimeout(()=>{this.readyState=4;this.status=f.status||200;this.responseText=JSON.stringify(f.body||{});this.response=f.body||{};this.dispatchEvent(new Event('progress'));this.dispatchEvent(new Event('loadend'));},10);}
 }
 window.XMLHttpRequest=MockXHR;
 window.GM_addValueChangeListener=()=>1;
 window.__menus={}; window.GM_registerMenuCommand=(n,fn)=>{window.__menus[n]=fn};
 window.__controllers={}; window.__fixtures=[]; window.__siteCalls=[];
 window.__beacons=[]; navigator.sendBeacon=function(url,data){window.__beacons.push({url:String(url)});return true};
 const nativeFetch=window.fetch.bind(window);
 window.__mockFetch=function(input, init){
   const url=typeof input==='string'? input:input.url;
   window.__siteCalls.push(url);
   if (url.includes('/ces/')) return Promise.resolve(new Response('{}',{headers:{'content-type':'application/json'}}));
   if (!window.__fixtures.length) return nativeFetch(input,init);
   const f=window.__fixtures.shift();
   if((init?.signal||input?.signal)?.aborted) return Promise.reject(new DOMException('Aborted','AbortError'));
   if(f.reject)return Promise.reject(new TypeError('Simulated connection lost (delivery unknown)'));
   if(f.kind==='controlled'){
     const stream=new ReadableStream({start(c){window.__controllers[f.key]=c;}});
     return new Promise(resolve=>setTimeout(()=>resolve(new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}})),f.headersDelay||0));
   }

   if (f.kind==='json') return Promise.resolve(new Response(JSON.stringify(f.body),{status:f.status||200,headers:{'content-type':'application/json'}}));
   const enc=new TextEncoder(); let i=0, stopped=false, timer;
   const stream=new ReadableStream({start(c){
     function next(){ if(stopped)return; if(i >= f.chunks.length){if(!f.stayOpen){try{c.close()}catch(_){}}return;}
       const item=f.chunks[i++]; timer=setTimeout(()=>{if(stopped)return;try{if(item.error){c.error(new Error('test stream ended'));return;}c.enqueue(enc.encode(item.text));next()}catch(_){}},item.ms||0);
     } next();
   },cancel(){stopped=true;clearTimeout(timer)}});
   return Promise.resolve(new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}}));
 };
 window.fetch=window.__mockFetch;
})();
'''
HTML='''<!doctype html><html><head><style>body{margin:0;background:#17181a;color:#e9edf2;font-family:Arial,sans-serif}main{margin:80px 90px}h1{font-size:28px}p{color:#a3a9b3}header{padding:25px 35px;border-bottom:1px solid #30323a}</style></head><body><header>ChatGPT · 本地模拟测试页面</header><main><h1>用量估算器 · v1.2.8</h1><p>此画面由脚本实际渲染，示例数据用于验证界面。</p><button class="__composer-pill" aria-haspopup="menu">6<br>Pro</button><div id="quick-model-menu" hidden><button role="menuitem" aria-label="选择模型" aria-expanded="false">选择模型</button><div id="quick-model-radios" data-testid="composer-model-picker-slider-advanced-view" data-active="false"><div role="menuitemradio">最新</div><div role="menuitemradio">GPT-5.6 Sol</div></div></div><textarea id="prompt-textarea"></textarea></main><script>(()=>{const button=document.querySelector('.__composer-pill'),menu=document.querySelector('#quick-model-menu'),choose=menu.querySelector('[role="menuitem"]'),radios=document.querySelector('#quick-model-radios'),prompt=document.querySelector('#prompt-textarea');let selected='6 Pro';button.addEventListener('pointerdown',()=>{menu.hidden=false;radios.dataset.active='false';choose.setAttribute('aria-expanded','false');button.textContent='思考强度'});choose.addEventListener('click',()=>{choose.setAttribute('aria-expanded','true');setTimeout(()=>{radios.dataset.active='true'},80)});for(const radio of radios.querySelectorAll('[role="menuitemradio"]'))radio.addEventListener('click',()=>{selected=radio.innerText==='最新'?'6 Pro':'5.6 Pro'});prompt.addEventListener('pointerdown',()=>{menu.hidden=true;button.innerHTML=(window.__breakComposerLabel?'错误模型':selected).replace(' ','<br>')})})()</script></body></html>'''
res=[]

def check(name, fn):
 try:
  detail=fn()
  res.append({'test':name,'result':'PASS','detail':detail})
  print('PASS', name, detail or '', flush=True)
 except Exception as e:
  res.append({'test':name,'result':'FAIL','error':str(e)})
  print('FAIL',name,repr(e),flush=True)
  traceback.print_exc()

def state(page):
 return page.evaluate('(k)=>window.GM_getValue(k,{})',KEY) or {}
def records(p):return state(p).get('records',[])
def pending(p):return state(p).get('pending',[])
def wait(p,ms=120):p.wait_for_timeout(ms)
def make_response(id,model=None,extra=None,complete=True):
 metadata={} if model is None else {'model_slug':model}
 if extra:metadata.update(extra)
 return {'message':{'id':id,'author':{'role':'assistant'},'status':'finished_successfully' if complete else 'in_progress',
 'end_turn':complete,'channel':'final','content':{'parts':['PRIVATE_REPLY_BODY_TEST']},'metadata':metadata}}
def send(p,uid,requested='gpt-6-pro',response=None,fixture=None,conversation='c-test',extra_body=None):
 body={'action':'next','messages':[{'id':uid,'author':{'role':'user'},'content':{'parts':['PRIVATE_PROMPT_BODY_TEST']}}],'model':requested,'conversation_id':conversation}
 if extra_body:body.update(extra_body)
 f=fixture or {'kind':'json','body':response if response is not None else make_response('as-'+uid,requested)}
 p.evaluate('''({body,f})=>{window.__fixtures.push(f); window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(body)}).then(r=>r.text()).catch(()=>{});}''',{'body':body,'f':f})
 wait(p)
def stream_obj(obj):return 'data: '+json.dumps(obj)+'\n\n'
def hints(p,uid,model='gpt-5.6-sol-pro',channel='fetch',extra=None):
 body={'batch':[{'message_id':uid,'turn_analytics':{'server_ste_metadata':{'model_slug':model}},**(extra or {})}], 'text':'PRIVATE_TELEMETRY_BODY_TEST'}
 p.evaluate('''({body,channel})=>{
 const text=JSON.stringify(body),url='/ces/v1/telemetry/intake';
 if(channel==='beacon')navigator.sendBeacon(url,new Blob([text],{type:'application/json'}));
 else if(channel==='xhr'){const x=new XMLHttpRequest(); x.open('POST',url); x.send(text);}
 else fetch(url,{method:'POST',body:text}).catch(()=>{});
 }''',{'body':body,'channel':channel});wait(p)

def newpage(ctx,old=None):
 initial=old.evaluate('window.__GM') if old else {}
 p=ctx.new_page();p.set_default_timeout(2000)
 p.set_content(HTML)
 p.evaluate('(data)=>{window.__initialGM=data}',initial)
 p.add_script_tag(content=SHIM+SCRIPT)
 p.locator('#chatgpt-pro-usage-estimator .panel').wait_for();wait(p)
 if old:old.close()
 return p


def eq(a,b):
 assert a==b,f'expected {b!r}, got {a!r}'
 return a
def led(p,uid):return next((x for x in pending(p) if x.get('userMessageId')==uid),None)
def rec(p,uid):
 a=led(p,uid);return next((r for r in records(p) if a and r['requestId']==a['requestId']),None)
def control(p,uid,model='gpt-6-pro',key=None,headers=0,conversation='ca',extra=None):
 send(p,uid,model,fixture={'kind':'controlled','key':key or uid,'headersDelay':headers},conversation=conversation,extra_body=extra)
def emit(p,key,obj,close=False):
 text=stream_obj(obj) if not isinstance(obj,str) else 'data: '+obj+'\n\n'
 p.evaluate('''({key,text,close})=>{const c=__controllers[key];c.enqueue(new TextEncoder().encode(text));if(close)c.close()}''',{'key':key,'text':text,'close':close});wait(p)
def end_stream(p,key,error=False):
 p.evaluate('''({key,error})=>{const c=__controllers[key];if(error)c.error(new Error('connection lost'));else c.close()}''',{'key':key,'error':error});wait(p)
def event(p,payload):
 p.evaluate('''payload=>{const h=window.__CHATGPT_PRO_USAGE_ESTIMATOR_HOOK_V2__;unsafeWindow.postMessage({source:'chatgpt-pro-usage-estimator-hook-v2',channel:h.channel,payload})}''',payload);wait(p)
def back(p):
 b=p.locator('[data-action="back-main"]')
 if b.count():b.click();wait(p)
def mode(p,v):
 back(p);p.locator('[data-action="settings"]').first.click();p.locator('[data-setting="countingMode"]').select_option(v);back(p)

with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=__import__('os').environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 ctx=browser.new_context(viewport={'width':1280,'height':900});p=newpage(ctx)
 check('Tampermonkey page-window message source reaches UI',lambda:eq(p.locator('.running').inner_text(),'已挂接'))
 check('default schema, request-first mode, compact UI',lambda:(eq(state(p)['schemaVersion'],5),eq(state(p)['settings']['countingMode'],'request-first'),eq(p.locator('.metric-card').count(),3),eq(p.locator('.script-version').inner_text(),'脚本 v1.2.8')))
 def quick_switch():
  p.locator('[data-action="quick-switch-sol"]').click();wait(p,300);eq(' '.join(p.locator('button.__composer-pill').inner_text().split()),'5.6 Pro');assert '已切换到 5.6 Pro' in p.locator('.toast').inner_text()
  p.locator('[data-action="quick-switch-gpt6"]').click();wait(p,300);eq(' '.join(p.locator('button.__composer-pill').inner_text().split()),'6 Pro');assert '已切换到 6 Pro' in p.locator('.toast').inner_text()
 check('quick model buttons select radio, close menu, and verify editor label',quick_switch)
 def quick_switch_failure():
  p.evaluate('window.__breakComposerLabel=true');p.locator('[data-action="quick-switch-sol"]').click()
  p.locator('.toast').filter(has_text='切换到 5.6 Pro 失败：编辑器未确认显示“5.6 Pro”').wait_for(timeout=3000)
  p.evaluate('window.__breakComposerLabel=false')
 check('quick model switch reports an unverified editor label',quick_switch_failure)
 def initial_send():
  control(p,'a',headers=1200);eq(rec(p,'a')['status'],'provisional');eq(led(p,'a')['accepted'],False)
  return '1 provisional before headers or any reasoning text'
 check('count immediately before any response headers',initial_send)
 def parallel():
  p.evaluate("history.pushState({},'', '/c/cb')");control(p,'b','gpt-5.6-sol-pro',conversation='cb')
  eq(len(records(p)),2);eq(led(p,'a')['conversationId'],'ca');eq(led(p,'b')['conversationId'],'cb');return p.locator('.running').inner_text()
 check('switch to B while A thinks: immediately count both',parallel)
 def b_first():
  emit(p,'b',{'type':'server_ste_metadata','metadata':{'model_slug':'gpt-5.6-sol-pro'}});eq(rec(p,'b')['status'],'confirmed');eq(len(records(p)),2)
 check('B confirms at first model metadata without another +1',b_first)
 def a_later():
  emit(p,'a',{'type':'server_ste_metadata','metadata':{'model_slug':'gpt-6-pro'}});wait(p,1250);eq(rec(p,'a')['status'],'confirmed');eq(len(records(p)),2)
 check('A later model metadata still updates A after route switch',a_later)
 def done():
  a=rec(p,'a').copy();emit(p,'a',make_response('as-a','gpt-6-pro'));emit(p,'a','[DONE]',True);emit(p,'b','[DONE]',True)
  eq(len(records(p)),2);eq(rec(p,'a')['id'],a['id']);eq(rec(p,'a')['ts'],a['ts'])
 check('completion and DONE never increment twice or reset dispatch timestamp',done)
 def move():
  control(p,'move');before=rec(p,'move').copy();n=len(records(p));emit(p,'move',{'metadata':{'resolved_model_slug':'gpt-5.6-sol-pro'}})
  eq(rec(p,'move')['model'],'solpro');eq(rec(p,'move')['id'],before['id']);eq(rec(p,'move')['ts'],before['ts']);eq(len(records(p)),n)
 check('routing GPT6 to 5.6 Pro moves the same entry',move)
 def down():
  control(p,'down');n=len(records(p));emit(p,'down',{'metadata':{'resolved_model_slug':'gpt-5.6-thinking-medium'}});eq(rec(p,'down'),None);eq(len(records(p)),n-1)
 check('explicit non-Pro model rolls back provisional',down)
 def lost():
  control(p,'lost');end_stream(p,'lost',True);eq(rec(p,'lost')['status'],'provisional');eq(led(p,'lost')['stage'],'awaiting')
 check('connection interrupted: provisional survives',lost)
 def unknown():
  send(p,'unknown',response=make_response('as-unknown',None));eq(rec(p,'unknown')['status'],'provisional')
 check('reply completes without model: provisional survives',unknown)
 def httpfail(code):
  n=len(records(p));send(p,f'http{code}',fixture={'kind':'json','status':code,'body':{'error':{'code':'test'}}});eq(len(records(p)),n);eq(led(p,f'http{code}')['rejected'],True)
 check('HTTP429 rolls back local estimate',lambda:httpfail(429))
 check('HTTP500 rolls back local estimate',lambda:httpfail(500))
 def retry_after_failure():
  n=len(records(p));send(p,'retry-fail',fixture={'kind':'json','status':429,'body':{}},conversation='ca',extra_body={'client_request_id':'retry-client'})
  control(p,'retry-fail',key='retry-now',extra={'client_request_id':'retry-client'});eq(len(records(p)),n+1)
  attempts=[x for x in pending(p) if x['userMessageId']=='retry-fail'];eq(len(attempts),2);eq(attempts[0]['rejected'],True);eq(attempts[1]['duplicateOf'],'')
 check('retry after explicit rejection with reused client ID is a new attempt',retry_after_failure)

 def reject():
  send(p,'rejectednet',fixture={'reject':True});eq(rec(p,'rejectednet')['status'],'provisional');eq(led(p,'rejectednet')['rejected'],False)
 check('fetch rejected without response: delivery unknown, not automatic refund',reject)
 def abort_before():
  n=len(records(p));p.evaluate('''()=>{const c=new AbortController();c.abort();__fixtures.push({reject:true});fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({action:'next',model:'gpt-6-pro',messages:[{id:'aborted',role:'user'}]}),signal:c.signal}).catch(()=>{})}''');wait(p);eq(len(records(p)),n)
 check('already aborted before dispatch does not add usage',abort_before)
 def abort_after_dispatch():
  p.evaluate('''()=>{const c=new AbortController();__fixtures.push({kind:'controlled',key:'abort-after'});fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({action:'next',model:'gpt-6-pro',messages:[{id:'abort-after',role:'user'}]}),signal:c.signal}).then(r=>r.text()).catch(()=>{});c.abort()}''');wait(p)
  eq(rec(p,'abort-after')['status'],'provisional');eq(led(p,'abort-after')['rejected'],False)
 check('abort AFTER dispatch but before body decoding does not refund',abort_after_dispatch)

 def analysis_meta():
  control(p,'thinking');m=make_response('thinking-as','gpt-6-pro',complete=False);m['message']['channel']='analysis';emit(p,'thinking',m);eq(rec(p,'thinking')['status'],'confirmed');eq(led(p,'thinking')['responseComplete'],False)
 check('early analysis metadata confirms without final answer',analysis_meta)
 def analysis_only():
  control(p,'analysis');m=make_response('analysis-as',None,complete=False);m['message']['channel']='analysis';emit(p,'analysis',m);eq(rec(p,'analysis')['status'],'provisional')
 check('analysis channel by itself is not a model name',analysis_only)
 def bare_sol():
  control(p,'bare','gpt-5-6-sol');eq(rec(p,'bare'),None)
 check('bare Sol with unspecified Pro tier is not guessed',bare_sol)
 def effort():
  control(p,'effort','gpt-5-6-sol',extra={'thinking_effort':'pro'});eq(rec(p,'effort')['model'],'solpro');eq(rec(p,'effort')['status'],'provisional')
 check('request Sol plus explicit Pro effort is counted immediately',effort)
 def medium():
  control(p,'medium','gpt-5-6-sol',extra={'thinking_effort':'medium'});eq(rec(p,'medium'),None)
 check('request Sol plus medium is excluded',medium)
 def explicit_pro_priority():
  control(p,'explicit6','gpt-6-pro',extra={'thinking_effort':'high'});eq(rec(p,'explicit6')['model'],'gpt6')
  control(p,'explicit56','gpt-5.6-sol-pro',extra={'thinking_effort':'high'});eq(rec(p,'explicit56')['model'],'solpro')
 check('explicit Pro identity is not overridden by generic internal effort',explicit_pro_priority)

 def effort_response():
  emit(p,'effort',{'type':'server_ste_metadata','metadata':{'model_slug':'gpt-5-6-sol','thinking_effort':'pro'}});eq(rec(p,'effort')['status'],'confirmed')
 check('response Pro effort disambiguates Sol tier',effort_response)
 def ambig_response():
  control(p,'ambig','gpt-5.6-sol-pro');emit(p,'ambig',{'metadata':{'model_slug':'gpt-5-6-sol'}});eq(rec(p,'ambig')['status'],'provisional')
 check('ambiguous response model never refunds requested Pro',ambig_response)
 def late_resolved():
  control(p,'late');emit(p,'late',make_response('late-as','gpt-6-pro'));eq(rec(p,'late')['status'],'confirmed');emit(p,'late',{'metadata':{'resolved_model_slug':'gpt-5.6-thinking-medium'}});eq(rec(p,'late'),None)
 check('resolved-model event AFTER final message still corrects before EOF',late_resolved)
 def stronger():
  control(p,'strong');emit(p,'strong',{'metadata':{'resolved_model_slug':'gpt-5.6-sol-pro'}});emit(p,'strong',make_response('strong-as','gpt-6-pro',complete=False));eq(rec(p,'strong')['model'],'solpro')
 check('weaker declared model cannot override resolved model',stronger)
 def hint():
  control(p,'hint');hints(p,'hint','gpt-5.6-sol-pro','beacon');eq(rec(p,'hint')['model'],'solpro');eq(rec(p,'hint')['status'],'confirmed')
 check('exact-ID beacon metadata corrects while generation is still open',hint)
 def unmatch():
  n=len(records(p));hints(p,'no-such-user');eq(len(records(p)),n)
 check('unmatched telemetry never creates new usage',unmatch)
 def regenerate():
  control(p,'reg',key='reg1');n=len(records(p));control(p,'reg',key='reg2',extra={'action':'regenerate'});eq(len(records(p)),n+1)
  hints(p,'reg','gpt-5.6-sol-pro');ids=[r['requestId'] for r in pending(p) if r['userMessageId']=='reg'];eq(len(ids),2);eq(sum(r['status']=='provisional' for r in records(p) if r['requestId'] in ids),2)
 check('regeneration is separate; shared user-ID hints remain ambiguous',regenerate)
 def attempt_dedup():
  control(p,'dup',key='dup1',extra={'client_request_id':'req-explicit'});n=len(records(p));control(p,'dup',key='dup2',extra={'client_request_id':'req-explicit'});eq(len(records(p)),n)
  emit(p,'dup2',{'metadata':{'resolved_model_slug':'gpt-5.6-sol-pro'}});eq(rec(p,'dup')['model'],'solpro')
 check('same explicit client attempt counts once, duplicate response can confirm',attempt_dedup)
 def assistant_dedup():
  control(p,'as1');control(p,'as2');n=len(records(p));emit(p,'as1',make_response('one-assistant','gpt-6-pro',complete=False));emit(p,'as2',make_response('one-assistant','gpt-6-pro',complete=False));eq(len(records(p)),n-1)
 check('same assistant redelivered is not counted twice',assistant_dedup)
 def strict():
  mode(p,'model-first');control(p,'strict');eq(rec(p,'strict'),None);emit(p,'strict',{'metadata':{'resolved_model_slug':'gpt-6-pro'}});eq(rec(p,'strict')['status'],'confirmed');eq(led(p,'strict')['responseComplete'],False);mode(p,'request-first')
 check('strict mode also confirms at first model, not answer completion',strict)
 def mode_future():
  control(p,'mode-future');mode(p,'model-first');eq(rec(p,'mode-future')['status'],'provisional');mode(p,'request-first')
 check('mode change only affects future requests',mode_future)
 def xhr():
  n=len(records(p));p.evaluate('''()=>{__fixtures.push({body:{type:'server_ste_metadata',metadata:{model_slug:'gpt-5.6-sol-pro'}}});const x=new XMLHttpRequest();x.open('POST','/backend-api/f/conversation');x.send(JSON.stringify({action:'next',model:'gpt-6-pro',messages:[{id:'xhr-user',role:'user'}]}));}''');wait(p);eq(len(records(p)),n+1);eq(rec(p,'xhr-user')['model'],'solpro')
 check('XHR follows request-first accounting',xhr)
 def fetch_body_formats():
  for kind in ['request','blob']:
   uid='body-'+kind;n=len(records(p))
   p.evaluate('''({kind,uid})=>{__fixtures.push({kind:'controlled',key:uid});const text=JSON.stringify({action:'next',model:'gpt-5.6-sol-pro',messages:[{id:uid,role:'user'}]});const url='https://chatgpt.example.invalid/backend-api/f/conversation';const init={method:'POST',body:kind==='blob'?new Blob([text],{type:'application/json'}):text};const task=kind==='request'?fetch(new Request(url,init)):fetch(url,init);task.then(r=>r.text()).catch(()=>{})}''',{'kind':kind,'uid':uid});wait(p)
   eq(len(records(p)),n+1);eq(rec(p,uid)['status'],'provisional')
 check('Request object and Blob fetch bodies also count before response',fetch_body_formats)

 def excluded():
  n=len(records(p));send(p,'custom',extra_body={'gizmo_id':'g-test'});send(p,'work',extra_body={'mode':'work'});p.evaluate("history.pushState({},'', '/codex/tasks/x')");send(p,'codex');p.evaluate("history.pushState({},'', '/c/back')");eq(len(records(p)),n)
 check('custom GPT, Work and Codex excluded',excluded)
 def fetch_replace():
  p.evaluate('()=>{window.fetch=window.__mockFetch;}');control(p,'replaced');eq(rec(p,'replaced')['status'],'provisional')
 check('fetch replacement still immediately hooked',fetch_replace)
 def privacy():
  raw=json.dumps(p.evaluate('window.__GM'))
  for mark in ['PRIVATE_PROMPT_BODY_TEST','PRIVATE_REPLY_BODY_TEST','PRIVATE_TELEMETRY_BODY_TEST']:assert mark not in raw
 check('no message body saved, including journals',privacy)
 def restore():
  global p
  control(p,'reload');n=len(records(p));p=newpage(ctx,p);eq(len(records(p)),n);eq(rec(p,'reload')['status'],'provisional')
 check('reload preserves provisional counts once',restore)
 def snapshot():
  m=make_response('snapshot-as','gpt-5.6-sol-pro',complete=False)['message'];m['channel']='analysis';m['create_time']=time.time()
  obj={'conversation_id':'ca','mapping':{'u':{'message':{'id':'reload','author':{'role':'user'}},'parent':None},'as':{'message':m,'parent':'u'}}}
  p.evaluate('''obj=>{__fixtures.push({kind:'json',body:obj});fetch('/backend-api/conversation/ca').then(r=>r.json())}''',obj);wait(p);eq(rec(p,'reload')['model'],'solpro');eq(rec(p,'reload')['status'],'confirmed')
 check('passive history GET can confirm while assistant still thinks',snapshot)
 def unrelated_history():
  n=len(records(p));m=make_response('unrelated-as','gpt-6-pro')['message'];m['create_time']=time.time()
  event(p,{'type':'conversation-snapshot','conversationId':'ca','nodes':[{'nodeId':'u0','role':'user','messageId':'UNSEEN','parent':''},{'nodeId':'a0','role':'assistant','parent':'u0','message':m}]});eq(len(records(p)),n)
 check('no blind backfill of unrelated historical messages',unrelated_history)
 def recover_journal():
  global p
  control(p,'journal');id0=rec(p,'journal')['id'];n=len(records(p));p.evaluate('''({key,id})=>{const s=__GM[key];s.records=s.records.filter(r=>r.id!==id);s.pending=s.pending.filter(r=>r.userMessageId!=='journal')}''',{'key':KEY,'id':id0});p=newpage(ctx,p);eq(len(records(p)),n);eq(rec(p,'journal')['id'],id0)
 check('request journal recovers missing shared-state flush',recover_journal)
 def manual_class():
  control(p,'manual');n=len(records(p));rid=rec(p,'manual')['id'];qid=led(p,'manual')['requestId'];p.locator('.running').click();p.locator(f'[data-action="resolve-pending-sol"][data-request-id="{qid}"]').click();wait(p);back(p)
  eq(len(records(p)),n);eq(rec(p,'manual')['id'],rid);eq(rec(p,'manual')['model'],'solpro');eq(rec(p,'manual')['status'],'manual');emit(p,'manual',{'metadata':{'resolved_model_slug':'gpt-6-pro'}});eq(rec(p,'manual')['model'],'solpro')
 check('manual classification updates same entry and locks decision',manual_class)
 def manual_rm():
  control(p,'remove');qid=led(p,'remove')['requestId'];n=len(records(p));p.locator('.running').click();p.locator(f'[data-action="ignore-pending"][data-request-id="{qid}"]').click();wait(p);back(p);eq(len(records(p)),n-1);emit(p,'remove',{'metadata':{'resolved_model_slug':'gpt-6-pro'}});eq(rec(p,'remove'),None)
 check('manual remove cannot be resurrected by delayed evidence',manual_rm)
 def minus():
  control(p,'minus');n=len(records(p));p.locator('[data-action="settings"]').first.click();p.locator('[data-action="manual-remove-gpt6"]').click();wait(p);back(p);eq(len(records(p)),n-1);emit(p,'minus',{'metadata':{'resolved_model_slug':'gpt-6-pro'}});eq(rec(p,'minus'),None)
 check('manual -1 prevents later duplicate re-add',minus)
 def size():
  p.locator('[data-action="settings"]').first.click();p.locator('[data-size-slider]').evaluate('(e)=>{e.value=80;e.dispatchEvent(new Event("input",{bubbles:true,composed:true}));e.dispatchEvent(new Event("change",{bubbles:true,composed:true}));}');wait(p);back(p);eq(state(p)['settings']['panelScale'],.8);assert abs(p.locator('.panel').bounding_box()['width']-240)<1
 check('manual panel scaling still works',size)
 def size_reload():
  global p
  p=newpage(ctx,p);eq(state(p)['settings']['panelScale'],.8);assert abs(p.locator('.panel').bounding_box()['width']-240)<1
 check('reload restores saved 80-percent size',size_reload)
 def plan100():
  p.locator('[data-action="settings"]').first.click();p.locator('[data-setting="plan"]').select_option('pro100');back(p);assert '50' in p.locator('.metric-value').first.inner_text();p.locator('[data-action="settings"]').first.click();p.locator('[data-setting="plan"]').select_option('pro200');back(p)
 check('$100 shared weekly view retained',plan100)
 check('no browser errors or unhandled rejections',lambda:eq(p.evaluate('window.__testErrors'),[]))
 # Separate legacy upgrade and visual preview fixtures.
 old={'schemaVersion':4,'settings':{'plan':'pro100','panelScale':.75,'position':{'left':100,'top':80},'inferenceMode':'strict'},'records':[{'id':'legacy','ts':int(time.time()*1000),'model':'solpro','source':'manual','eventKey':'manual-old'}],'pending':[{'requestId':'oldwait','userMessageId':'old-user','requestedModel':'gpt-6-pro','startedAt':int(time.time()*1000),'stage':'awaiting'}],'logs':[]}
 o=ctx.new_page();o.set_content(HTML);o.evaluate('v=>window.__initialGM=v',{KEY:old});o.add_script_tag(content=SHIM+SCRIPT);wait(o)
 check('migration preserves plan, scale and old data, no historical auto-backfill',lambda:(eq(state(o)['settings']['countingMode'],'request-first'),eq(state(o)['settings']['panelScale'],.75),eq(state(o)['settings']['plan'],'pro100'),eq(len(records(o)),1)))

 def clear_all():
  control(o,'clear-active');qid=led(o,'clear-active')['requestId']
  o.on('dialog',lambda d:d.accept());o.locator('[data-action="settings"]').first.click();o.locator('[data-action="clear-all"]').click();wait(o)
  eq(len(records(o)),0);eq(len(pending(o)),0);assert not any('request-journal' in k for k in o.evaluate('Object.keys(__GM)'))
  event(o,{'type':'generation-progress','requestId':qid,'actualModel':'gpt-6-pro','actualModelPath':'metadata.resolved_model_slug','confidence':'actual'});eq(len(records(o)),0)
 check('clear-all removes journals and ignores delayed responses',clear_all)
 v=ctx.new_page();v.set_viewport_size({'width':1200,'height':800});v.set_content(HTML);now=int(time.time()*1000);data={'schemaVersion':5,'settings':{'plan':'pro200','panelScale':1},'records':[],'pending':[],'logs':[]}
 for i in range(57):data['records'].append({'id':f's6-{i}','eventKey':f's6-{i}','ts':now-(10000 if i<11 else 2*86400000),'model':'gpt6','source':'manual','status':'manual'})
 for i in range(35):data['records'].append({'id':f's56-{i}','eventKey':f's56-{i}','ts':now-10000,'model':'solpro','source':'manual','status':'manual'})
 v.evaluate('x=>window.__initialGM=x',{KEY:data});v.add_script_tag(content=SHIM+SCRIPT);wait(v);control(v,'preview');wait(v,2900)
 def preview():
  eq([x.inner_text().strip() for x in v.locator('.metric-value').all()],['58 / 200','35 / 170','47 / 200']);assert '含暂记 1 条' in v.locator('.unresolved-note').inner_text();v.locator('.panel').screenshot(path=str(ROOT/'usage-estimator-v1.2.8-preview.png'));return v.locator('.panel').bounding_box()
 check('actual UI renders 58/200,35/170,47/200 with 1 provisional included',preview)
 ctx.close();browser.close()
(ROOT/'test-results.json').write_text(json.dumps(res,ensure_ascii=False,indent=2),encoding='utf-8')
failed=sum(x['result']=='FAIL' for x in res);print(f'RESULT: {len(res)-failed}/{len(res)} PASS',flush=True)
raise SystemExit(1 if failed else 0)
