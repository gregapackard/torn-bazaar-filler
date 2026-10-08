// ==UserScript==
// @name         Cloudy's Bazaar Filler
// @namespace    https://github.com/gregapackard/torn-bazaar-filler
// @version      0.1.0
// @description  PDA-first Torn bazaar filler: one button fills every visible Add Items row with max quantity and lowest Item Market price minus $1.
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

    const SCRIPT = 'CloudyBazaarFiller';
    const API_KEY_STORAGE = 'cloudys-bazaar-filler-api-key';
    const UNDERCUT_STORAGE = 'cloudys-bazaar-filler-undercut';
    const DEFAULT_UNDERCUT = 1;

    let busy = false;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function log(...args) {
        console.log(`[${SCRIPT}]`, ...args);
    }

    function fireInput(input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
    }

    function setControlledInput(input, value) {
        if (!input) return;
        const proto = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) descriptor.set.call(input, String(value));
        else input.value = String(value);
        fireInput(input);
    }

    function getApiKey() {
        let key = localStorage.getItem(API_KEY_STORAGE) || '';
        if (/^[A-Za-z0-9]{16}$/.test(key)) return key;

        key = (prompt("Cloudy's Bazaar Filler\n\nEnter your 16-character Torn PUBLIC/LIMITED API key. It is stored only in your browser/PDA local storage.") || '').trim();
        if (!/^[A-Za-z0-9]{16}$/.test(key)) {
            throw new Error('A valid 16-character Torn API key is required.');
        }
        localStorage.setItem(API_KEY_STORAGE, key);
        return key;
    }

    function getUndercut() {
        const raw = Number(localStorage.getItem(UNDERCUT_STORAGE));
        return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_UNDERCUT;
    }

    function apiGet(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 12000,
                onload: response => {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data?.error) reject(new Error(data.error.error || `Torn API error ${data.error.code}`));
                        else resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('Network error contacting Torn API.')),
                ontimeout: () => reject(new Error('Torn API request timed out.'))
            });
        });
    }

    async function getLowestMarketPrice(itemId, apiKey) {
        const url = `https://api.torn.com/v2/market?id=${encodeURIComponent(itemId)}&selections=itemMarket&key=${encodeURIComponent(apiKey)}&comment=CloudysBazaarFiller`;
        const data = await apiGet(url);
        const listings = data?.itemmarket || data?.itemMarket || data?.item_market || [];
        if (!Array.isArray(listings) || !listings.length) throw new Error('No Item Market listings found.');

        const prices = listings
            .map(x => Number(x?.price))
            .filter(x => Number.isFinite(x) && x > 0)
            .sort((a, b) => a - b);

        if (!prices.length) throw new Error('No valid Item Market prices found.');
        return prices[0];
    }

    function getItemId(row) {
        const img = row.querySelector('img[src*="/items/"]');
        if (!img) return null;
        const match = img.src.match(/\/items\/(\d+)\//) || img.src.match(/\/(\d+)\//);
        return match ? Number(match[1]) : null;
    }

    function findAmountWrap(row) {
        return row.querySelector('div.amount-main-wrap');
    }

    function getRowControls(row) {
        const amountWrap = findAmountWrap(row);
        if (!amountWrap) return null;

        const checkbox = amountWrap.querySelector('div.amount.choice-container input[type="checkbox"], div.amount.choice-container input');
        const quantityInput = checkbox ? null : amountWrap.querySelector('div.amount input');
        const priceInputs = [...amountWrap.querySelectorAll('div.price input, div.input-money-group input')];
        const itemId = getItemId(row);

        if (!itemId || (!checkbox && !quantityInput) || !priceInputs.length) return null;
        return { row, amountWrap, checkbox, quantityInput, priceInputs, itemId };
    }

    function getMaxQuantity(control) {
        if (control.checkbox) return 1;
        const input = control.quantityInput;
        const maxAttr = Number(input?.max);
        if (Number.isFinite(maxAttr) && maxAttr > 0) return Math.floor(maxAttr);

        const amountText = control.amountWrap.textContent || '';
        const patterns = [
            /(?:owned|available|quantity|qty|max)\D{0,12}([\d,]+)/i,
            /([\d,]+)\s*(?:available|owned)/i,
            /x\s*([\d,]+)/i
        ];
        for (const pattern of patterns) {
            const m = amountText.match(pattern);
            if (m) {
                const n = Number(m[1].replace(/,/g, ''));
                if (Number.isFinite(n) && n > 0) return Math.floor(n);
            }
        }

        // Torn's quantity input normally accepts its owned quantity via the browser max property.
        // If DOM drift removes that hint, skip rather than risk listing the wrong amount.
        return null;
    }

    function getVisibleAddRows() {
        const candidates = [...document.querySelectorAll('li.clearfix')]
            .filter(row => row.querySelector('div.amount-main-wrap') && row.querySelector('img[src*="/items/"]'));

        return candidates.filter(row => {
            const rect = row.getBoundingClientRect();
            const style = getComputedStyle(row);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
    }

    function selectCheckbox(checkbox) {
        if (checkbox && !checkbox.checked) checkbox.click();
    }

    async function fillRow(control, apiKey) {
        const maxQty = getMaxQuantity(control);
        if (!maxQty) return { status: 'skipped', itemId: control.itemId, reason: 'quantity' };

        const lowest = await getLowestMarketPrice(control.itemId, apiKey);
        const listPrice = Math.max(1, lowest - getUndercut());

        if (control.checkbox) selectCheckbox(control.checkbox);
        else setControlledInput(control.quantityInput, maxQty);

        for (const priceInput of control.priceInputs) setControlledInput(priceInput, listPrice);

        return { status: 'filled', itemId: control.itemId, qty: maxQty, lowest, listPrice };
    }

    function setButtonState(text, disabled = false) {
        const btn = document.getElementById('cbf-fill-page');
        if (!btn) return;
        btn.textContent = text;
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.7' : '1';
    }

    function toast(message, type = 'ok') {
        let box = document.getElementById('cbf-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'cbf-toast';
            Object.assign(box.style, {
                position: 'fixed', left: '12px', right: '12px', bottom: '76px', zIndex: '2147483647',
                padding: '11px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: '700',
                textAlign: 'center', color: '#fff', boxShadow: '0 4px 14px rgba(0,0,0,.35)',
                pointerEvents: 'none', transition: 'opacity .2s ease'
            });
            document.body.appendChild(box);
        }
        box.style.background = type === 'error' ? '#a82c2c' : type === 'warn' ? '#8a6515' : '#287842';
        box.textContent = message;
        box.style.opacity = '1';
        clearTimeout(box._cbfTimer);
        box._cbfTimer = setTimeout(() => box.style.opacity = '0', 3500);
    }

    async function fillPage() {
        if (busy) return;
        busy = true;
        setButtonState('FILLING…', true);

        try {
            const apiKey = getApiKey();
            const rows = getVisibleAddRows();
            const controls = rows.map(getRowControls).filter(Boolean);

            if (!controls.length) {
                toast('No Add Items rows found on this screen.', 'warn');
                return;
            }

            let filled = 0;
            let skipped = 0;
            let failed = 0;

            // Deliberately sequential. It is still one tap for the user, but keeps API usage smooth on PDA.
            for (let i = 0; i < controls.length; i++) {
                setButtonState(`FILLING ${i + 1}/${controls.length}…`, true);
                try {
                    const result = await fillRow(controls[i], apiKey);
                    if (result.status === 'filled') filled++;
                    else skipped++;
                } catch (err) {
                    failed++;
                    log(`Item ${controls[i].itemId} failed:`, err);
                }
                await sleep(90);
            }

            toast(`${filled} filled${skipped ? ` • ${skipped} skipped` : ''}${failed ? ` • ${failed} failed` : ''}`, failed ? 'warn' : 'ok');
        } catch (err) {
            console.error(`[${SCRIPT}]`, err);
            toast(err.message || 'Fill failed.', 'error');
        } finally {
            busy = false;
            setButtonState('FILL THIS PAGE');
        }
    }

    function injectUI() {
        if (document.getElementById('cbf-fill-page')) return;

        const wrap = document.createElement('div');
        wrap.id = 'cbf-wrap';
        Object.assign(wrap.style, {
            position: 'fixed', left: '10px', right: '10px', bottom: '12px', zIndex: '2147483646',
            display: 'flex', gap: '8px', alignItems: 'stretch', maxWidth: '680px', margin: '0 auto'
        });

        const btn = document.createElement('button');
        btn.id = 'cbf-fill-page';
        btn.type = 'button';
        btn.textContent = 'FILL THIS PAGE';
        Object.assign(btn.style, {
            flex: '1 1 auto', minHeight: '52px', border: '0', borderRadius: '12px',
            background: 'linear-gradient(180deg,#2f9b56,#247642)', color: '#fff', fontSize: '16px',
            fontWeight: '900', letterSpacing: '.3px', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
            touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent'
        });
        btn.addEventListener('click', fillPage);

        const gear = document.createElement('button');
        gear.type = 'button';
        gear.textContent = '⚙';
        gear.title = 'Cloudy Bazaar Filler settings';
        Object.assign(gear.style, {
            width: '52px', minHeight: '52px', border: '0', borderRadius: '12px', background: '#333',
            color: '#fff', fontSize: '22px', fontWeight: '700', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
            touchAction: 'manipulation'
        });
        gear.addEventListener('click', () => {
            const current = getUndercut();
            const value = prompt('Undercut the cheapest Item Market listing by how many dollars?', String(current));
            if (value === null) return;
            const parsed = Number(value.replace(/,/g, '').trim());
            if (!Number.isFinite(parsed) || parsed < 0) return toast('Enter a valid non-negative dollar amount.', 'error');
            localStorage.setItem(UNDERCUT_STORAGE, String(Math.floor(parsed)));
            toast(`Undercut set to $${Math.floor(parsed).toLocaleString()}.`);
        });

        wrap.append(btn, gear);
        document.body.appendChild(wrap);
    }

    function boot() {
        injectUI();
        const observer = new MutationObserver(() => injectUI());
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('hashchange', injectUI);
        log('Loaded v0.1.0');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
