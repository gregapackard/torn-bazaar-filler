// ==UserScript==
// @name         Cloudy's Bazaar Filler
// @namespace    https://github.com/gregapackard/torn-bazaar-filler
// @version      0.3.0
// @description  PDA-first Torn bazaar filler/repricer. One button fills Add Items or opens and reprices each visible Manage Items row on mobile.
// @author       CloudyMuffin440 [4315564]
// @license      MIT
// @match        https://www.torn.com/bazaar.php*
// @match        https://*.torn.com/bazaar.php*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @updateURL    https://raw.githubusercontent.com/gregapackard/torn-bazaar-filler/main/cloudys-bazaar-filler.user.js
// @downloadURL  https://raw.githubusercontent.com/gregapackard/torn-bazaar-filler/main/cloudys-bazaar-filler.user.js
// ==/UserScript==

(() => {
'use strict';

const SCRIPT='CloudyBazaarFiller';
const API_KEY_STORAGE='cloudys-bazaar-filler-api-key';
const UNDERCUT_STORAGE='cloudys-bazaar-filler-undercut';
const DEFAULT_UNDERCUT=1;
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
  localStorage.setItem(API_KEY_STORAGE,key);return key;
}
function getUndercut(){const n=Number(localStorage.getItem(UNDERCUT_STORAGE));return Number.isFinite(n)&&n>=0?Math.floor(n):DEFAULT_UNDERCUT;}
function apiGet(url){return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url,timeout:12000,onload:r=>{try{const d=JSON.parse(r.responseText);d?.error?reject(new Error(d.error.error||`Torn API error ${d.error.code}`)):resolve(d);}catch(e){reject(e)}},onerror:()=>reject(new Error('Network error contacting Torn API.')),ontimeout:()=>reject(new Error('Torn API request timed out.'))}));}
async function getLowestMarketPrice(itemId,key){
  const d=await apiGet(`https://api.torn.com/v2/market?id=${encodeURIComponent(itemId)}&selections=itemMarket&key=${encodeURIComponent(key)}&comment=CloudysBazaarFiller`);
  const listings=d?.itemmarket||d?.itemMarket||d?.item_market||[];
  const prices=Array.isArray(listings)?listings.map(x=>Number(x?.price)).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b):[];
  if(!prices.length)throw new Error('No Item Market listings found.');
  return prices[0];
}
function itemIdFrom(el){
  const img=el?.querySelector('img[src*="/items/"], img'); if(!img)return null;
  const src=img.src||img.getAttribute('src')||'';
  const m=src.match(/\/items\/(\d+)\//i)||src.match(/\/items\/(\d+)\./i)||src.match(/\/(\d+)\.(?:png|jpg|webp)/i)||src.match(/\/(\d+)\//);
  return m?Number(m[1]):null;
}
function itemName(el){
  const txt=(el?.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  return txt.find(x=>!/^x?\d+$/.test(x)&&!/^\$/.test(x))||'item';
}
async function waitFor(fn,timeout=1800,interval=40){
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
    const id=itemIdFrom(row);
    if(!id||seen.has(id))continue;
    seen.add(id);
    out.push({row,desc,itemId:id,name:itemName(row)});
  }
  return out;
}
function getManageButton(row){
  return row.querySelector('[class*="menuActivators___"] button[class*="iconContainer___"][aria-label="Manage"]')
      || row.querySelector('button[aria-label="Manage"]')
      || [...row.querySelectorAll('button')].find(b=>/manage/i.test(b.getAttribute('aria-label')||b.title||''));
}
function isManageButtonActive(button){
  return !!button?.querySelector('span[class*="active___"]') || button?.getAttribute('aria-expanded')==='true';
}
function findMobilePriceInput(row){
  const parent=row.parentElement;
  const scopes=[parent,row,document];
  for(const scope of scopes){
    if(!scope)continue;
    const box=scope.querySelector('[class*="bottomMobileMenu___"] [class*="priceMobile___"]');
    if(box){
      const input=box.querySelector('div.input-money-group input, input');
      if(input&&visible(input))return input;
    }
  }
  return null;
}
async function openManageRow(entry){
  let input=findMobilePriceInput(entry.row);
  if(input)return {input,button:getManageButton(entry.row),openedByUs:false};

  const button=getManageButton(entry.row);
  if(!button)throw new Error('Manage button not found');
  const wasActive=isManageButtonActive(button);
  if(!wasActive)button.click();

  input=await waitFor(()=>findMobilePriceInput(entry.row),2200,50);
  if(!input)throw new Error('Mobile price panel did not open');
  return {input,button,openedByUs:!wasActive};
}
async function closeManageRow(handle){
  if(!handle?.openedByUs||!handle.button)return;
  handle.button.click();
  await sleep(90);
}
async function fillManagePage(key){
  const rows=getManageRows();
  if(!rows.length)return null;
  let filled=0,failed=0;

  for(let i=0;i<rows.length;i++){
    setButtonState(`OPENING ${i+1}/${rows.length}…`,true);
    let handle=null;
    try{
      handle=await openManageRow(rows[i]);
      setButtonState(`PRICING ${i+1}/${rows.length}…`,true);
      const low=await getLowestMarketPrice(rows[i].itemId,key);
      const price=Math.max(1,low-getUndercut());
      setControlledInput(handle.input,price);
      await sleep(100);
      filled++;
    }catch(e){
      failed++;
      console.warn(`[${SCRIPT}] ${rows[i].name} (${rows[i].itemId})`,e);
    }finally{
      await closeManageRow(handle);
    }
    await sleep(90);
  }
  return {mode:'manage',filled,failed,total:rows.length};
}

// ---------- Add Items ----------
function getAddRows(){return [...document.querySelectorAll('ul.items-cont li.clearfix, div[class*="itemsContainner___"] div[class*="item___"], div[class*="rowItems___"] div[class*="item___"]')].filter(r=>visible(r)&&r.querySelector('div.amount-main-wrap, div[class*="amount___"]')&&itemIdFrom(r));}
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
async function fillAddPage(key){
  const rows=getAddRows().map(addControls).filter(Boolean);
  if(!rows.length)return null;
  let filled=0,skipped=0,failed=0;
  for(let i=0;i<rows.length;i++){
    setButtonState(`FILLING ${i+1}/${rows.length}…`,true);
    try{
      const q=maxQty(rows[i]);if(!q){skipped++;continue;}
      const low=await getLowestMarketPrice(rows[i].itemId,key),price=Math.max(1,low-getUndercut());
      if(rows[i].checkbox&&!rows[i].checkbox.checked)rows[i].checkbox.click(); else if(rows[i].qty)setControlledInput(rows[i].qty,q);
      rows[i].priceInputs.forEach(x=>setControlledInput(x,price));filled++;
    }catch(e){failed++;console.warn(`[${SCRIPT}] add item ${rows[i].itemId}`,e);}
    await sleep(90);
  }
  return {mode:'add',filled,skipped,failed,total:rows.length};
}

function setButtonState(text,disabled=false){const b=document.getElementById('cbf-fill-page');if(!b)return;b.textContent=text;b.disabled=disabled;b.style.opacity=disabled?'.7':'1';}
function toast(msg,type='ok'){
  let b=document.getElementById('cbf-toast');if(!b){b=document.createElement('div');b.id='cbf-toast';Object.assign(b.style,{position:'fixed',left:'12px',right:'12px',bottom:'76px',zIndex:'2147483647',padding:'11px 14px',borderRadius:'10px',fontSize:'13px',fontWeight:'700',textAlign:'center',color:'#fff',boxShadow:'0 4px 14px rgba(0,0,0,.35)',pointerEvents:'none'});document.body.appendChild(b);}b.style.background=type==='error'?'#a82c2c':type==='warn'?'#8a6515':'#287842';b.textContent=msg;b.style.opacity='1';clearTimeout(b._t);b._t=setTimeout(()=>b.style.opacity='0',4500);
}
async function fillPage(){
  if(busy)return;busy=true;setButtonState('SCANNING…',true);
  try{
    const key=getApiKey();
    let result=await fillManagePage(key);
    if(!result)result=await fillAddPage(key);
    if(!result){toast('No editable Bazaar rows found on this screen.','warn');return;}
    if(result.mode==='manage')toast(`${result.filled}/${result.total} prices filled${result.failed?` • ${result.failed} failed`:''}. Review, then tap SAVE CHANGES.`,result.failed?'warn':'ok');
    else toast(`${result.filled}/${result.total} filled${result.skipped?` • ${result.skipped} skipped`:''}${result.failed?` • ${result.failed} failed`:''}`,result.failed?'warn':'ok');
  }catch(e){console.error(`[${SCRIPT}]`,e);toast(e.message||'Fill failed.','error');}
  finally{busy=false;setButtonState('FILL THIS PAGE');}
}
function injectUI(){
  if(document.getElementById('cbf-fill-page'))return;
  const w=document.createElement('div');w.id='cbf-wrap';Object.assign(w.style,{position:'fixed',left:'10px',right:'10px',bottom:'12px',zIndex:'2147483646',display:'flex',gap:'8px',alignItems:'stretch',maxWidth:'680px',margin:'0 auto'});
  const b=document.createElement('button');b.id='cbf-fill-page';b.type='button';b.textContent='FILL THIS PAGE';Object.assign(b.style,{flex:'1 1 auto',minHeight:'52px',border:'0',borderRadius:'12px',background:'linear-gradient(180deg,#2f9b56,#247642)',color:'#fff',fontSize:'16px',fontWeight:'900',letterSpacing:'.3px',boxShadow:'0 4px 16px rgba(0,0,0,.4)',touchAction:'manipulation'});b.addEventListener('click',fillPage);
  const g=document.createElement('button');g.type='button';g.textContent='⚙';Object.assign(g.style,{width:'52px',minHeight:'52px',border:'0',borderRadius:'12px',background:'#333',color:'#fff',fontSize:'22px',fontWeight:'700',boxShadow:'0 4px 16px rgba(0,0,0,.4)',touchAction:'manipulation'});g.addEventListener('click',()=>{const v=prompt('Undercut the cheapest Item Market listing by how many dollars?',String(getUndercut()));if(v===null)return;const n=Number(v.replace(/,/g,'').trim());if(!Number.isFinite(n)||n<0)return toast('Enter a valid non-negative dollar amount.','error');localStorage.setItem(UNDERCUT_STORAGE,String(Math.floor(n)));toast(`Undercut set to $${Math.floor(n).toLocaleString()}.`);});
  w.append(b,g);document.body.appendChild(w);
}
function boot(){injectUI();new MutationObserver(injectUI).observe(document.documentElement,{childList:true,subtree:true});console.log(`[${SCRIPT}] Loaded v0.3.0`);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
