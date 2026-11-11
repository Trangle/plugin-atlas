import {chromium} from 'playwright-core';
import path from 'node:path';
const args=process.argv.slice(2);
const option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const out=path.resolve(option('--out')||new URL('./screenshot.png',import.meta.url).pathname);
const base=process.env.ATLAS_TEST_URL||'http://127.0.0.1:4380';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForSelector('#graph .node');
  let expand=option('--expand');
  if(expand==='auto'){
    const {nodes}=await (await page.request.get(base+'/api/tree')).json();
    expand=nodes.filter(n=>n.type==='branch').sort((a,b)=>b.plugin_count-a.plugin_count)[0]?.id;
  }
  if(expand){
    const response=page.waitForResponse(r=>r.url().includes('/api/node/'));
    await page.locator('#graph .node').evaluateAll((els,id)=>{const el=els.find(e=>e.dataset.id===id);if(!el)throw Error('未知分支 '+id);el.dispatchEvent(new MouseEvent('click',{bubbles:true}));},expand);
    await response;
    await page.waitForTimeout(200);
    await page.locator('#graph .node').evaluateAll((els,id)=>els.find(e=>e.dataset.id===id)?.scrollIntoView({block:'center'}),expand);
  }
  await page.screenshot({path:out,fullPage:false});
  console.log('截图已保存 '+out);
}finally{await browser.close();}
