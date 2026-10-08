// ==UserScript==
// @name         Cloudy's Bazaar Filler
// @namespace    https://github.com/gregapackard/torn-bazaar-filler
// @version      0.9.3
// @description  PDA-first Torn bazaar repricer using Weav3r bazaar data with throttled retries, safe fallback pricing, RW/$1 protection, city checks, and Nikeh removal.
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
const NIKEH_ITEMS=new Set([1484,1494,1485,1498,1493,1268]);
const WEAVER_MIN_GAP_MS=350;
const WEAVER_RETRY_DELAYS=[0,750,1500,3000];
let busy=false;
let lastWeaverRequestAt=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function fireInput(input){
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'0'}));
}
function setControlledInput(input,value){
  if(!input)return;
  const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
  if(d?.set)d.set.call(input,String(value)); else input.value=String(value);
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
  localStorage.setItem(API_KEY_STORAGE,key);
  return key;
}
function getUndercut(){
  const n=Number(localStorage.getItem(UNDERCUT_STORAGE));
  return Number.isFinite(n)&&n>=0?Math.floor(n):DEFAULT_UNDERCUT;
}
function apiError(message,status=0,code='REQUEST_FAILED'){
  const e=new Error(message);e.status=status;e.code=code;return e;
}
function requestJson(url,timeout=15000){
  return new Promise((resolve,reject)=>GM_xmlhttpRequest({
    method:'GET',url,timeout,
    onload:r=>{
      try{
        if(r.status<200||r.status>=300)throw apiError(`HTTP ${r.status}`,r.status);
        const d=JSON.parse(r.responseText);
        if(d?.error)reject(apiError(d.error.error||`API error ${d.error.code}`,r.status,'API_ERROR'));
        else resolve(d);
      }catch(e){reject(e);}
    },
    onerror:()=>reject(apiError('Network error.',0,'NETWORK')),
    ontimeout:()=>reject(apiError('Request timed out.',0,'TIMEOUT'))
  }));
}
async function loadRunContext(key){
  const [itemsData,userData]=await Promise.all([
    requestJson(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}&comment=CloudysBazaarFiller`),
    requestJson(`https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(key)}&comment=CloudysBazaarFiller`)
  ]);
  return {items:itemsData?.items||{},playerId:Number(userData?.player_id)||null,key};
}
function getItemInfo(items,id){return items?.[id]||items?.[String(id)]||null;}
function getCitySell(items,id){
  const n=Number(getItemInfo(items,id)?.sell_price);
  return Number.isFinite(n)&&n>0?n:0;
}
function getTornMarketValue(items,id){
  const n=Number(getItemInfo(items,id)?.market_value);
  return Number.isFinite(n)&&n>1?n:0;
}

function shouldRetryWeaver(e){
  return e?.status===429||e?.status===408||e?.status>=500||e?.code==='NETWORK'||e?.code==='TIMEOUT';
}
async function throttleWeaver(){
  const wait=Math.max(0,WEAVER_MIN_GAP_MS-(Date.now()-lastWeaverRequestAt));
  if(wait)await sleep(wait);
  lastWeaverRequestAt=Date.now();
}
async function requestWeaverJson(url){
  let lastErr=null;
  for(let i=0;i<WEAVER_RETRY_DELAYS.length;i++){
    if(WEAVER_RETRY_DELAYS[i])await sleep(WEAVER_RETRY_DELAYS[i]);
    await throttleWeaver();
    try{return await requestJson(url,15000);}
    catch(e){
      lastErr=e;
      if(!shouldRetryWeaver(e))throw e;
      console.warn(`[${SCRIPT}] Weaver retry ${i+1}/${WEAVER_RETRY_DELAYS.length}:`,e.message);
    }
  }
  const e=apiError(lastErr?.message||'Weaver temporarily unavailable',lastErr?.status||0,'WEAVER_UNAVAILABLE');
  throw e;
}

// Use the real lowest competitor unless it looks like an extreme transfer/joke listing.
function pickLowestRealPrice(prices,marketPrice=0,bazaarAverage=0){
  const p=prices.filter(x=>Number.isFinite(x)&&x>1).sort((a,b)=>a-b);
  if(!p.length)return null;
  let index=0;
  if(p.length>=3){
    const [p0,p1,p2]=p;
    const anchors=[marketPrice,bazaarAverage].filter(x=>Number.isFinite(x)&&x>1);
    const anchor=anchors.length?anchors.reduce((a,b)=>a+b,0)/anchors.length:0;
    const nextTwoCluster=p1<=p2*1.08;
    const extremeGap=p0<p1*0.55;
    const extremeVsAnchor=anchor>0&&p0<anchor*0.55&&p1>=anchor*0.70;
    if(nextTwoCluster&&extremeGap&&extremeVsAnchor)index=1;
  }
  return {base:p[index],index,prices:p};
}

async function getWeaverPrice(itemId,ctx){
  let d;
  try{
    d=await requestWeaverJson(`https://weav3r.dev/api/marketplace/${encodeURIComponent(itemId)}?limit=100`);
  }catch(e){
    if(e?.code==='WEAVER_UNAVAILABLE')throw e;
    const out=apiError(e?.message||'Weaver request failed',e?.status||0,'WEAVER_UNAVAILABLE');
    throw out;
  }
  const marketPrice=Number(d?.market_price)||0;
  const bazaarAverage=Number(d?.bazaar_average)||0;
  let listings=Array.isArray(d?.listings)?d.listings:[];
  listings=listings.filter(x=>{
    const price=Number(x?.price);
    return Number.isFinite(price)&&price>1;
  });
  if(ctx.playerId)listings=listings.filter(x=>Number(x?.player_id)!==ctx.playerId);

  const picked=pickLowestRealPrice(listings.map(x=>Number(x.price)),marketPrice,bazaarAverage);
  if(!picked){
    const e=apiError('Weaver returned no usable bazaar listings',200,'NO_WEAVER_DATA');
    throw e;
  }
  const listPrice=Math.max(2,Math.floor(picked.base-getUndercut()));
  return {
    source:'weaver',targetBase:picked.base,listPrice,marketPrice,bazaarAverage,
    skippedLowball:picked.index>0,
    bazaarPremium:marketPrice>1&&listPrice>marketPrice
  };
}

