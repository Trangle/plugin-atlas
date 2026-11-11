import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-test-'));
let child,browser;
async function get(base,p,options){const r=await fetch(base+p,options);assert.equal(r.status,200,p);return r.json();}
try{
 await fs.cp(new URL('./fixtures/',import.meta.url),tmp,{recursive:true});
 const plugins=(await fs.readFile(path.join(tmp,'plugins.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const original=JSON.parse(await fs.readFile(path.join(tmp,'graph.json'),'utf8'));
 plugins.forEach(p=>p.readme_path='readmes/'+p.package.split('/').at(-1)+'.md');
 plugins[0].markets=['github:x'];delete plugins[0].github_only;
 plugins[1].github_only=true;
 plugins[2].github_only=false;plugins[2].markets=['github'];plugins[2].summary_source='readme';plugins[2].relevance='suspect';plugins[2].relevance_reason='测试原因';plugins[2].merged_from=[{id:'github:x/dup',rule:'repo'}];
 original.nodes.find(n=>n.id===plugins[2].id).summary_source='readme';
 const writePlugins=()=>fs.writeFile(path.join(tmp,'plugins.jsonl'),plugins.map(JSON.stringify).join('\n'));
 await writePlugins();await fs.writeFile(path.join(tmp,'graph.json'),JSON.stringify(original));
 await fs.mkdir(path.join(tmp,'capabilities','knowledge'),{recursive:true});
 await fs.writeFile(path.join(tmp,'capabilities','knowledge','retrieval.json'),JSON.stringify({union:[{capability:'branchUnique',provided_by:[]}]}));
 await fs.rm(path.join(tmp,'capabilities','developer.json'));
 await fs.mkdir(path.join(tmp,'capabilities','developer'),{recursive:true});
 await fs.writeFile(path.join(tmp,'capabilities','developer','code.json'),JSON.stringify({union:[{capability:'mergedUnique'}]}));
 await fs.rm(path.join(tmp,'capabilities','workflow.json'));
 child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:'0',ATLAS_DATA_DIR:tmp,ATLAS_DISABLE_MODEL:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',b=>{logs+=b;});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'startup timeout')),15000);child.stdout.on('data',b=>{logs+=b;const m=logs.match(/port: (\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',c=>reject(Error('exit '+c+'\n'+logs)));});
 const base='http://127.0.0.1:'+port,api=(p,o)=>get(base,p,o);
 for(let i=0;i<200;i++){const s=await api('/api/status');if(s.counts)break;await new Promise(r=>setTimeout(r,25));}
 const status=await api('/api/status');assert.equal(status.counts.plugins,12);assert.equal(status.counts.github_only,2);assert.equal(status.counts.plugins_visible,10);assert.equal(status.counts.plugin_nodes_visible,10);assert.equal(status.counts.relevance_suspect,1);
 const tree=await api('/api/tree');assert.ok(tree.nodes.every(n=>n.type!=='plugin'&&Number.isInteger(n.plugin_count)));assert.equal(tree.nodes.find(n=>n.id==='root').plugin_count,10);assert.equal(tree.nodes.find(n=>n.id==='root').plugin_count_all,12);
 assert.equal((await api('/api/tree?include_github_only=1')).nodes.find(n=>n.id==='root').plugin_count,12);
 const page=await api('/api/children?node=retrieval&limit=1');assert.equal(page.total,2);assert.equal(page.offset,0);assert.equal(page.has_more,true);
 const around=await api('/api/children?'+new URLSearchParams({node:'retrieval',limit:1,around:plugins[3].id}));assert.equal(around.offset,1);assert.equal(around.nodes[0].id,plugins[3].id);assert.equal(around.has_more,false);
 assert.equal((await api('/api/children?node=web')).total,0);assert.equal((await api('/api/children?node=web&include_github_only=1')).total,2);
 const graph=await api('/api/graph');assert.equal(graph.nodes.filter(n=>n.type==='plugin').length,10);assert.equal((await api('/api/graph?include_github_only=1')).nodes.filter(n=>n.type==='plugin').length,12);
 for(const p of plugins.slice(0,3)){
  const detail=await api('/api/node/'+encodeURIComponent(p.id));assert.equal(detail.plugin.github_only,p!==plugins[2]);
  for(const type of ['plugin','node']){const q=new URLSearchParams({q:p.name,mode:'fulltext',type});const r=await api('/api/search?'+q);assert.equal(r.results.some(x=>x.id===p.id),p===plugins[2]);assert.ok((await api('/api/search?'+q+'&include_github_only=1')).results.some(x=>x.id===p.id));}
 }
 for(const mode of ['fulltext','semantic','hybrid']){const r=await api('/api/search?'+new URLSearchParams({q:plugins[2].name,mode}));assert.ok(r.results.length);assert.equal(r.semantic.label,status.semantic.label);assert.equal(r.semantic_backend,status.semantic.label);}
 for(const q of ['中文','中','语义检索','a"%_'])assert.ok(Array.isArray((await api('/api/search?'+new URLSearchParams({q,mode:'fulltext'}))).results));
 for(const rel of ['parent','children','duplicate','similar','depends','extends','all'])assert.ok(Array.isArray((await api('/api/search?'+new URLSearchParams({node:plugins[2].id,rel}))).edges));
 const detail=await api('/api/node/'+encodeURIComponent(plugins[2].id));assert.ok(detail.readme_markdown.includes('虚构示例'));assert.ok(detail.capabilities.union.length);assert.equal((await api('/api/node/web')).branch_capabilities,null);assert.equal((await api('/api/node/retrieval')).plugin,null);assert.equal(detail.branch_capabilities.union[0].capability,'branchUnique');
 assert.ok((await api('/api/node/code')).capabilities.merged_from_branches);assert.ok((await api('/api/node/code')).branch_capabilities);assert.equal((await api('/api/node/tasks')).capabilities,null);assert.equal((await api('/api/node/tasks')).branch_capabilities,null);
 for(const type of ['plugin','node','capability']){const r=await api('/api/search?'+new URLSearchParams({q:'示例',mode:'hybrid',type}));assert.ok(r.results.length);assert.ok(r.results.every(x=>x.kind===type));}
 // Make one branch large enough to exercise the actual browser paging control.
 for(let i=0;i<201;i++)original.nodes.push({id:'extra'+i,type:'plugin',parent:'retrieval',label:'extra '+i});
 const targetIndex=original.nodes.findIndex(n=>n.id===plugins[2].id);original.nodes.push(...original.nodes.splice(targetIndex,1));
 await fs.writeFile(path.join(tmp,'graph.json'),JSON.stringify(original));await api('/api/reload',{method:'POST'});
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const pageBrowser=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];pageBrowser.on('pageerror',e=>errors.push(e.message));
 await pageBrowser.goto(base);await pageBrowser.waitForSelector('#graph .node');assert.equal(await pageBrowser.locator('[data-type="plugin"]').count(),0);
 assert.ok((await pageBrowser.locator('#source').textContent()).includes(status.semantic.label));
 const clickNode=async id=>pageBrowser.locator('#graph .node').evaluateAll((els,id)=>els.find(e=>e.dataset.id===id).dispatchEvent(new MouseEvent('click',{bubbles:true})),id);
 await clickNode('retrieval');await pageBrowser.waitForSelector('[data-type="plugin"]');await pageBrowser.waitForSelector('.load-more');await pageBrowser.locator('.load-more').click();await pageBrowser.waitForFunction(()=>!document.querySelector('.load-more'));assert.equal(await pageBrowser.locator('[data-type="plugin"]').count(),203);
 await clickNode(plugins[2].id);await pageBrowser.waitForSelector('.summary-source');assert.ok((await pageBrowser.locator('.summary-source').textContent()).includes('README'));
 await pageBrowser.waitForSelector('.relevance-suspect');assert.equal(await pageBrowser.locator('.relevance-suspect').textContent(),'疑似无关');assert.equal(await pageBrowser.locator('.relevance-suspect').getAttribute('title'),'测试原因');assert.ok((await pageBrowser.locator('.merged-from').textContent()).includes('1'));
 await clickNode(plugins[3].id);await pageBrowser.waitForFunction(()=>!document.querySelector('.summary-source')&&!document.querySelector('.relevance-suspect'));
 await clickNode('retrieval');await pageBrowser.fill('#query',plugins[2].name);await pageBrowser.locator('#search button').click();await pageBrowser.waitForSelector('#results .result');await pageBrowser.locator('#results .result').first().click();await pageBrowser.waitForSelector('[data-type="plugin"].selected');
 await pageBrowser.locator('#github-only').check();await pageBrowser.waitForTimeout(200);await clickNode('web');await pageBrowser.waitForFunction(id=>[...document.querySelectorAll('[data-type="plugin"]')].some(e=>e.dataset.id===id),plugins[0].id);await clickNode(plugins[0].id);await pageBrowser.waitForSelector('.github-badge');assert.deepEqual(errors,[]);
 await browser.close();browser=null;
 plugins[0].summary='temporaryreloadtoken';await writePlugins();const r=await api('/api/reload');assert.ok(r.ok);assert.ok(r.timings.total>=0);assert.ok((await api('/api/search?q=temporaryreloadtoken&mode=fulltext&include_github_only=1')).results.length);
 await fs.writeFile(path.join(tmp,'graph.json'),'broken');assert.equal((await api('/api/reload')).source,'fixtures');await fs.writeFile(path.join(tmp,'graph.json'),JSON.stringify(original));assert.equal((await api('/api/reload')).data_dir,tmp);
 await fs.writeFile(path.join(tmp,'graph.json'),JSON.stringify({nodes:[{id:'r',type:'root'},{id:'c',type:'category',parent:'r'},{id:'custom /编码',type:'plugin',parent:'c',plugin_ids:['npm:@scope/pkg']}]}));await fs.writeFile(path.join(tmp,'plugins.jsonl'),JSON.stringify({id:'npm:@scope/pkg'})+'\n');await api('/api/reload');assert.equal((await api('/api/node/'+encodeURIComponent('custom /编码'))).plugin.id,'npm:@scope/pkg');assert.ok((await api('/api/search?q=scope&mode=fulltext')).results.length);
 console.log('通过：独立 PORT=0 服务 API、过滤、分页、能力兼容、检索、重载与 Chrome 懒加载交互。');
 // Existing service is optional and receives read-only lightweight assertions.
 // 主服务（真实数据）可选轻量只读断言：ATLAS_TEST_URL 指定，或 4380 可达时运行；ATLAS_TEST_URL= 置空则跳过。
 let mainUrl=process.env.ATLAS_TEST_URL;
 if(mainUrl===undefined){try{await fetch('http://127.0.0.1:4380/api/status',{signal:AbortSignal.timeout(1000)});mainUrl='http://127.0.0.1:4380';}catch{}}
 if(mainUrl){
  let s;for(let i=0;i<600;i++){s=await get(mainUrl,'/api/status');if(s.counts)break;await new Promise(r=>setTimeout(r,500));}
  assert.ok(s.counts.plugins>0);assert.ok(Number.isInteger(s.counts.relevance_suspect));assert.equal(s.counts.plugins_visible+s.counts.github_only,s.counts.plugins);
  const t=await get(mainUrl,'/api/tree');assert.ok(t.nodes.length&&t.nodes.every(n=>n.type!=='plugin'&&!('plugin_ids' in n)));
  const root=t.nodes.find(n=>!n.parent);assert.equal(root.plugin_count,s.counts.plugin_nodes_visible);
  const br=t.nodes.filter(n=>n.type==='branch').sort((a,b)=>b.plugin_count_all-a.plugin_count_all)[0];
  if(br){const pg=await get(mainUrl,'/api/children?'+new URLSearchParams({node:br.id,limit:50}));assert.ok(pg.nodes.length<=50);assert.equal(pg.total,br.plugin_count);assert.ok(pg.nodes.every(n=>!n.github_only));
   const all=await get(mainUrl,'/api/children?'+new URLSearchParams({node:br.id,limit:1,include_github_only:'1'}));assert.equal(all.total,br.plugin_count_all);}
  const sr=await get(mainUrl,'/api/search?q=github&mode=hybrid&limit=50');assert.equal(sr.semantic.label,sr.semantic_backend);assert.ok(sr.results.every(x=>!x.github_only));
  const s2=await get(mainUrl,'/api/status');if(s2.semantic.backend===sr.semantic.backend)assert.equal(s2.semantic.backend==='minilm',/MiniLM/.test(sr.semantic.label));
  console.log(`通过：主服务 ${mainUrl} 真实数据轻量断言（可见插件 ${s.counts.plugins_visible}，github_only ${s.counts.github_only}，后端 ${s2.semantic.label}）。`);
 }else console.log('跳过：主服务未运行或 ATLAS_TEST_URL 为空。');
}finally{await browser?.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await fs.rm(tmp,{recursive:true,force:true});}
