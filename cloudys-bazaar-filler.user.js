// ==UserScript==
// @name         Cloudy's Bazaar Filler
// @namespace    https://github.com/gregapackard/torn-bazaar-filler
// @version      0.7.0
// @description  PDA-first Torn bazaar repricer using Weav3r with strict price clamps, safe Item Market fallback, RW/$1 protection, city-sell checks, and Nikeh removal.
// @author       CloudyMuffin440 [4315564]
// @license      MIT
// @match        https://www.torn.com/bazaar.php*
// @match        https://*.torn.com/bazaar.php*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      weav3r.dev
// @updateURL    https://raw.githubusercontent.com/gregapackard/torn-bazaar-filler/main/cloudys-bazaar-filler.user.js
// @downloadURL  https://raw.githubusercontent.com/gregapackard/torn-bazaar-filler/main/cloudys-bazaar-filler.user.js
// ==/UserScript==

(() => {
'use strict';

const SCRIPT='CloudyBazaarFiller';
const API_KEY_STORAGE='cloudys-bazaar-filler-api-key';
const UNDERCUT_STORAGE='cloudys-bazaar-filler-undercut';
const DEFAULT_UNDERCUT=1;
const WEAV3R_STALE_MS=30*60*1000;

// Nikeh Performance direct-buy items (Sports Administration unlock).
const NIKEH_ITEMS=new Map([
  [1484,{name:'Bear Gall',sell:35000}],
  [1494,{name:'Pangolin Scales',sell:205000}],
  [1485,{name:'Shark Fin',sell:66000}],
  [1498,{name:'Tiger Bone Powder',sell:70000}],
  [1493,{name:'Whale Meat',sell:40000}],
  [1268,{name:'Vitamins',sell:50}]
]);

let busy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function fireInput(input){
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'0'}));
}
function setControlledInput(input,value){
  if(!input)return;
  const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
  if(d?.set)d.set.call(input,String(value));else input.value=String(value);
  fireInput(input);
}
function visible(el){
  if(!el)return false;
  const r=el.getBoundingClientRect(),s=getComputedStyle(el);
  return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';
}
function getApiKey(){
  let key=localStorage.getItem(API_KEY_STORAGE)||'';
  if(/^[A-Za-z0-9]{16}$/.test(key))return key;
  key=(prompt("Cloudy's Bazaar Filler\n\nEnter your 16-character Torn PUBLIC/LIMITED API key. It stays in this browser/PDA.")||'').trim();
  if(!/^[A-Za-z0-9]{16}$/.test(key))throw new Error('A valid 16-character Torn API key is required.');
  localStorage.setItem(API_KEY_STORAGE,key);return key;
}
function getUndercut(){
  const n=Number(localStorage.getItem(UNDERCUT_STORAGE));
  return Number.isFinite(n)&&n>=0?Math.floor(n):DEFAULT_UNDERCUT;
}
function requestJson(url){
  return new Promise((resolve,reject)=>GM_xmlhttpRequest({
    method:'GET',url,timeout:15000,
    onload:r=>{try{const d=JSON.parse(r.responseText);d?.error?reject(new Error(d.error.error||`API error ${d.error.code}`)):resolve(d);}catch(e){reject(e)}},
    onerror:()=>reject(new Error('Network error.')),
    ontimeout:()=>reject(new Error('Request timed out.'))
  }));
}
async function loadRunContext(key){
  const [itemsData,userData]=await Promise.all([
    requestJson(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}&comment=CloudysBazaarFiller`),
    requestJson(`https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(key)}&comment=CloudysBazaarFiller`)
  ]);
  return {items:itemsData?.items||{},playerId:Number(userData?.player_id)||null,key};
}
function median(values){
  if(!values.length)return 0;
  const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function getItemInfo(items,id){return items?.[id]||items?.[String(id)]||null;}
function getCitySell(items,id){const n=Number(getItemInfo(items,id)?.sell_price);return Number.isFinite(n)&&n>0?n:0;}
function getMarketValue(items,id){const n=Number(getItemInfo(items,id)?.market_value);return Number.isFinite(n)&&n>1?n:0;}
function clampPrice(value,min,max){
  let n=Number(value);
  if(Number.isFinite(min)&&min>0)n=Math.max(n,min);
  if(Number.isFinite(max)&&max>0)n=Math.min(n,max);
  return Math.max(2,Math.floor(n));
}

// ---------- Pricing ----------
function analyseWeav3r(data,playerId){
  let listings=Array.isArray(data?.listings)?data.listings:[];
  listings=listings.filter(x=>{
    const p=Number(x?.price);
    return Number.isFinite(p)&&p>1&&x?.sponsored!==1;
  });
  if(playerId)listings=listings.filter(x=>Number(x?.player_id)!==playerId);
  const fresh=listings.filter(x=>!x?.last_checked||Date.now()-(Number(x.last_checked)*1000)<=WEAV3R_STALE_MS);
  if(fresh.length)listings=fresh;
  listings.sort((a,b)=>Number(a.price)-Number(b.price));

  const prices=listings.map(x=>Number(x.price));
  const avg=Number(data?.bazaar_average)||0;
  const med=median(prices);

  // Toss obvious lowballs. A listing must be reasonably close to either normal anchor.
  const floor=Math.max(avg?avg*0.70:0,med?med*0.80:0);
  const sane=listings.filter(x=>Number(x.price)>=floor);
  if(!sane.length)return null;

  // Never use the old sparse-market third listing behavior.
  // 1-4 sane listings: lowest sane. 5+: second-lowest sane.
  let base=Number(sane[sane.length>=5?1:0].price);

  // Hard ceiling: no current bazaar target can exceed normal anchors by >10%.
  const ceilings=[];
  if(avg>0)ceilings.push(avg*1.10);
  if(med>0)ceilings.push(med*1.10);
  const ceiling=ceilings.length?Math.min(...ceilings):0;
  if(ceiling>0)base=Math.min(base,ceiling);

  return {base,avg,median:med,floor,ceiling,sane};
}
async function getWeav3rPrice(itemId,ctx){
  const d=await requestJson(`https://weav3r.dev/api/marketplace/${encodeURIComponent(itemId)}`);
  const a=analyseWeav3r(d,ctx.playerId);
  if(!a||!a.base)throw new Error('No sane Weaver bazaar baseline');
  return {
    source:'weav3r',
    targetBase:a.base,
    listPrice:Math.max(2,Math.floor(a.base-getUndercut())),
    average:a.avg,median:a.median,floor:a.floor,ceiling:a.ceiling
  };
}
function analyseItemMarket(listings,marketValue){
  const prices=(Array.isArray(listings)?listings:[])
    .map(x=>Number(x?.price)).filter(p=>Number.isFinite(p)&&p>1).sort((a,b)=>a-b);
  const med=median(prices);
  if(!prices.length)return {base:marketValue||0,median:med,sane:[]};

  const floor=Math.max(marketValue?marketValue*0.85:0,med?med*0.80:0);
  const sane=prices.filter(p=>p>=floor);
  if(!sane.length)return {base:marketValue||0,median:med,sane:[]};

  // Sparse IM data uses the LOWEST sane entry, not the third listing.
  let base=sane[sane.length>=5?1:0];

  // market_value is the long-run anchor. Never let fallback exceed it by >10%.
  const ceiling=marketValue>0?marketValue*1.10:(med>0?med*1.05:0);
  if(ceiling>0)base=Math.min(base,ceiling);
  return {base,median:med,sane,floor,ceiling};
}
async function getItemMarketFallback(itemId,ctx){
  const marketValue=getMarketValue(ctx.items,itemId);
  let listings=[];
  try{
    const d=await requestJson(`https://api.torn.com/v2/market/${encodeURIComponent(itemId)}/itemmarket?key=${encodeURIComponent(ctx.key)}&limit=100&offset=0`);
    const root=d?.itemmarket||d?.itemMarket||d?.item_market||d;
    listings=Array.isArray(root)?root:(root?.listings||root?.items||root?.results||[]);
  }catch(e){console.warn(`[${SCRIPT}] IM request failed ${itemId}`,e);}
  const a=analyseItemMarket(listings,marketValue);
  if(!a.base)throw new Error('No safe market fallback');
  return {
    source:'itemmarket',
    targetBase:a.base,
    listPrice:Math.max(2,Math.floor(a.base-getUndercut())),
    marketValue,median:a.median,floor:a.floor||0,ceiling:a.ceiling||0
  };
}
async function getSafePrice(itemId,ctx){
  try{return await getWeav3rPrice(itemId,ctx);}
  catch(e){
    console.info(`[${SCRIPT}] Weaver unavailable/unsafe for ${itemId}; falling back to Item Market.`,e?.message||e);
    return getItemMarketFallback(itemId,ctx);
  }
}

// ---------- DOM helpers ----------
function itemIdFrom(el){
  const img=el?.querySelector('img[src*="/items/"], img');if(!img)return null;
  const src=img.src||img.getAttribute('src')||'';
  const m=src.match(/\/items\/(\d+)\//i)||src.match(/\/items\/(\d+)\./i)||src.match(/\/(\d+)\.(?:png|jpg|webp)/i)||src.match(/\/(\d+)\//);
  return m?Number(m[1]):null;
}
function itemName(el){
  const txt=(el?.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  return txt.find(x=>!/^x?\d+$/.test(x)&&!/^\$/.test(x))||'item';
}
function isRankedWarRow(row){
  if(!row)return false;
  const bonus=row.querySelector('[class*="bonus-attachment-"], ul.bonuses-wrap li.bonus [class*="bonus-attachment-"]');
  const glow=row.querySelector('.glow-yellow,.glow-orange,.glow-red,[class*="glow-yellow"],[class*="glow-orange"],[class*="glow-red"]');
  const bonusWrap=row.querySelector('ul.bonuses-wrap li.bonus,[class*="bonuses-wrap"] [class*="bonus"]');
  return !!bonus||!!(glow&&bonusWrap);
}
function parseMoneyValue(input){
  const n=Number(String(input?.value??'').replace(/[$,\s]/g,''));
  return Number.isFinite(n)?n:0;
}
async function waitFor(fn,timeout=2200,interval=40){
  const end=Date.now()+timeout;
  while(Date.now()<end){const v=fn();if(v)return v;await sleep(interval);}return null;
}

// ---------- Manage Items / PDA ----------
function getManageRows(){
  const descs=[...document.querySelectorAll(
    'div[data-testid="sortable-item"] div[class*="item___"] div[class*="desc___"], '+
    'div[class*="row___"] div[class*="item___"] div[class*="desc___"]'
  )];
  const out=[],seen=new Set();
  for(const desc of descs){
    const row=desc.closest('div[data-testid="sortable-item"], div[class*="row___"]')||desc.parentElement?.parentElement;
    if(!row||!visible(row))continue;
    const id=itemIdFrom(row);if(!id||seen.has(id))continue;
    seen.add(id);out.push({row,desc,itemId:id,name:itemName(row)});
  }
  return out;
}
function getManageButton(row){
  return row.querySelector('[class*="menuActivators___"] button[class*="iconContainer___"][aria-label="Manage"]')
      ||row.querySelector('button[aria-label="Manage"]')
      ||[...row.querySelectorAll('button')].find(b=>/manage/i.test(b.getAttribute('aria-label')||b.title||''));
}
function isManageButtonActive(button){return !!button?.querySelector('span[class*="active___"]')||button?.getAttribute('aria-expanded')==='true';}
function findMobileMenu(row){
  for(const scope of [row.parentElement,row,document]){
    const menu=scope?.querySelector('[class*="bottomMobileMenu___"]');
    if(menu&&visible(menu))return menu;
  }
  return null;
}
function findMobilePriceInput(row){
  const menu=findMobileMenu(row);if(!menu)return null;
  const box=menu.querySelector('[class*="priceMobile___"]');
  const input=box?.querySelector('div.input-money-group input, input');
  return input&&visible(input)?input:null;
}
function findRemoveInput(row){
  const menu=findMobileMenu(row);
  for(const scope of [menu,row,row.parentElement].filter(Boolean)){
    const input=scope.querySelector('[class*="remove___"] input, [class*="removeMobile___"] input, input[name*="remove" i]');
    if(input)return input;
  }
  return null;
}
function parseListedQty(row,input){
  const max=Number(input?.max);if(Number.isFinite(max)&&max>0)return Math.floor(max);
  const hit=(row?.innerText||'').match(/x\s*([\d,]+)/i)|| (row?.innerText||'').match(/(?:quantity|qty|listed)\D{0,12}([\d,]+)/i);
  return hit?Number(hit[1].replace(/,/g,'')):1;
}
async function openManageRow(entry){
  let input=findMobilePriceInput(entry.row);
  if(input)return {input,button:getManageButton(entry.row),openedByUs:false};
  const button=getManageButton(entry.row);if(!button)throw new Error('Manage button not found');
  const active=isManageButtonActive(button);if(!active)button.click();
  input=await waitFor(()=>findMobilePriceInput(entry.row));
  if(!input)throw new Error('Mobile price panel did not open');
  return {input,button,openedByUs:!active};
}
async function closeManageRow(handle){if(handle?.openedByUs&&handle.button){handle.button.click();await sleep(100);}}
async function markForRemoval(entry){
  const input=await waitFor(()=>findRemoveInput(entry.row),1000,40);
  if(!input)throw new Error('Remove quantity input not found');
  const qty=parseListedQty(entry.row,input);
  setControlledInput(input,qty);
  return qty;
}
async function fillManagePage(ctx){
  const rows=getManageRows();if(!rows.length)return null;
  let repriced=0,removed=0,nikehRemoved=0,failed=0,skipped=0,rwSkipped=0,dollarSkipped=0,itemMarketFallback=0;

  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){rwSkipped++;continue;}
    setButtonState(`OPENING ${i+1}/${rows.length}…`,true);
    let handle=null;
    try{
      handle=await openManageRow(rows[i]);
      const currentPrice=parseMoneyValue(handle.input);
      if(currentPrice===1){dollarSkipped++;continue;}

      // User has Nikeh Performance unlocked: always pull these back to inventory.
      if(NIKEH_ITEMS.has(rows[i].itemId)){
        await markForRemoval(rows[i]);
        nikehRemoved++;removed++;
        console.info(`[${SCRIPT}] NIKEH REMOVE ${rows[i].name}`);
        continue;
      }

      setButtonState(`CHECKING ${i+1}/${rows.length}…`,true);
      const safe=await getSafePrice(rows[i].itemId,ctx);
      if(safe.source==='itemmarket')itemMarketFallback++;
      const city=getCitySell(ctx.items,rows[i].itemId);

      if(city>safe.listPrice){
        await markForRemoval(rows[i]);removed++;
        console.info(`[${SCRIPT}] REMOVE ${rows[i].name}: city ${city} > ${safe.source} ${safe.listPrice}`);
      }else{
        setControlledInput(handle.input,safe.listPrice);repriced++;
        console.info(`[${SCRIPT}] PRICE ${rows[i].name}: ${safe.listPrice} via ${safe.source}; base ${Math.round(safe.targetBase)} ceiling ${Math.round(safe.ceiling||0)}`);
      }
    }catch(e){
      if(/No safe market fallback/.test(String(e?.message||'')))skipped++;else failed++;
      console.warn(`[${SCRIPT}] ${rows[i].name} (${rows[i].itemId})`,e);
    }finally{await closeManageRow(handle);}
    await sleep(100);
  }
  return {mode:'manage',repriced,removed,nikehRemoved,failed,skipped,rwSkipped,dollarSkipped,itemMarketFallback,total:rows.length};
}

// ---------- Add Items ----------
function getAddRows(){
  return [...document.querySelectorAll('ul.items-cont li.clearfix, div[class*="itemsContainner___"] div[class*="item___"], div[class*="rowItems___"] div[class*="item___"]')]
    .filter(r=>visible(r)&&r.querySelector('div.amount-main-wrap, div[class*="amount___"]')&&itemIdFrom(r));
}
function addControls(row){
  const amount=row.querySelector('div.amount-main-wrap, div[class*="amount___"]');
  const price=row.querySelector('div.price, div[class*="price___"]');
  if(!amount||!price)return null;
  const checkbox=amount.querySelector('input[type="checkbox"]');
  const qty=checkbox?null:amount.querySelector('input');
  const priceInputs=[...price.querySelectorAll('input')];
  const id=itemIdFrom(row);
  return id&&(checkbox||qty)&&priceInputs.length?{row,amount,checkbox,qty,priceInputs,itemId:id}:null;
}
function maxQty(c){
  if(c.checkbox)return 1;
  const m=Number(c.qty?.max);if(Number.isFinite(m)&&m>0)return Math.floor(m);
  const text=c.row.innerText||'';
  const hit=text.match(/x\s*([\d,]+)/i)||text.match(/(?:owned|available|max)\D{0,12}([\d,]+)/i);
  return hit?Number(hit[1].replace(/,/g,'')):null;
}
async function fillAddPage(ctx){
  const rows=getAddRows().map(addControls).filter(Boolean);if(!rows.length)return null;
  let filled=0,cityBetter=0,nikehSkipped=0,skipped=0,failed=0,rwSkipped=0,dollarSkipped=0,itemMarketFallback=0;
  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){rwSkipped++;continue;}
    if(rows[i].priceInputs.some(x=>parseMoneyValue(x)===1)){dollarSkipped++;continue;}
    if(NIKEH_ITEMS.has(rows[i].itemId)){nikehSkipped++;continue;}
    setButtonState(`FILLING ${i+1}/${rows.length}…`,true);
    try{
      const q=maxQty(rows[i]);if(!q){skipped++;continue;}
      const safe=await getSafePrice(rows[i].itemId,ctx);
      if(safe.source==='itemmarket')itemMarketFallback++;
      const city=getCitySell(ctx.items,rows[i].itemId);
      if(city>safe.listPrice){cityBetter++;continue;}
      if(rows[i].checkbox&&!rows[i].checkbox.checked)rows[i].checkbox.click();else if(rows[i].qty)setControlledInput(rows[i].qty,q);
      rows[i].priceInputs.forEach(x=>setControlledInput(x,safe.listPrice));filled++;
    }catch(e){
      if(/No safe market fallback/.test(String(e?.message||'')))skipped++;else failed++;
      console.warn(`[${SCRIPT}] add ${rows[i].itemId}`,e);
    }
    await sleep(100);
  }
  return {mode:'add',filled,cityBetter,nikehSkipped,skipped,failed,rwSkipped,dollarSkipped,itemMarketFallback,total:rows.length};
}

