// ==UserScript==
// @name         Stadium Lottery Expert
// @namespace    https://github.com/ok40807work-dev/stadium-rent-expert
// @version      0.1.0
// @description  年度預定場地抽籤登記：自動選場地、勾選時段、填寫活動資料。登入、Cloudflare 驗證、送出由使用者操作。
// @match        https://vbs.sportdraw.com.tw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 登記設定：要改場地、日期、時段、活動資料都改這裡
  const CONFIG = {
    mainVenue: '溪洲[福和]河濱公園',  // 主場地（和網站下拉選單上的文字一樣）
    venue: '壘球場 B面',              // 子場地（和網站表格「子場地」欄的文字一樣）
    from: '2027-01-01',               // 登記期間（含）
    to: '2027-06-30',
    weekdays: [1, 2, 3, 4, 5],        // 星期幾（0=週日, 1=週一 ... 6=週六）；這裡是週一到週五
    daysOfMonth: [16, 31],            // 每月幾號到幾號；[16, 31] 是下半月，整個月填 [1, 31]
    block: 18,                        // 4 小時時段的開始時間：8（8–12 時）、13（13–17 時）或 18（18–22 時）

    form: {
      eventName: '黑狗練球團',
      eventDescription: '球隊例行練習',
      peoples: 20,                    // 活動參與人數
    },
  };

  const BLOCKS = [8, 13, 18];          // 非網球場地一次要登記 4 小時，只有這三個時段
  const FIRST_HOUR = 8;                // 時段表第一列是 8:00
  const CREATE_PATH = '/lottery/create';
  const KEY = 'stadium-lottery-expert:v1';

  // ---------- 狀態 ----------

  function freshState() { return { running: false, log: [] }; }
  function load() {
    try { return { ...freshState(), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return freshState(); }
  }
  let state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 無法儲存時仍可在本頁執行 */ }
    render();
  }
  function log(msg) {
    state.log.push(`${new Date().toLocaleTimeString()} ${msg}`);
    state.log = state.log.slice(-200);
    console.log('[Stadium Lottery Expert]', msg);
    save();
  }

  function targetDates() {
    const out = [];
    const [first, last] = CONFIG.daysOfMonth;
    for (let d = new Date(CONFIG.from + 'T00:00:00'); d <= new Date(CONFIG.to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
      if (CONFIG.weekdays.includes(d.getDay()) && d.getDate() >= first && d.getDate() <= last) {
        out.push(d.toLocaleDateString('sv-SE'));
      }
    }
    return out;
  }

  // ---------- 面板 ----------

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-height:60vh;display:flex;flex-direction:column;'
    + 'background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:13px/1.5 sans-serif;';
  panel.innerHTML = `
    <div style="padding:8px 10px;background:#4a7aa8;color:#fff;border-radius:8px 8px 0 0;font-weight:bold">Stadium Lottery Expert</div>
    <div data-status style="padding:8px 10px;font-weight:bold;white-space:pre-wrap"></div>
    <div style="padding:0 10px 8px;display:flex;gap:6px">
      <button data-start>開始</button><button data-stop>暫停</button><button data-clear>清除紀錄</button>
    </div>
    <pre data-log style="margin:0;padding:8px 10px;overflow:auto;flex:1;background:#f6f6f6;white-space:pre-wrap;font-size:12px"></pre>`;
  const $status = panel.querySelector('[data-status]');
  const $log = panel.querySelector('[data-log]');
  let statusText = '';
  function setStatus(t) { statusText = t; render(); }
  function render() {
    $status.textContent = `${state.running ? '▶ 執行中' : '■ 已暫停'}` + (statusText ? `\n${statusText}` : '');
    $log.textContent = state.log.slice(-40).join('\n');
    $log.scrollTop = $log.scrollHeight;
  }
  panel.querySelector('[data-start]').onclick = () => {
    if (!BLOCKS.includes(CONFIG.block)) { log(`block 只能是 ${BLOCKS.join('、')}`); return; }
    state.running = true;
    phase = 'select';
    log(`開始：${CONFIG.mainVenue} / ${CONFIG.venue}，${targetDates().length} 天，每天 ${CONFIG.block}:00–${CONFIG.block + 4}:00`);
    if (location.pathname !== CREATE_PATH) location.href = CREATE_PATH;
  };
  panel.querySelector('[data-stop]').onclick = () => { state.running = false; log('已暫停'); };
  panel.querySelector('[data-clear]').onclick = () => { state.log = []; save(); };
  document.body.appendChild(panel);
  render();

  // ---------- DOM 工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  async function waitFor(fn, timeout = 15000, interval = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }
  async function settle(root = document) {
    await sleep(300);
    await waitFor(() => ![...root.querySelectorAll('.el-loading-mask')].some(visible), 30000);
  }
  const findButton = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => visible(b) && b.innerText.trim() === text);
  const messageBox = () => [...document.querySelectorAll('.el-message-box')].find(visible);

  async function dismissMessageBox() {
    const box = messageBox();
    if (!box) return null;
    const text = (box.querySelector('.el-message-box__message')?.innerText || '').trim();
    const btns = box.querySelectorAll('.el-message-box__btns button');
    btns[btns.length - 1]?.click();
    await waitFor(() => !visible(box), 5000);
    return text || '（網站跳出提示）';
  }

  function openSelect(sel) {
    (sel.querySelector('.el-select__wrapper') || sel.querySelector('.el-input__wrapper') || sel).click();
  }
  function closeDropdowns() {
    for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  }
  async function pickOption(text) {
    const opt = await waitFor(() => {
      const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter(visible);
      return opts.find((o) => o.innerText.trim() === text) || opts.find((o) => o.innerText.includes(text));
    }, 3000);
    if (opt) opt.click(); else closeDropdowns();
    return !!opt;
  }
  function formItem(label) {
    return [...document.querySelectorAll('.el-form-item')]
      .find((fi) => visible(fi) && (fi.querySelector('.el-form-item__label')?.innerText || '').trim() === label);
  }
  function fillText(label, value) {
    const input = formItem(label)?.querySelector('textarea, input');
    if (!input) return false;
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(value));
    for (const t of ['input', 'change', 'blur']) input.dispatchEvent(new Event(t, { bubbles: true }));
    return true;
  }

  // ---------- 第 1 步：選擇場地與時段 ----------

  async function chooseMainVenue() {
    const item = await waitFor(() => formItem('主場地'), 20000);
    if (!item) throw new Error('找不到「主場地」選單');
    if (item.innerText.includes(CONFIG.mainVenue)) return;
    openSelect(item.querySelector('.el-select'));
    if (!(await pickOption(CONFIG.mainVenue))) throw new Error(`主場地選單裡沒有「${CONFIG.mainVenue}」`);
    await sleep(500);
    if (messageBox()) await dismissMessageBox(); // 「更換主場地將清空已選擇的場地」
    await settle();
  }

  async function openTimeDialog() {
    const row = await waitFor(() => [...document.querySelectorAll('.el-table__row')]
      .find((r) => visible(r) && r.innerText.includes(CONFIG.venue)), 20000);
    if (!row) throw new Error(`場地表格裡沒有「${CONFIG.venue}」`);
    const btn = findButton('選擇時段', row);
    if (!btn || btn.disabled) throw new Error(`「${CONFIG.venue}」的「選擇時段」按鈕無法點選`);
    btn.click();
    const dialog = await waitFor(() => [...document.querySelectorAll('.lottery-select-time-dialog')].find(visible), 15000);
    if (!dialog) throw new Error('時段視窗沒有出現');
    await settle(dialog);
    return dialog;
  }

  // 時段視窗上方顯示「YYYY/MM」，左右兩個按鈕切換月份
  function monthHeader(dialog) {
    return [...dialog.querySelectorAll('div')].find((d) => d.children.length === 0 && /^\d{4}\/\d{2}$/.test(d.textContent.trim()));
  }
  async function gotoMonth(dialog, ym) {
    const want = ym.replace('-', '/');
    for (let i = 0; i < 24; i++) {
      const header = monthHeader(dialog);
      if (!header) throw new Error('找不到時段視窗的月份');
      const cur = header.textContent.trim();
      if (cur === want) return true;
      const [prev, next] = header.parentElement.querySelectorAll('button');
      const btn = cur < want ? next : prev;
      if (!btn || btn.disabled) return false;
      btn.click();
      await waitFor(() => monthHeader(dialog)?.textContent.trim() !== cur, 5000);
      await settle(dialog);
    }
    return false;
  }

  async function selectBlock(dialog, date) {
    const col = new Date(date + 'T00:00:00').getDate() - 1;
    const row = CONFIG.block - FIRST_HOUR;
    const cell = dialog.querySelector(`.block[data-column="${col}"][data-row="${row}"]`);
    if (!cell) return '沒有這個時段';
    if (cell.classList.contains('selected')) return null;
    if (!cell.classList.contains('selectable')) {
      if (cell.classList.contains('ordered')) return '此時段您已有預定';
      return (cell.getAttribute('title') || cell.innerText || '不可登記').replace(/\s+/g, ' ').trim();
    }
    cell.click();
    // 每勾一個時段網站都會檢查一次額度，等它勾上或跳出提示
    const ok = await waitFor(() => cell.classList.contains('selected') || messageBox(), 20000);
    const msg = await dismissMessageBox();
    await settle(dialog);
    if (!ok || msg || !cell.classList.contains('selected')) return msg || '勾選逾時';
    return null;
  }

  async function runSelectStep() {
    setStatus('選擇場地與時段中，請勿操作頁面…');
    await chooseMainVenue();
    const dialog = await openTimeDialog();

    const dates = targetDates();
    let picked = 0;
    for (const ym of [...new Set(dates.map((d) => d.slice(0, 7)))]) {
      if (!state.running) return false;
      if (!(await gotoMonth(dialog, ym))) {
        log(`略過 ${ym}：不在這次抽籤的月份範圍`);
        continue;
      }
      for (const d of dates.filter((x) => x.startsWith(ym))) {
        if (!state.running) return false;
        const err = await selectBlock(dialog, d);
        if (err) log(`略過 ${d}：${err}`);
        else { picked++; log(`✓ ${d} ${CONFIG.block}:00–${CONFIG.block + 4}:00`); }
      }
    }

    const confirmBtn = findButton('確認', dialog);
    if (!confirmBtn) throw new Error('找不到時段視窗的「確認」按鈕');
    confirmBtn.click();
    await waitFor(() => !visible(dialog), 5000);
    if (!picked) throw new Error('沒有勾到任何時段');
    log(`共勾選 ${picked} 天`);

    const next = await waitFor(() => findButton('下一步'), 5000);
    if (!next || next.disabled) throw new Error('「下一步」無法點選');
    next.click();
    return true;
  }

  // ---------- 第 2 步：活動資料 ----------

  async function runInfoStep() {
    setStatus('填寫活動資料中…');
    await waitFor(() => formItem('活動名稱'), 10000);
    const f = CONFIG.form;
    if (!fillText('活動名稱', f.eventName)) throw new Error('找不到「活動名稱」欄位');
    fillText('活動說明', f.eventDescription);
    fillText('活動參與人數', f.peoples);
    await sleep(500);
    // 第 2 步也有「下一步」，按目前看得到的那一個
    const next = [...document.querySelectorAll('button')].filter((b) => visible(b) && b.innerText.trim() === '下一步').pop();
    if (!next) throw new Error('找不到活動資料的「下一步」');
    next.click();
    await sleep(800);
    const errors = [...document.querySelectorAll('.el-form-item__error')].filter(visible).map((e) => e.innerText.trim());
    if (errors.length) throw new Error(`活動資料有誤：${errors.join('、')}`);
  }

  // ---------- 主迴圈 ----------

  let phase = 'select';   // select → info → confirm → done
  let busy = false;
  async function tick() {
    if (busy || !state.running) return;
    busy = true;
    try {
      const text = document.body.innerText;
      if (text.includes('目前未開放抽籤登記')) {
        state.running = false;
        log('目前未開放抽籤登記');
      } else if (location.pathname.startsWith('/login')) {
        setStatus('請登入，登入後會自動繼續。');
      } else if (location.pathname !== CREATE_PATH) {
        if (phase === 'select') location.href = CREATE_PATH;
      } else if (text.includes('預定完成')) {
        const no = (text.match(/預定號碼[：:]\s*([A-Za-z0-9-]+)/) || [])[1] || '（請到預定紀錄查看）';
        log(`登記完成，預定號碼 ${no}`);
        state.running = false;
        phase = 'done';
        setStatus('登記完成。抽籤結果請到「場地抽籤登記結果」查看。');
      } else if (phase === 'select' && formItem('主場地')) {
        if (await runSelectStep()) phase = 'info';
      } else if (phase === 'info' && formItem('活動名稱')) {
        await runInfoStep();
        phase = 'confirm';
      } else if (phase === 'confirm' && findButton('送出')) {
        setStatus('請等下方 Cloudflare 驗證完成，核對內容後按「送出」。');
      }
    } catch (e) {
      state.running = false;
      log(`錯誤：${e.message}`);
      setStatus('已暫停。修正問題後重新整理頁面，再按「開始」。');
    } finally {
      busy = false;
    }
  }
  setInterval(tick, 1000);
})();
