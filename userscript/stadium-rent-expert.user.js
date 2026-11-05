// ==UserScript==
// @name         Stadium Rent Expert
// @namespace    https://github.com/ok40807work-dev/stadium-rent-expert
// @version      0.1.0
// @description  臺北市體育局場地預約：分批勾選時段、填寫活動資料。登入、Cloudflare 驗證、確認申請由使用者操作。
// @match        https://vbs.sports.gov.taipei/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 預約設定：要改日期、時段、場地、活動資料都改這裡
  const CONFIG = {
    id2nd: 295,            // 溪洲[福和]河濱公園 壘球場
    id3rd: 285,            // B 面（A=280, C=286）
    ty: 'O',
    from: '2026-11-01',            // 申請期間（含）
    to: '2026-12-31',
    weekdays: [1, 2, 3, 4, 5],     // 星期幾（0=週日, 1=週一 ... 6=週六）；這裡是週一到週五
    daysOfMonth: [16, 31],         // 每月幾號到幾號；[16, 31] 是下半月（月底不足 31 日也沒關係），整個月填 [1, 31]
    hours: [19, 20, 21],           // 19:00-22:00，每個數字代表一小時

    // 活動資料（選項文字要和網站上顯示的一模一樣）
    form: {
      type: '體育活動',
      deduct: '(四)無收費、無商品展示行銷、廣告之非營利性活動，得免徵(收)場地使用費，但仍應收取應徵(收)照明使用費。',
      sport: '壘球',
      eventName: '黑狗練球團',
      eventDescription: '球隊例行練習',
      peopleAll: 20,
    },
  };

  // 體育局對單一帳號的登記限制
  const LIMITS = {
    hoursPerDay: 4,
    hoursPerWeek: 16,
    weekdaysPerMonth: 10,
    holidaysPerMonth: 2,
    // 開放登記：上午 8–12 時、下午 1–5 時、晚間 6–10 時
    openHours: [8, 9, 10, 11, 13, 14, 15, 16, 18, 19, 20, 21],
  };

  const API = 'https://api.preordervenue.com';
  const ORDER_URL = `/order?id2nd=${CONFIG.id2nd}&ty=${CONFIG.ty}`;
  const KEY = 'stadium-rent-expert:v1';

  // ---------- 狀態（存在這個網站的 localStorage，重新整理頁面後可接續） ----------

  function freshState() {
    return { running: false, phase: 'select', queue: [], batch: [], done: [], holidays: [], log: [] };
  }
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
    console.log('[Stadium Rent Expert]', msg);
    save();
  }

  function targetDates() {
    const out = [];
    for (let d = new Date(CONFIG.from + 'T00:00:00'); d <= new Date(CONFIG.to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
      const [first, last] = CONFIG.daysOfMonth;
      if (CONFIG.weekdays.includes(d.getDay()) && d.getDate() >= first && d.getDate() <= last) {
        out.push(d.toLocaleDateString('sv-SE'));
      }
    }
    return out;
  }

  // ---------- 體育局登記限制 ----------

  function validateConfig() {
    const closed = CONFIG.hours.filter((h) => !LIMITS.openHours.includes(h));
    if (closed.length) return `時段 ${closed.map((h) => `${h}:00`).join('、')} 不開放登記（開放 8–12、13–17、18–22 時）`;
    if (CONFIG.hours.length > LIMITS.hoursPerDay) return `每天最多登記 ${LIMITS.hoursPerDay} 小時，目前設定 ${CONFIG.hours.length} 小時`;
    return null;
  }

  // 以週一為一週的開始
  function weekKey(date) {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString('sv-SE');
  }

  async function fetchSchedule(year, month) {
    const res = await fetch(`${API}/api/Order/Member/Schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id3rd: CONFIG.id3rd, year, month, ty: CONFIG.ty }),
    });
    if (!res.ok) throw new Error(`查詢 ${year}-${month} 時段失敗（HTTP ${res.status}）`);
    return res.json();
  }

  // 依時段狀態與每月、每週上限排出要申請的日期
  async function buildQueue() {
    const dates = targetDates();
    const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
    const slots = new Map();
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number);
      for (const r of await fetchSchedule(y, m)) slots.set(`${r.date.slice(0, 10)} ${r.hour}`, r);
    }

    // 已申請成功的日期也算進上限
    const holidays = new Set(state.holidays);
    const done = new Set(state.done);
    const monthCount = {};
    const weekHours = {};
    const count = (d, isHoliday) => {
      const k = `${d.slice(0, 7)}:${isHoliday ? 'holiday' : 'weekday'}`;
      monthCount[k] = (monthCount[k] || 0) + 1;
      weekHours[weekKey(d)] = (weekHours[weekKey(d)] || 0) + CONFIG.hours.length;
    };
    for (const d of done) count(d, holidays.has(d));

    const queue = [];
    for (const d of dates) {
      if (done.has(d)) continue;
      const rs = CONFIG.hours.map((h) => slots.get(`${d} ${h}`));
      const taken = rs.find((r) => !r || r.eventName || !r.isOrderAble || r.isExpired);
      if (taken) {
        log(`略過 ${d}：${taken?.eventName || (taken?.isExpired ? '已過期' : '不開放租借')}`);
        continue;
      }
      const isHoliday = rs.some((r) => r.isHoliday);
      const k = `${d.slice(0, 7)}:${isHoliday ? 'holiday' : 'weekday'}`;
      const cap = isHoliday ? LIMITS.holidaysPerMonth : LIMITS.weekdaysPerMonth;
      if ((monthCount[k] || 0) >= cap) {
        log(`略過 ${d}：超過每月${isHoliday ? '假日' : '平日'} ${cap} 天上限`);
        continue;
      }
      if ((weekHours[weekKey(d)] || 0) + CONFIG.hours.length > LIMITS.hoursPerWeek) {
        log(`略過 ${d}：超過每週 ${LIMITS.hoursPerWeek} 小時上限`);
        continue;
      }
      count(d, isHoliday);
      if (isHoliday) holidays.add(d);
      queue.push(d);
    }
    state.holidays = [...holidays];
    return queue;
  }

  // ---------- 面板 ----------

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-height:60vh;display:flex;flex-direction:column;'
    + 'background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:13px/1.5 sans-serif;';
  panel.innerHTML = `
    <div style="padding:8px 10px;background:#5f8b78;color:#fff;border-radius:8px 8px 0 0;font-weight:bold">Stadium Rent Expert</div>
    <div data-status style="padding:8px 10px;font-weight:bold"></div>
    <div style="padding:0 10px 8px;display:flex;gap:6px">
      <button data-start>開始</button><button data-stop>暫停</button><button data-reset>清除紀錄</button>
    </div>
    <pre data-log style="margin:0;padding:8px 10px;overflow:auto;flex:1;background:#f6f6f6;white-space:pre-wrap;font-size:12px"></pre>`;
  const $status = panel.querySelector('[data-status]');
  const $log = panel.querySelector('[data-log]');
  let statusText = '';
  function setStatus(t) { statusText = t; render(); }
  function render() {
    const remain = state.queue.length + state.batch.length;
    $status.textContent = `${state.running ? '▶ 執行中' : '■ 已暫停'}｜已申請 ${state.done.length} 天，待處理 ${remain} 天` + (statusText ? `\n${statusText}` : '');
    $status.style.whiteSpace = 'pre-wrap';
    $log.textContent = state.log.slice(-40).join('\n');
    $log.scrollTop = $log.scrollHeight;
  }
  panel.querySelector('[data-start]').onclick = async () => {
    const err = validateConfig();
    if (err) { log(`設定不符合體育局規定：${err}`); return; }
    if (!state.queue.length && !state.batch.length) {
      try {
        state.queue = await buildQueue();
      } catch (e) {
        log(`錯誤：${e.message}`);
        return;
      }
      state.phase = 'select';
      if (!state.queue.length) { log('沒有需要申請的日期'); return; }
      log(`開始：共 ${state.queue.length} 天待申請`);
    }
    state.running = true;
    save();
  };
  panel.querySelector('[data-stop]').onclick = () => { state.running = false; log('已暫停'); };
  panel.querySelector('[data-reset]').onclick = () => {
    if (!confirm('清除所有紀錄（包含已申請成功的日期）？')) return;
    state = freshState();
    save();
  };
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
  // 等頁面上的載入遮罩消失
  async function settle() {
    await sleep(300);
    await waitFor(() => ![...document.querySelectorAll('.el-loading-mask')].some(visible), 30000);
  }
  const findButton = (text) => [...document.querySelectorAll('button')].find((b) => visible(b) && b.innerText.trim() === text);
  const messageBox = () => [...document.querySelectorAll('.el-message-box')].find(visible);

  // 網站跳出的提示框：記下內容後按確認關掉
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

  // ---------- 預約頁：勾選時段 ----------

  async function ensureTab() {
    const tab = await waitFor(() => document.getElementById(`tab-${CONFIG.id3rd}`), 20000);
    if (!tab) throw new Error(`找不到場地分頁 #tab-${CONFIG.id3rd}`);
    if (tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      await sleep(500);
      if (messageBox()) await dismissMessageBox(); // 「切換場地將清空已選時段」
    }
    if (!(await waitFor(() => document.querySelector('.calendar'), 20000))) throw new Error('找不到時段行事曆');
    await settle();
  }

  async function selectMonth(ym) {
    if (document.querySelector(`.calendar [data-date^="${ym}-"]`)) return true;
    const [y, m] = ym.split('-');
    const sel = [...document.querySelectorAll('.el-select')].find((s) => /\d{4}年\d{2}月/.test(s.innerText));
    if (!sel) throw new Error('找不到月份選單');
    openSelect(sel);
    if (!(await pickOption(`${y}年${m}月`))) return false; // 這個月份還沒開放預約
    await waitFor(() => document.querySelector(`.calendar [data-date^="${ym}-"]`), 15000);
    await settle();
    return true;
  }

  function hourRows() {
    // 行事曆第一欄是時間軸，依序列出每一列代表的小時
    return [...document.querySelectorAll('.calendar > div:first-child > div')].slice(1).map((el) => parseInt(el.textContent, 10));
  }
  function cellOf(date, hour) {
    const row = hourRows().indexOf(hour);
    return row < 0 ? null : document.querySelector(`.calendar [data-date="${date}"] > div:nth-child(${row + 2})`);
  }

  // 勾選某一天的所有時段；任何一格失敗就回傳原因
  async function selectDate(date) {
    if (!(await selectMonth(date.slice(0, 7)))) return `${date}：該月份尚未開放預約`;
    for (const h of CONFIG.hours) {
      const tag = `${date} ${h}:00`;
      const cell = cellOf(date, h);
      const box = cell?.querySelector('.box.selectable');
      if (!box) {
        const why = (cell?.innerText || '').replace(/\s+/g, ' ').trim();
        return `${tag}：不可預約${why ? `（${why}）` : ''}`;
      }
      if (box.classList.contains('selected')) continue;
      box.click();
      // 每勾一格網站都會向伺服器檢查一次，等它勾上或跳出提示
      const ok = await waitFor(() => box.classList.contains('selected') || messageBox(), 20000);
      const msg = await dismissMessageBox();
      await settle();
      if (!ok || msg || !box.classList.contains('selected')) return `${tag}：${msg || '勾選逾時'}`;
    }
    return null;
  }

  // 只勾到部分時段的日期整天取消，不送出不完整的時段
  async function unselectDate(date) {
    for (let i = 0; i < CONFIG.hours.length; i++) {
      const box = document.querySelector(`.calendar [data-date="${date}"] .box.selectable.selected`);
      if (!box) return;
      box.click();
      await settle();
      await dismissMessageBox();
    }
  }

  // ---------- 預約頁：活動資料 ----------

  function formItem(label) {
    return [...document.querySelectorAll('.el-form-item')]
      .find((fi) => visible(fi) && (fi.querySelector('.el-form-item__label')?.innerText || '').includes(label));
  }
  // 欄位可能是下拉選單或單選按鈕，兩種都處理
  async function choose(label, text) {
    const item = formItem(label);
    if (!item) return false;
    const sel = item.querySelector('.el-select');
    if (sel) { openSelect(sel); return pickOption(text); }
    const opt = [...item.querySelectorAll('.el-radio, .el-radio-button, .el-checkbox')].find((o) => o.innerText.trim() === text);
    if (!opt) return false;
    if (!opt.classList.contains('is-checked')) opt.click();
    return true;
  }
  function fillText(label, value) {
    const input = formItem(label)?.querySelector('textarea, input');
    if (!input) return false;
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(value));
    for (const t of ['input', 'change', 'blur']) input.dispatchEvent(new Event(t, { bubbles: true }));
    return true;
  }

  async function fillForm() {
    const f = CONFIG.form;
    // 先填類別：其他欄位會依類別出現或隱藏
    if (!(await choose('租借活動類別', f.type))) throw new Error('找不到「租借活動類別」欄位或選項');
    await sleep(500);
    if (!(await choose('減(免)徵(收)', f.deduct))) throw new Error('找不到「減免徵收」欄位或選項');
    await choose('是否售票', '否 ( No )');
    await choose('盥洗設備', '不需要 ( No need )');
    await choose('夜間照明設備', '不需要 ( No need )');
    if (!fillText('活動名稱', f.eventName)) throw new Error('找不到「活動名稱」欄位');
    fillText('活動說明', f.eventDescription);
    if (!(await choose('活動運動種類', f.sport))) throw new Error('找不到「活動運動種類」欄位或選項');
    fillText('活動參與人數', f.peopleAll);
    await settle();
  }

  // ---------- 各頁面的處理 ----------

  async function runSelectPhase() {
    setStatus('勾選時段中，請勿操作頁面…');
    await ensureTab();
    // 前一次中斷留下的日期放回佇列前面
    state.queue = [...state.batch, ...state.queue];
    state.batch = [];
    save();

    // 一張申請單只放同一個月份的日期（每月上限已在排佇列時套用）
    const month = state.queue[0]?.slice(0, 7);
    while (state.queue.length && state.queue[0].startsWith(month)) {
      if (!state.running) return;
      const d = state.queue.shift();
      save();
      const err = await selectDate(d);
      if (err) {
        log(`略過 ${err}`);
        await unselectDate(d);
      } else {
        state.batch.push(d);
        log(`✓ ${d}`);
      }
    }
    if (!state.batch.length) {
      state.running = false;
      log('全部處理完畢');
      setStatus('');
      return;
    }

    setStatus('填寫活動資料中…');
    await fillForm();
    state.phase = 'confirm';
    save();
    const apply = findButton('直接申請租借');
    if (!apply) throw new Error('找不到「直接申請租借」按鈕');
    apply.click();
    await sleep(1500);
    findButton('不需要，直接申請租借')?.click();
    await sleep(500);
    const msg = await dismissMessageBox();
    if (msg) throw new Error(`網站提示：${msg}`);
  }

  let lastAgreeClick = 0;
  function runConfirmPhase() {
    const cb = [...document.querySelectorAll('.el-checkbox')].find((c) => visible(c) && c.innerText.includes('我同意場地注意事項'));
    if (cb && !cb.classList.contains('is-checked') && Date.now() - lastAgreeClick > 2000) {
      lastAgreeClick = Date.now();
      cb.click();
    }
    const sms = [...document.querySelectorAll('input')].some((i) => visible(i) && i.placeholder === '請輸入簡訊驗證碼');
    setStatus(`本批 ${state.batch.length} 天：${state.batch.join('、')}\n`
      + `${sms ? '請按「發送簡訊驗證碼」並輸入驗證碼，' : ''}請等 Cloudflare 驗證完成，核對內容後按「確認申請」。`);
  }

  function handleComplete() {
    const no = (document.body.innerText.match(/訂單編號[\s:：]*([A-Za-z0-9-]+)/) || [])[1] || '（請到會員專區查看）';
    log(`申請成功 訂單 ${no}：${state.batch.join(', ')}`);
    state.done.push(...state.batch);
    state.batch = [];
    state.phase = 'select';
    save();
    if (state.running && state.queue.length) {
      setStatus('3 秒後開始下一批…');
      setTimeout(() => { location.href = ORDER_URL; }, 3000);
    } else {
      state.running = false;
      save();
      setStatus('全部處理完畢。申請需經審核，通過後到會員專區「租借紀錄」繳費。');
    }
  }

  let busy = false;
  let completedHandled = false;
  let confirmLost = 0;
  async function tick() {
    if (busy || !state.running) return;
    busy = true;
    try {
      const text = document.body.innerText;
      if (state.phase === 'confirm' && text.includes('租借申請完成')) {
        if (!completedHandled) { completedHandled = true; handleComplete(); }
      } else if (state.phase === 'confirm' && findButton('確認申請')) {
        confirmLost = 0;
        runConfirmPhase();
      } else if (state.phase === 'confirm' && ++confirmLost > 60) {
        // 送出前離開了確認頁（例如按了返回）：這批日期放回佇列，重新勾選
        confirmLost = 0;
        state.phase = 'select';
        log('已離開確認頁，這批日期稍後重新勾選');
      } else if (messageBox()?.innerText.includes('請先登入')) {
        setStatus('請先登入（輸入驗證碼並按登入），登入後會自動繼續。');
      } else if (location.pathname.startsWith('/login')) {
        setStatus('請登入，登入後會自動繼續。');
      } else if (state.phase === 'select' && location.pathname === '/order' && document.getElementById(`tab-${CONFIG.id3rd}`)) {
        completedHandled = false;
        await runSelectPhase();
      } else if (state.phase === 'select' && !(location.pathname === '/order' && location.search.includes(`id2nd=${CONFIG.id2nd}`))) {
        location.href = ORDER_URL;
      }
    } catch (e) {
      state.running = false;
      log(`錯誤：${e.message}`);
      setStatus('已暫停。修正問題後按「開始」接續。');
    } finally {
      busy = false;
    }
  }
  setInterval(tick, 1000);
})();
