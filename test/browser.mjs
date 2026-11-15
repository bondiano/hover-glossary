// Проверка в реальном браузере на установленном Harness. Без запросов к модели
// и без записи в сессию.
// DSH_TEST_URL или DSH_TEST_LOG: аутентифицированный URL либо лог запуска
// (URL никогда не печатается).
// DSH_TEST_SESSION: заголовок существующей сессии с сообщением, где есть WHO.
// PLAYWRIGHT_MODULE: необязательный абсолютный путь к локально установленному
// playwright.
// DSH_SCREENSHOT: необязательный путь, куда сохранить снимок подсказки.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const url = process.env.DSH_TEST_URL || readFileSync(process.env.DSH_TEST_LOG, 'utf8').match(/http:\/\/[^\s\x1b]+/)[0];
const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
page.setDefaultTimeout(12000);
const errors=[];
page.on('pageerror', e=>errors.push(e.message));
const results=[];
async function check(name, run) { await run(); results.push(name); console.log('PASS '+name); }
async function hoverWord(selector, word) {
  const point=await page.locator(selector).last().evaluate((root, word)=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    for(let node; (node=walker.nextNode());) {
      const i=node.data.indexOf(word);
      if(i<0 || node.parentElement.closest('a,button,textarea,input,summary')) continue;
      node.parentElement.scrollIntoView({block:'center'});
      const range=document.createRange(); range.setStart(node,i); range.setEnd(node,i+1);
      const r=range.getBoundingClientRect();
      if(r.width && r.height) return {x:r.left+r.width/2,y:r.top+r.height/2};
    }
    throw Error('Не найдено видимое слово: '+word);
  },word);
  await page.waitForTimeout(70);
  await page.mouse.move(point.x,point.y);
  await page.waitForTimeout(100);
}
try {
  await page.goto(url);
  await page.waitForFunction(()=>!!globalThis.__hoverGlossaryDiag__);
  await check('Harness загружается с установленным плагином',async()=>{
    assert.equal(await page.getByText('Failed to load plugins',{exact:true}).count(),0);
    assert.equal(await page.locator('.hg-diag').count(),0);
    assert.equal(await page.locator('style[data-hover-glossary]').count(),1);
  });
  await page.getByText(process.env.DSH_TEST_SESSION || 'hover-glossary',{exact:true}).click();
  await page.locator('[data-chat-flow-kind="assistant-step"]').last().waitFor();
  await check('WHO в существующем сообщении ассистента показывает оба значения',async()=>{
    await hoverWord('[data-chat-flow-kind="assistant-step"]','WHO');
    const tip=await page.locator('.hg-tip').innerText();
    assert.match(tip,/ВОЗ/); assert.match(tip,/кто/);
    const b=await page.locator('.hg-tip').boundingBox();
    assert.ok(b.x>=0 && b.y>=0 && b.x+b.width<=1280 && b.y+b.height<=900);
    if(process.env.DSH_SCREENSHOT) await page.screenshot({path:process.env.DSH_SCREENSHOT});
  });
  // Временные DOM-примеры проверяют геометрию каретки Chromium на настоящем
  // плагине. Они не отправляются в модель и не сохраняются в переписке.
  await page.evaluate(()=>{
    const f=document.createElement('div');f.id='hg-browser-fixture';
    f.style.cssText='position:fixed;left:330px;top:100px;width:650px;padding:12px;z-index:2147482000;background:white;color:black;font:18px/2 sans-serif';
    for(const kind of ['user','assistant-step','sidebar']) {
      const p=document.createElement('p');p.id='hg-test-'+kind;
      if(kind!=='sidebar') p.dataset.chatFlowKind=kind;
      p.textContent='WHO API DSH Cordis LLM токенизатор United Nations скрытое состояние WHOLE RAPID псевдотокен';
      f.append(p);
    }
    document.body.append(f);
  });
  for(const kind of ['user','assistant-step']) {
    for(const [word,meaning] of [['WHO','ВОЗ'],['API','интерфейс'],['DSH','DeepSeek Harness'],['Cordis','среда выполнения'],['LLM','языковая модель'],['токенизатор','tokenizer'],['United','Организация Объединённых Наций'],['скрытое','hidden state']]) {
      await check(kind+' / '+word,async()=>{
        await hoverWord('#hg-test-'+kind,word);
        assert.ok((await page.locator('.hg-tip').innerText()).includes(meaning));
      });
    }
  }
  for(const [selector,word] of [['#hg-test-sidebar','WHO'],['#hg-test-user','WHOLE'],['#hg-test-user','RAPID'],['#hg-test-user','псевдотокен']]) {
    await check('Ложное срабатывание исключено: '+selector+' / '+word,async()=>{
      await hoverWord(selector,word); assert.equal(await page.locator('.hg-tip').count(),0);
    });
  }
  await check('Прокрутка скрывает подсказку',async()=>{
    await hoverWord('#hg-test-user','WHO');
    await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.hg-tip').count(),0);
  });
  await page.evaluate(()=>document.getElementById('hg-browser-fixture').remove());
  await check('Перезагрузка страницы активирует ровно один оверлей',async()=>{
    await page.reload(); await page.waitForFunction(()=>!!globalThis.__hoverGlossaryDiag__);
    assert.equal(await page.locator('style[data-hover-glossary]').count(),1);
    assert.equal(await page.getByText('Failed to load plugins',{exact:true}).count(),0);
  });
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:results.length,pageErrors:errors}));
} finally { await browser.close(); }