function parseItemMarketListings(data){
  const root=data?.itemmarket||data?.itemMarket||data?.item_market||data;
  const rows=Array.isArray(root)?root:(root?.listings||root?.items||root?.results||[]);
  return (Array.isArray(rows)?rows:[]).map(x=>Number(x?.price)).filter(p=>Number.isFinite(p)&&p>1);
}
async function getFallbackPrice(itemId,ctx){
  const marketValue=getTornMarketValue(ctx.items,itemId);
  let prices=[];
  try{
    const d=await requestJson(`https://api.torn.com/v2/market/${encodeURIComponent(itemId)}/itemmarket?key=${encodeURIComponent(ctx.key)}&limit=100&offset=0`);
    prices=parseItemMarketListings(d);
  }catch(e){console.warn(`[${SCRIPT}] Item Market fallback failed for ${itemId}`,e);}

  const picked=pickLowestRealPrice(prices,marketValue,marketValue);
  let base=picked?.base||0;
  let source='itemmarket';
  if(!base&&marketValue>1){base=marketValue;source='marketvalue';}
  if(!base)throw apiError('No safe fallback price',0,'NO_FALLBACK');

  let listPrice=Math.max(2,Math.floor(base-getUndercut()));
  let fallbackCapped=false;
  if(marketValue>1){
    const cap=Math.max(2,Math.floor(marketValue-getUndercut()));
    if(listPrice>cap){listPrice=cap;fallbackCapped=true;}
  }
  return {source,targetBase:base,listPrice,marketValue,fallbackCapped,skippedLowball:!!picked&&picked.index>0};
}
async function getSafePrice(itemId,ctx){
  try{return await getWeaverPrice(itemId,ctx);}
  catch(e){
    // Only fall back when Weaver answered successfully but genuinely has no usable bazaar data.
    if(e?.code==='NO_WEAVER_DATA'){
      console.info(`[${SCRIPT}] No Weaver bazaar data for ${itemId}; using safe fallback.`);
      return getFallbackPrice(itemId,ctx);
    }
    throw e;
  }
}