function setButtonState(text,disabled=false){
  const b=document.getElementById('cbf-fill-page');if(!b)return;
  b.textContent=text;b.disabled=disabled;b.style.opacity=disabled?'.7':'1';
}
function toast(msg,type='ok'){
  let b=document.getElementById('cbf-toast');
  if(!b){
    b=document.createElement('div');b.id='cbf-toast';
    Object.assign(b.style,{position:'fixed',left:'12px',right:'12px',bottom:'76px',zIndex:'2147483647',padding:'11px 14px',borderRadius:'10px',fontSize:'13px',fontWeight:'700',textAlign:'center',color:'#fff',boxShadow:'0 4px 14px rgba(0,0,0,.35)',pointerEvents:'none'});
    document.body.appendChild(b);
  }
  b.style.background=type==='error'?'#a82c2c':type==='warn'?'#8a6515':'#287842';
  b.textContent=msg;b.style.opacity='1';clearTimeout(b._t);b._t=setTimeout(()=>b.style.opacity='0',8000);
}
async function fillPage(){
  if(busy)return;busy=true;setButtonState('LOADING PRICES…',true);
  try{
    const ctx=await loadRunContext(getApiKey());
    let result=await fillManagePage(ctx);
    if(!result)result=await fillAddPage(ctx);
    if(!result){toast('No editable Bazaar rows found on this screen.','warn');return;}

    if(result.mode==='manage'){
      const bits=[`${result.repriced} repriced`,`${result.removed} marked for removal`];
      if(result.nikehRemoved)bits.push(`${result.nikehRemoved} Nikeh`);
      if(result.itemMarketFallback)bits.push(`${result.itemMarketFallback} IM fallback`);
      if(result.rwSkipped)bits.push(`${result.rwSkipped} RW skipped`);
      if(result.dollarSkipped)bits.push(`${result.dollarSkipped} $1 skipped`);
      if(result.skipped)bits.push(`${result.skipped} no safe price`);
      if(result.failed)bits.push(`${result.failed} failed`);
      toast(`${bits.join(' • ')}. Review, then tap SAVE CHANGES.`,result.failed?'warn':'ok');
    }else{
      const bits=[`${result.filled} filled`];
      if(result.nikehSkipped)bits.push(`${result.nikehSkipped} Nikeh skipped`);
      if(result.cityBetter)bits.push(`${result.cityBetter} better sold to city`);
      if(result.itemMarketFallback)bits.push(`${result.itemMarketFallback} IM fallback`);
      if(result.rwSkipped)bits.push(`${result.rwSkipped} RW skipped`);
      if(result.dollarSkipped)bits.push(`${result.dollarSkipped} $1 skipped`);
      if(result.skipped)bits.push(`${result.skipped} no safe price`);
      if(result.failed)bits.push(`${result.failed} failed`);
      toast(bits.join(' • '),result.failed?'warn':'ok');
    }
  }catch(e){console.error(`[${SCRIPT}]`,e);toast(e.message||'Fill failed.','error');}
  finally{busy=false;setButtonState('FILL THIS PAGE');}
}
function injectUI(){
  if(document.getElementById('cbf-fill-page'))return;
  const w=document.createElement('div');w.id='cbf-wrap';
  Object.assign(w.style,{position:'fixed',left:'10px',right:'10px',bottom:'12px',zIndex:'2147483646',display:'flex',gap:'8px',alignItems:'stretch',maxWidth:'680px',margin:'0 auto'});
  const b=document.createElement('button');b.id='cbf-fill-page';b.type='button';b.textContent='FILL THIS PAGE';
  Object.assign(b.style,{flex:'1 1 auto',minHeight:'52px',border:'0',borderRadius:'12px',background:'linear-gradient(180deg,#2f9b56,#247642)',color:'#fff',fontSize:'16px',fontWeight:'900',letterSpacing:'.3px',boxShadow:'0 4px 16px rgba(0,0,0,.4)',touchAction:'manipulation'});
  b.addEventListener('click',fillPage);
  const g=document.createElement('button');g.type='button';g.textContent='⚙';
  Object.assign(g.style,{width:'52px',minHeight:'52px',border:'0',borderRadius:'12px',background:'#333',color:'#fff',fontSize:'22px',fontWeight:'700',boxShadow:'0 4px 16px rgba(0,0,0,.4)',touchAction:'manipulation'});
  g.addEventListener('click',()=>{
    const v=prompt('Undercut the safe bazaar/market target by how many dollars?',String(getUndercut()));if(v===null)return;
    const n=Number(v.replace(/,/g,'').trim());if(!Number.isFinite(n)||n<0)return toast('Enter a valid non-negative dollar amount.','error');
    localStorage.setItem(UNDERCUT_STORAGE,String(Math.floor(n)));toast(`Undercut set to $${Math.floor(n).toLocaleString()}.`);
  });
  w.append(b,g);document.body.appendChild(w);
}
function boot(){
  injectUI();new MutationObserver(injectUI).observe(document.documentElement,{childList:true,subtree:true});
  console.log(`[${SCRIPT}] Loaded v0.7.0`);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
