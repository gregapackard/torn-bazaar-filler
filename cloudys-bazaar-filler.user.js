// ==UserScript==
// @name         Cloudy's Bazaar Filler
// @namespace    https://github.com/gregapackard/torn-bazaar-filler
// @version      0.5.0
// @description  PDA-first Torn bazaar repricer using Weav3r bazaars with lowball protection, $1 protection, RW skipping, and city-sell removal checks.
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
const AVG_FLOOR_RATIO=0.60;
const MEDIAN_FLOOR_RATIO=0.70;
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
  return {items:itemsData?.items||{},playerId:Number(userData?.player_id)||null};
}
function median(values){
  if(!values.length)return 0;
  const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function analyseWeav3rListings(data,playerId){
  const all=Array.isArray(data?.listings)?data.listings:[];
  let usable=all.filter(x=>{
    const p=Number(x?.price);
    return Number.isFinite(p)&&p>1&&x?.sponsored!==1;
  });
  if(playerId)usable=usable.filter(x=>Number(x?.player_id)!==playerId);

  const fresh=usable.filter(x=>!x?.last_checked||Date.now()-(Number(x.last_checked)*1000)<=WEAV3R_STALE_MS);
  if(fresh.length)usable=fresh;
  usable.sort((a,b)=>Number(a.price)-Number(b.price));

  const prices=usable.map(x=>Number(x.price));
  const avg=Number(data?.bazaar_average)||0;
  const med=median(prices);
  const floor=Math.max(avg>0?avg*AVG_FLOOR_RATIO:0,med>0?med*MEDIAN_FLOOR_RATIO:0);
  const sane=usable.filter(x=>Number(x.price)>=floor);
  if(!sane.length)return {all:usable,sane:[],avg,median:med,floor,targetBase:0};

  // Use the third-cheapest sane competitor when available. This prevents one or two
  // temporary lowballs from dragging the entire bazaar down while still following a real cluster.
  const targetIndex=sane.length>=3?2:0;
  return {all:usable,sane,avg,median:med,floor,targetBase:Number(sane[targetIndex].price)};
}
async function getBazaarPrice(itemId,playerId){
  const d=await requestJson(`https://weav3r.dev/api/marketplace/${encodeURIComponent(itemId)}`);
  const a=analyseWeav3rListings(d,playerId);
  if(!a.sane.length||!a.targetBase)throw new Error(`No sane competitor bazaar listings for item ${itemId}.`);
  return {
    listPrice:Math.max(2,a.targetBase-getUndercut()),
    targetBase:a.targetBase,
    average:a.avg,
    median:a.median,
    floor:a.floor,
    listings:a.sane
  };
}
function getCitySell(items,itemId){
  const item=items?.[itemId]||items?.[String(itemId)]||null;
  const n=Number(item?.sell_price);
  return Number.isFinite(n)&&n>0?n:0;
}
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
  const raw=String(input?.value??'').replace(/[$,\s]/g,'');
  const n=Number(raw);
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
  const parent=row.parentElement;
  for(const scope of [parent,row,document]){
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
  const scopes=[menu,row,row.parentElement].filter(Boolean);
  for(const scope of scopes){
    const input=scope.querySelector('[class*="remove___"] input, [class*="removeMobile___"] input, input[name*="remove" i]');
    if(input)return input;
  }
  return null;
}
function parseListedQty(row,removeInput){
  const max=Number(removeInput?.max);if(Number.isFinite(max)&&max>0)return Math.floor(max);
  const text=row?.innerText||'';
  const hit=text.match(/x\s*([\d,]+)/i)||text.match(/(?:quantity|qty|listed)\D{0,12}([\d,]+)/i);
  return hit?Number(hit[1].replace(/,/g,'')):1;
}
async function openManageRow(entry){
  let input=findMobilePriceInput(entry.row);
  if(input)return {input,button:getManageButton(entry.row),openedByUs:false};
  const button=getManageButton(entry.row);if(!button)throw new Error('Manage button not found');
  const wasActive=isManageButtonActive(button);if(!wasActive)button.click();
  input=await waitFor(()=>findMobilePriceInput(entry.row));
  if(!input)throw new Error('Mobile price panel did not open');
  return {input,button,openedByUs:!wasActive};
}
async function closeManageRow(handle){if(handle?.openedByUs&&handle.button){handle.button.click();await sleep(100);}}
async function markForRemoval(entry){
  const removeInput=await waitFor(()=>findRemoveInput(entry.row),1000,40);
  if(!removeInput)throw new Error('Remove quantity input not found');
  const qty=parseListedQty(entry.row,removeInput);
  setControlledInput(removeInput,qty);
  return qty;
}
async function fillManagePage(ctx){
  const rows=getManageRows();if(!rows.length)return null;
  let repriced=0,removed=0,failed=0,skipped=0,rwSkipped=0,dollarSkipped=0;
  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){
      rwSkipped++;
      console.info(`[${SCRIPT}] SKIP RW ${rows[i].name}`);
      continue;
    }
    setButtonState(`OPENING ${i+1}/${rows.length}…`,true);
    let handle=null;
    try{
      handle=await openManageRow(rows[i]);
      const currentPrice=parseMoneyValue(handle.input);
      if(currentPrice===1){
        dollarSkipped++;
        console.info(`[${SCRIPT}] SKIP $1 ${rows[i].name}`);
        continue;
      }
      setButtonState(`CHECKING ${i+1}/${rows.length}…`,true);
      const baz=await getBazaarPrice(rows[i].itemId,ctx.playerId);
      const city=getCitySell(ctx.items,rows[i].itemId);
      if(city>baz.listPrice){
        await markForRemoval(rows[i]);removed++;
        console.info(`[${SCRIPT}] REMOVE ${rows[i].name}: city $${city} > safe bazaar $${baz.listPrice}`);
      }else{
        setControlledInput(handle.input,baz.listPrice);repriced++;
        console.info(`[${SCRIPT}] PRICE ${rows[i].name}: $${baz.listPrice} | base $${baz.targetBase} avg $${Math.round(baz.average)} med $${Math.round(baz.median)}`);
      }
      await sleep(100);
    }catch(e){
      if(/No sane competitor bazaar listings/.test(String(e?.message||'')))skipped++;else failed++;
      console.warn(`[${SCRIPT}] ${rows[i].name} (${rows[i].itemId})`,e);
    }finally{await closeManageRow(handle);}
    await sleep(100);
  }
  return {mode:'manage',repriced,removed,failed,skipped,rwSkipped,dollarSkipped,total:rows.length};
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
  let filled=0,cityBetter=0,skipped=0,failed=0,rwSkipped=0,dollarSkipped=0;
  for(let i=0;i<rows.length;i++){
    if(isRankedWarRow(rows[i].row)){rwSkipped++;continue;}
    if(rows[i].priceInputs.some(x=>parseMoneyValue(x)===1)){dollarSkipped++;continue;}
    setButtonState(`FILLING ${i+1}/${rows.length}…`,true);
    try{
      const q=maxQty(rows[i]);if(!q){skipped++;continue;}
      const baz=await getBazaarPrice(rows[i].itemId,ctx.playerId);
      const city=getCitySell(ctx.items,rows[i].itemId);
      if(city>baz.listPrice){cityBetter++;continue;}
      if(rows[i].checkbox&&!rows[i].checkbox.checked)rows[i].checkbox.click();else if(rows[i].qty)setControlledInput(rows[i].qty,q);
      rows[i].priceInputs.forEach(x=>setControlledInput(x,baz.listPrice));filled++;
    }catch(e){
      if(/No sane competitor bazaar listings/.test(String(e?.message||'')))skipped++;else failed++;
      console.warn(`[${SCRIPT}] add item ${rows[i].itemId}`,e);
    }
    await sleep(100);
  }
  return {mode:'add',filled,cityBetter,skipped,failed,rwSkipped,dollarSkipped,total:rows.length};
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
  b.textContent=msg;b.style.opacity='1';clearTimeout(b._t);b._t=setTimeout(()=>b.style.opacity='0',7000);
}
async function fillPage(){
  if(busy)return;busy=true;setButtonState('LOADING PRICES…',true);
  try{
    const key=getApiKey();
    const ctx=await loadRunContext(key);
    let result=await fillManagePage(ctx);
    if(!result)result=await fillAddPage(ctx);
    if(!result){toast('No editable Bazaar rows found on this screen.','warn');return;}
    if(result.mode==='manage'){
      const bits=[`${result.repriced} repriced`,`${result.removed} marked for removal`];
      if(result.rwSkipped)bits.push(`${result.rwSkipped} RW skipped`);
      if(result.dollarSkipped)bits.push(`${result.dollarSkipped} $1 skipped`);
      if(result.skipped)bits.push(`${result.skipped} no safe price`);
      if(result.failed)bits.push(`${result.failed} failed`);
      toast(`${bits.join(' • ')}. Review, then tap SAVE CHANGES.`,result.failed?'warn':'ok');
    }else{
      const bits=[`${result.filled} filled`];
      if(result.cityBetter)bits.push(`${result.cityBetter} better sold to city`);
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
    const v=prompt('Undercut the safe competing WEAV3R bazaar target by how many dollars?',String(getUndercut()));if(v===null)return;
    const n=Number(v.replace(/,/g,'').trim());if(!Number.isFinite(n)||n<0)return toast('Enter a valid non-negative dollar amount.','error');
    localStorage.setItem(UNDERCUT_STORAGE,String(Math.floor(n)));toast(`Bazaar undercut set to $${Math.floor(n).toLocaleString()}.`);
  });
  w.append(b,g);document.body.appendChild(w);
}
function boot(){
  injectUI();new MutationObserver(injectUI).observe(document.documentElement,{childList:true,subtree:true});
  console.log(`[${SCRIPT}] Loaded v0.5.0`);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();