function itemIdFrom(el){
  const img=el?.querySelector('img[src*="/items/"], img');
  if(!img)return null;
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
  while(Date.now()<end){const v=fn();if(v)return v;await sleep(interval);}
  return null;
}

function getManageRows(){
  const descs=[...document.querySelectorAll('div[data-testid="sortable-item"] div[class*="item___"] div[class*="desc___"], div[class*="row___"] div[class*="item___"] div[class*="desc___"]')];
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
  const text=row?.innerText||'';
  const hit=text.match(/x\s*([\d,]+)/i)||text.match(/(?:quantity|qty|listed)\D{0,12}([\d,]+)/i);
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
  const qty=parseListedQty(entry.row,input);setControlledInput(input,qty);return qty;
}

async function fillManagePage(ctx){
  const rows=getManageRows();if(!rows.length)return null;
  let repriced=0,removed=0,nikehRemoved=0,skipped=0,weaverUnavailable=0,rwSkipped=0,dollarSkipped=0;
  let fallback=0,fallbackCapped=0,bazaarPremium=0,lowballsSkipped=0;
  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){rwSkipped++;continue;}
    setButtonState(`OPENING ${i+1}/${rows.length}…`,true);
    let handle=null;
    try{
      handle=await openManageRow(rows[i]);
      if(parseMoneyValue(handle.input)===1){dollarSkipped++;continue;}
      if(NIKEH_ITEMS.has(rows[i].itemId)){await markForRemoval(rows[i]);nikehRemoved++;removed++;continue;}
      setButtonState(`PRICING ${i+1}/${rows.length}…`,true);
      const safe=await getSafePrice(rows[i].itemId,ctx);
      if(safe.source!=='weaver')fallback++;
      if(safe.fallbackCapped)fallbackCapped++;
      if(safe.bazaarPremium)bazaarPremium++;
      if(safe.skippedLowball)lowballsSkipped++;
      const city=getCitySell(ctx.items,rows[i].itemId);
      if(city>safe.listPrice){await markForRemoval(rows[i]);removed++;}
      else{setControlledInput(handle.input,safe.listPrice);repriced++;}
      console.info(`[${SCRIPT}] ${rows[i].name}: ${safe.source} $${safe.listPrice} base $${safe.targetBase}${safe.marketPrice?` Weaver market $${safe.marketPrice}`:''}`);
    }catch(e){
      if(e?.code==='WEAVER_UNAVAILABLE')weaverUnavailable++;else skipped++;
      console.warn(`[${SCRIPT}] ${rows[i].name} (${rows[i].itemId})`,e);
    }finally{await closeManageRow(handle);}
    await sleep(100);
  }
  return {mode:'manage',repriced,removed,nikehRemoved,skipped,weaverUnavailable,rwSkipped,dollarSkipped,fallback,fallbackCapped,bazaarPremium,lowballsSkipped,total:rows.length};
}

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
  return id&&(checkbox||qty)&&priceInputs.length?{row,checkbox,qty,priceInputs,itemId:id}:null;
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
  let filled=0,cityBetter=0,nikehSkipped=0,skipped=0,weaverUnavailable=0,rwSkipped=0,dollarSkipped=0;
  let fallback=0,fallbackCapped=0,bazaarPremium=0,lowballsSkipped=0;
  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){rwSkipped++;continue;}
    if(rows[i].priceInputs.some(x=>parseMoneyValue(x)===1)){dollarSkipped++;continue;}
    if(NIKEH_ITEMS.has(rows[i].itemId)){nikehSkipped++;continue;}
    setButtonState(`FILLING ${i+1}/${rows.length}…`,true);
    try{
      const q=maxQty(rows[i]);if(!q){skipped++;continue;}
      const safe=await getSafePrice(rows[i].itemId,ctx);
      if(safe.source!=='weaver')fallback++;
      if(safe.fallbackCapped)fallbackCapped++;
      if(safe.bazaarPremium)bazaarPremium++;
      if(safe.skippedLowball)lowballsSkipped++;
      const city=getCitySell(ctx.items,rows[i].itemId);
      if(city>safe.listPrice){cityBetter++;continue;}
      if(rows[i].checkbox&&!rows[i].checkbox.checked)rows[i].checkbox.click();
      else if(rows[i].qty)setControlledInput(rows[i].qty,q);
      rows[i].priceInputs.forEach(x=>setControlledInput(x,safe.listPrice));filled++;
    }catch(e){
      if(e?.code==='WEAVER_UNAVAILABLE')weaverUnavailable++;else skipped++;
      console.warn(`[${SCRIPT}] add ${rows[i].itemId}`,e);
    }
    await sleep(100);
  }
  return {mode:'add',filled,cityBetter,nikehSkipped,skipped,weaverUnavailable,rwSkipped,dollarSkipped,fallback,fallbackCapped,bazaarPremium,lowballsSkipped,total:rows.length};
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
  b.textContent=msg;b.style.opacity='1';clearTimeout(b._t);b._t=setTimeout(()=>b.style.opacity='0',10000);
}
async function fillPage(){
  if(busy)return;busy=true;setButtonState('LOADING PRICES…',true);
  try{
    const ctx=await loadRunContext(getApiKey());
    let result=await fillManagePage(ctx);if(!result)result=await fillAddPage(ctx);
    if(!result){toast('No editable Bazaar rows found on this screen.','warn');return;}
    const bits=[];
    if(result.mode==='manage')bits.push(`${result.repriced} repriced`,`${result.removed} removal`);
    else bits.push(`${result.filled} filled`);
    if(result.nikehRemoved)bits.push(`${result.nikehRemoved} Nikeh`);
    if(result.nikehSkipped)bits.push(`${result.nikehSkipped} Nikeh skipped`);
    if(result.cityBetter)bits.push(`${result.cityBetter} city better`);
    if(result.bazaarPremium)bits.push(`${result.bazaarPremium} bazaar premium`);
    if(result.fallback)bits.push(`${result.fallback} genuine fallback`);
    if(result.fallbackCapped)bits.push(`${result.fallbackCapped} fallback capped`);
    if(result.lowballsSkipped)bits.push(`${result.lowballsSkipped} extreme lowball ignored`);
    if(result.weaverUnavailable)bits.push(`${result.weaverUnavailable} Weaver unavailable — untouched`);
    if(result.rwSkipped)bits.push(`${result.rwSkipped} RW skipped`);
    if(result.dollarSkipped)bits.push(`${result.dollarSkipped} $1 skipped`);
    if(result.skipped)bits.push(`${result.skipped} untouched`);
    const suffix=result.mode==='manage'?'. Review, then tap SAVE CHANGES.':'';
    toast(bits.join(' • ')+suffix,(result.weaverUnavailable||result.skipped)?'warn':'ok');
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
    const v=prompt('Undercut the chosen competing price by how many dollars?',String(getUndercut()));if(v===null)return;
    const n=Number(v.replace(/,/g,'').trim());if(!Number.isFinite(n)||n<0)return toast('Enter a valid non-negative dollar amount.','error');
    localStorage.setItem(UNDERCUT_STORAGE,String(Math.floor(n)));toast(`Undercut set to $${Math.floor(n).toLocaleString()}.`);
  });
  w.append(b,g);document.body.appendChild(w);
}
function boot(){
  injectUI();new MutationObserver(injectUI).observe(document.documentElement,{childList:true,subtree:true});
  console.log(`[${SCRIPT}] Loaded v0.9.3`);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();