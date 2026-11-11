import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
const WEB=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.dirname(WEB),arr=x=>Array.isArray(x)?x:[],str=x=>typeof x==='string'?x:x==null?'':JSON.stringify(x);
fs.mkdirSync(path.join(WEB,'.index'),{recursive:true});
let state,extractor,modelName='',modelState=process.env.ATLAS_DISABLE_MODEL==='1'?'disabled':'loading',modelError='',generation=0, reloadPromise;
const githubOnly=p=>typeof p.github_only==='boolean'?p.github_only:arr(p.markets).length>0&&p.markets.every(m=>m==='github'||String(m).startsWith('github:'));
const included=u=>u.searchParams.get('include_github_only')==='1';
const FTS_BODY=Math.max(2000,Number(process.env.ATLAS_FTS_BODY)||12000),TFIDF_BODY=Math.max(1000,Number(process.env.ATLAS_TFIDF_BODY)||1500);
const safe=x=>typeof x==='string'&&!/[\\/]/.test(x)&&!x.includes('..');
const json=async p=>JSON.parse(await fs.promises.readFile(p,'utf8'));
const ancestor=(s,n,type)=>{const seen=new Set();while(n&&!seen.has(n.id)){if(n.type===type)return n.id;seen.add(n.id);n=s.nm.get(n.parent);}return null;};
const tokens=s=>{const t=str(s).toLowerCase(),a=t.match(/[a-z0-9_]+/g)||[];for(let n=1;n<=3;n++)for(let i=0;i<=t.length-n;i++){const v=t.slice(i,i+n);if(/[^\x00-\x7f]/.test(v)&&! /\s/.test(v))a.push(v);}return a;};
const dot=(a,b)=>{let n=0;for(const [k,v] of a)n+=v*(b.get(k)||0);return n;};
function vector(t,idf){const m=new Map();for(const k of tokens(t))m.set(k,(m.get(k)||0)+1);let norm=0;for(const [k,v]of m){const x=(1+Math.log(v))*(idf.get(k)||1);m.set(k,x);norm+=x*x;}norm=Math.sqrt(norm)||1;for(const [k,v]of m)m.set(k,v/norm);return m;}
function confined(base,p){const target=path.resolve(base,p);return target.startsWith(path.resolve(base)+path.sep)?target:null;}
function pluginFor(s,n){if(n.type!=='plugin')return undefined;return s.pm.get(n.plugin_id||n.id)||s.pm.get(arr(n.plugin_ids)[0]);}
function category(s,n){const seen=new Set();while(n&&!seen.has(n.id)){if(n.type==='category')return n.id;seen.add(n.id);n=s.nm.get(n.parent);}return null;}
function reload() {
  if (reloadPromise) return reloadPromise;
  reloadPromise = buildSnapshot().finally(() => { reloadPromise = null; });
  return reloadPromise;
}
async function buildSnapshot() {
  const start = performance.now(), timings = {};
  let loaded, dir, warning = '';
  for (const candidate of process.env.ATLAS_DATA_DIR ? [path.resolve(process.env.ATLAS_DATA_DIR), path.join(WEB,'fixtures')] : [path.join(ROOT,'data'),path.join(WEB,'fixtures')]) {
    try {
      const graph = await json(path.join(candidate,'graph.json'));
      const text = await fs.promises.readFile(path.join(candidate,'plugins.jsonl'),'utf8');
      const plugins = [];
      const lines = text.split(/\r?\n/);
      for(let i=0;i<lines.length;i++) { if(lines[i].trim()){const p=JSON.parse(lines[i]);if(p?.id)plugins.push({...p,github_only:githubOnly(p)});} if(i%256===0)await yieldNow(); }
      if(!arr(graph.nodes).length || !plugins.length)throw Error('数据为空');
      graph.nodes=graph.nodes.filter(n=>n?.id).map(n=>({...n,type:typeof n.type==='string'?n.type:'branch',label:n.label||n.id,summary:n.summary||''}));
      graph.edges=arr(graph.edges); loaded={graph,plugins};dir=candidate;break;
    } catch(e){warning+=`${candidate}: ${e.message}; `;}
  }
  if(!loaded)throw Error(warning);
  const s={...loaded,dir,source:dir===path.join(WEB,'fixtures')?'fixtures':'data',warning,nm:new Map(),pm:new Map(),pn:new Map(),children:new Map(),adj:new Map(),caps:new Map(),branchCaps:new Map(),readmes:new Map(),docs:[],vectors:null,embedding:{done:0,total:0,cached:0},generation:++generation};
  for(const p of s.plugins)s.pm.set(p.id,p);
  for(const n of s.graph.nodes){s.nm.set(n.id,n);if(!s.children.has(n.parent))s.children.set(n.parent,[]);s.children.get(n.parent).push(n);if(n.type==='plugin'){const p=pluginFor(s,n);n.github_only=typeof n.github_only==='boolean'?n.github_only:!!p?.github_only;if(p&&!s.pn.has(p.id))s.pn.set(p.id,n);}}
  s.relations=[...s.graph.edges.filter(e=>e.type!=='parent'),...s.graph.nodes.filter(n=>n.parent).map(n=>({source:n.parent,target:n.id,type:'parent'}))];
  for(const e of s.relations)for(const id of new Set([e.source,e.target])){if(!s.adj.has(id))s.adj.set(id,[]);s.adj.get(id).push(e);}
  const counts=new Map();
  for(const n of s.graph.nodes)if(n.type==='plugin'){let p=s.nm.get(n.parent);const seen=new Set();while(p&&!seen.has(p.id)){seen.add(p.id);const c=counts.get(p.id)||[0,0];c[1]++;if(!n.github_only)c[0]++;counts.set(p.id,c);p=s.nm.get(p.parent);}}
  let filteredOut=null;try{filteredOut=(await fs.promises.readFile(path.join(dir,'filtered-out.jsonl'),'utf8')).split('\n').filter(l=>l.trim()).length;}catch{}
  s.counts=counts;s.statCounts={plugins_visible:s.plugins.filter(p=>!p.github_only).length,github_only:s.plugins.filter(p=>p.github_only).length,plugin_nodes_visible:s.graph.nodes.filter(n=>n.type==='plugin'&&!n.github_only).length,relevance_suspect:s.plugins.filter(p=>p.relevance==='suspect'||p.suspect_irrelevant===true).length,filtered_out:filteredOut};timings.parse=performance.now()-start;
  const readStart=performance.now();let cursor=0;
  await Promise.all(Array.from({length:16},async()=>{while(cursor<s.plugins.length){const p=s.plugins[cursor++];let text='';if(p.readme_path)for(const base of [ROOT,dir]){const target=confined(base,p.readme_path);if(target)try{text=await fs.promises.readFile(target,'utf8');break;}catch{}}s.readmes.set(p.id,text);}}));
  const normalize=c=>({...c,union:arr(c.union).filter(u=>u&&typeof u==='object').map(u=>({...u,provided_by:arr(u.provided_by)})),duplicates:arr(c.duplicates).filter(Array.isArray)});
  for(const n of s.graph.nodes.filter(n=>n.type==='category'&&safe(n.id))){
    try{s.caps.set(n.id,normalize(await json(path.join(dir,'capabilities',n.id+'.json'))));}catch{}
    const directory=path.join(dir,'capabilities',n.id);let files=[];try{files=await fs.promises.readdir(directory);}catch{}
    const loadedFiles=new Map();for(const f of files.filter(f=>f.endsWith('.json')&&safe(f)))try{loadedFiles.set(f,normalize(await json(path.join(directory,f))));}catch{}
    for(const b of s.graph.nodes.filter(b=>b.type==='branch'&&ancestor(s,b,'category')===n.id&&safe(b.id))){const c=loadedFiles.get(b.id+'.json')||loadedFiles.get(b.id.startsWith(n.id+'.')?b.id.slice(n.id.length+1)+'.json':'');if(c)s.branchCaps.set(b.id,c);}
    if(!s.caps.has(n.id)&&loadedFiles.size)s.caps.set(n.id,{category_id:n.id,merged_from_branches:true,union:[...loadedFiles.values()].flatMap(c=>c.union),duplicates:[...loadedFiles.values()].flatMap(c=>c.duplicates)});
    // Index every branch file, including files whose branch is absent from this graph.
    for(const [f,c]of loadedFiles)s.branchCaps.set(n.id+'/'+f,c);
  }
  timings.readmes=performance.now()-readStart;
  const add=(kind,id,title,body,node_id,github_only=false)=>s.docs.push({kind,id,title:str(title),body:str(body),node_id,github_only});
  for(const n of s.graph.nodes)add('node',n.id,n.label,[n.summary,n.fork_reason].map(str).join(' '),n.id,n.type==='plugin'&&n.github_only);
  for(const p of s.plugins)add('plugin',p.id,p.name||p.id,[p.description,p.summary,p.keywords,p.capabilities,p.tools,p.provides,s.readmes.get(p.id)].map(str).join(' '),s.pn.get(p.id)?.id||null,p.github_only);
  for(const [id,c]of [...s.caps,...s.branchCaps]){const node=s.nm.has(id)?id:id.split('/')[0];arr(c.union).forEach((u,i)=>add('capability',id+':'+i,u.capability,[u.note,u.provided_by,u.best_impl].map(str).join(' '),node));if(c.vision)add('capability',id+':vision',(c.label||id)+' · 愿景',c.vision,node);}
  const ftsStart=performance.now();s.db=new DatabaseSync(':memory:');s.db.exec("CREATE VIRTUAL TABLE docs USING fts5(title,body,tokenize='trigram')");const insert=s.db.prepare('INSERT INTO docs(rowid,title,body) VALUES(?,?,?)');
  s.db.exec('BEGIN');for(let i=0;i<s.docs.length;i++){const d=s.docs[i];insert.run(i+1,d.title,d.body.length>FTS_BODY?d.body.slice(0,FTS_BODY):d.body);if(i%64===0)await yieldNow();}s.db.exec('COMMIT');timings.fts=performance.now()-ftsStart;
  const tfStart=performance.now();s.idf=new Map();
  for(let i=0;i<s.docs.length;i++){const d=s.docs[i];for(const t of new Set(tokens(d.title+' '+d.body.slice(0,TFIDF_BODY))))s.idf.set(t,(s.idf.get(t)||0)+1);if(i%64===0)await yieldNow();}
  for(const [k,v]of s.idf)s.idf.set(k,Math.log(1+s.docs.length/(1+v))+1);
  s.tfidf=[];for(let i=0;i<s.docs.length;i++){const d=s.docs[i];s.tfidf.push(vector(d.title+' '+d.body.slice(0,TFIDF_BODY),s.idf));if(i%64===0)await yieldNow();}
  timings.tfidf=performance.now()-tfStart;timings.total=performance.now()-start;s.timings=timings;
  s.embedding.total=s.docs.length;
  const old=state;state=s;old?.db.close();if(extractor)void embedState(s);return {...status(),ok:true,timings,took_ms:Math.round(timings.total)};
}
function semanticBackend(s=state){
  const ready=!!s?.vectors;
  const reason=ready?null:modelState==='disabled'?'模型已禁用':modelState==='failed'?'模型失败':extractor?`向量计算中 ${s?.embedding.done||0}/${s?.docs.length||0}`:'模型加载中';
  return {backend:ready?'minilm':'tfidf',model:modelName||null,label:ready?`transformers.js MiniLM (${modelName})`:`TF-IDF（降级：${reason}）`,reason};
}
function status(){
  const semantic=semanticBackend();if(!state)return {loading:true,semantic,semantic_backend:semantic.label,model_status:modelState};
  const s=state;return {loading:!!reloadPromise,source:s.source,data_dir:s.dir,example:s.graph.example===true,counts:{nodes:s.graph.nodes.length,plugins:s.plugins.length,...s.statCounts,edges:s.graph.edges.length,capabilities:s.caps.size},index:{documents:s.docs.length,fulltext:'sqlite-fts5-trigram',vectors:s.vectors?.length||s.tfidf?.length||0},semantic,semantic_backend:semantic.label,embedding:s.embedding,model_status:modelState,model_error:modelError||undefined,warning:s.warning||undefined,timings:s.timings};
}
let embeddingQueue=Promise.resolve();
function embedState(s){embeddingQueue=embeddingQueue.catch(()=>{}).then(()=>embedSnapshot(s));return embeddingQueue;}
async function embedSnapshot(s){
  if(!s||state!==s)return;
  const base=path.join(WEB,'.models','embeddings-'+modelName.replace(/[^a-z0-9_-]/gi,'_'));
  await fs.promises.mkdir(path.dirname(base),{recursive:true});
  let index={},bytes=Buffer.alloc(0);try{index=await json(base+'.json');bytes=await fs.promises.readFile(base+'.bin');}catch{}
  const chunks=[bytes], memoryCache=new Map();let length=bytes.length;const vectors=[];s.embedding={done:0,total:s.docs.length,cached:0};
  let dirty=false,lastFlush=Date.now();const flush=async(force=true)=>{if(!dirty||(!force&&Date.now()-lastFlush<30000))return;dirty=false;lastFlush=Date.now();await fs.promises.writeFile(base+'.bin.tmp',Buffer.concat(chunks));await fs.promises.rename(base+'.bin.tmp',base+'.bin');await fs.promises.writeFile(base+'.json.tmp',JSON.stringify(index));await fs.promises.rename(base+'.json.tmp',base+'.json');};
  try{for(const d of s.docs){if(state!==s){await flush();return;}const text=(d.title+' '+d.body).slice(0,4000),key=createHash('sha1').update(modelName+'\0'+text).digest('hex');let v;const hit=index[key];
    if(memoryCache.has(key)){v=memoryCache.get(key);s.embedding.cached++;}
    else if(hit&&hit.offset+hit.length*4<=bytes.length){v=new Float32Array(hit.length);for(let j=0;j<v.length;j++)v[j]=bytes.readFloatLE(hit.offset+j*4);s.embedding.cached++;}
    else{v=Float32Array.from((await extractor(text,{pooling:'mean',normalize:true})).data);const b=Buffer.alloc(v.length*4);for(let j=0;j<v.length;j++)b.writeFloatLE(v[j],j*4);index[key]={offset:length,length:v.length};length+=b.length;chunks.push(b);dirty=true;}
    memoryCache.set(key,v);vectors.push(v);s.embedding.done++;if(s.embedding.done%256===0){await flush(false);await yieldNow();}
  }await flush();if(state===s){s.vectors=vectors;s.tfidfDocs=s.tfidf.length;s.tfidf=null;}}catch(e){modelError=e.message;modelState='failed';}
}
async function initModel(){if(process.env.ATLAS_DISABLE_MODEL==='1'){modelState='disabled';return;}try{const {pipeline,env}=await import('@huggingface/transformers');env.cacheDir=path.join(WEB,'.models');env.allowLocalModels=false;for(const name of ['Xenova/paraphrase-multilingual-MiniLM-L12-v2','Xenova/all-MiniLM-L6-v2']){try{extractor=await pipeline('feature-extraction',name,{dtype:'q8',device:'cpu'});modelName=name;modelState='ready';modelError='';await embedState(state);return;}catch(e){modelError=e.message;console.error('Model failed:',name,e.message);}}modelState='failed';}catch(e){modelState='failed';modelError=e.message;}}
function relations(id,rel='all',s=state){if(!s.nm.has(id))return null;const edges=(s.adj.get(id)||[]).filter(e=>rel==='children'?e.type==='parent'&&e.source===id:rel==='parent'?e.type==='parent'&&e.target===id:rel==='all'||e.type===rel);const ids=new Set(edges.flatMap(e=>[e.source,e.target]).filter(x=>x!==id));return {node:s.nm.get(id),nodes:[...ids].map(x=>s.nm.get(x)).filter(Boolean),edges};}
function graphView(u,tree=false){const nodes=state.graph.nodes.filter(n=>(!tree||n.type!=='plugin')&&(included(u)||n.type!=='plugin'||!n.github_only));const ids=new Set(nodes.map(n=>n.id));return {...state.graph,nodes:tree?nodes.map(({plugin_ids,...n})=>({...n,plugin_ids_count:arr(plugin_ids).length,plugin_count:(state.counts.get(n.id)||[0,0])[included(u)?1:0],plugin_count_all:(state.counts.get(n.id)||[0,0])[1],has_children:(state.children.get(n.id)||[]).some(c=>included(u)||c.type!=='plugin'||!c.github_only)})):nodes,edges:state.graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)&&(!tree||e.type!=='parent'))};}
function childrenPage(u){const id=u.searchParams.get('node');if(!state.nm.has(id))return null;const children=(state.children.get(id)||[]).filter(n=>included(u)||n.type!=='plugin'||!n.github_only),limit=Math.min(1000,Math.max(1,parseInt(u.searchParams.get('limit'))||200));let offset=Math.max(0,parseInt(u.searchParams.get('offset'))||0);const around=children.findIndex(n=>n.id===u.searchParams.get('around'));if(around>=0)offset=Math.floor(around/limit)*limit;return {nodes:children.slice(offset,offset+limit).map(n=>{if(n.type!=='plugin')return n;const p=pluginFor(state,n);return {id:n.id,type:n.type,label:n.label,parent:n.parent,summary:n.summary,plugin_id:p?.id||n.plugin_id,github_only:n.github_only,relevance:p?.relevance||n.relevance||(p?.suspect_irrelevant?'suspect':undefined),markets:p?.markets||[],stars:p?.stars??null};}),edges:[...new Set(children.slice(offset,offset+limit).flatMap(n=>state.adj.get(n.id)||[]))].filter(e=>e.type!=='parent'),total:children.length,offset,limit,has_more:offset+limit<children.length};}
async function search(u){const q=(u.searchParams.get('q')||'').trim().slice(0,500),mode=u.searchParams.get('mode')||'hybrid',type=u.searchParams.get('type'),limit=Math.min(100,Math.max(1,parseInt(u.searchParams.get('limit'))||20));if(!['fulltext','semantic','hybrid'].includes(mode))throw Error('未知检索模式');const s=state,full=new Map(),sem=new Map();if(q&&mode!=='semantic'){let rows;if([...q].length<3)rows=s.db.prepare("SELECT rowid FROM docs WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'").all(...Array(2).fill('%'+q.replace(/[\\%_]/g,'\\$&')+'%'));else rows=s.db.prepare('SELECT rowid,bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank').all('"'+q.replaceAll('"','""')+'"');rows.forEach((r,i)=>full.set(r.rowid-1,1/(1+i)));}
if(q&&mode!=='fulltext'){if(s.vectors&&extractor){const v=Array.from((await extractor(q,{pooling:'mean',normalize:true})).data);s.vectors.forEach((w,i)=>sem.set(i,w.reduce((n,x,j)=>n+x*v[j],0)));}else if(s.tfidf){const v=vector(q,s.idf);s.tfidf.forEach((w,i)=>sem.set(i,dot(v,w)));}}
const results=s.docs.map((d,i)=>{const score=mode==='fulltext'?(full.get(i)||0):mode==='semantic'?(sem.get(i)||0):.55*(full.get(i)||0)+.45*(sem.get(i)||0);const at=d.body.toLowerCase().indexOf(q.toLowerCase());return {github_only:d.github_only,kind:d.kind,id:d.id,title:d.title,snippet:d.body.slice(Math.max(0,at-30),Math.max(0,at-30)+220),score,node_id:d.node_id};}).filter(d=>(included(u)||!d.github_only)&&d.score>0&&(!type||d.kind===type)).sort((a,b)=>b.score-a.score).slice(0,limit);const semantic=semanticBackend(s);return {q,mode,semantic,semantic_backend:semantic.label,results};}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(obj));
  };
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/status') return send(200, status());
    if (u.pathname === '/api/reload') {
      if (!['GET','POST'].includes(req.method)) return send(405, {error:'GET 或 POST'});
      return send(200, await reload());
    }
    if (u.pathname.startsWith('/api/') && !state) return send(503, {error:'loading'});
    if (u.pathname === '/api/tree') return send(200, graphView(u, true));
    if (u.pathname === '/api/children') {
      const result = childrenPage(u);
      return send(result ? 200 : 404, result || {error:'节点不存在'});
    }
    if (u.pathname === '/api/graph') return send(200, graphView(u));
    if (u.pathname === '/api/search') {
      if (u.searchParams.has('node')) {
        const result = relations(u.searchParams.get('node'), u.searchParams.get('rel') || 'all');
        return send(result ? 200 : 404, result || {error:'节点不存在'});
      }
      return send(200, await search(u));
    }
    if (u.pathname.startsWith('/api/node/')) {
      const id = decodeURIComponent(u.pathname.slice(10)), s = state, node = s.nm.get(id);
      if (!node) return send(404, {error:'节点不存在'});
      const plugin = pluginFor(s, node), ancestors = [], seen = new Set([id]);
      let parent = s.nm.get(node.parent);
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id); ancestors.unshift(parent); parent = s.nm.get(parent.parent);
      }
      return send(200, {
        node, plugin:plugin || null,
        readme_markdown:plugin ? s.readmes.get(plugin.id) || '' : '',
        ancestors, children:(s.children.get(id) || []).slice(0, 500), children_total:(s.children.get(id) || []).length, edges:relations(id, 'all', s).edges,
        capabilities:s.caps.get(category(s, node)) || null,
        branch_capabilities:s.branchCaps.get(ancestor(s, node, 'branch')) || null
      });
    }
    if (u.pathname.startsWith('/api/')) return send(404, {error:'未知接口'});
    const name = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname).replace(/^\//, '');
    const target = confined(path.join(WEB, 'public'), name);
    if (!target) return send(403, {error:'禁止访问'});
    const bytes = await fs.promises.readFile(target);
    res.writeHead(200, {'Content-Type':mime[path.extname(target)] || 'application/octet-stream','X-Content-Type-Options':'nosniff'});
    res.end(bytes);
  } catch (e) {
    send(e.code === 'ENOENT' ? 404 : 400, {error:e.message});
  }
});
server.listen(Number(process.env.PORT ?? 4380), '0.0.0.0', () => {
  console.log('Plugin Atlas listening', server.address(), status());
  void reload().catch(e => console.error(e));
  void initModel();
});
