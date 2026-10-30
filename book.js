// 自動分批預約：node book.js
// 程式負責：登入時填帳號密碼、依每張單 10 個平日分批、勾選時段、填活動資料、勾同意事項、送出申請。
// 你負責：輸入登入驗證碼；若網站要求簡訊驗證碼或 Cloudflare 跳出需要點選的驗證，也由你在瀏覽器上操作。
// 登入狀態會保存在 browser-profile 資料夾，下次執行通常不必再登入。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cfg = require('./config');

const SITE = 'https://vbs.sports.gov.taipei';
const ORDER_URL = `${SITE}/order?id2nd=${cfg.id2nd}&ty=${cfg.ty}`;
const LOG = path.join(__dirname, 'orders-log.txt');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

function targetDates() {
  const out = [];
  for (let d = new Date(cfg.from + 'T00:00:00'); d <= new Date(cfg.to + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    if (d.getDay() === cfg.weekday) out.push(d.toLocaleDateString('sv-SE'));
  }
  return out;
}

// 已在 orders-log.txt 記錄為申請成功的日期，重跑時跳過
function bookedDates() {
  if (!fs.existsSync(LOG)) return new Set();
  const set = new Set();
  for (const line of fs.readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    if (line.includes('申請成功')) for (const d of line.match(/\d{4}-\d{2}-\d{2}/g) || []) set.add(d);
  }
  return set;
}

async function saveDebug(page, name) {
  const dir = path.join(__dirname, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
  console.error(`已存下畫面到 debug\\${name}.html / .png，可以傳給我協助修正。`);
}

// 網站跳出的提示框：記下內容後按確認關掉
async function dismissMessageBox(page) {
  const box = page.locator('.el-message-box:visible');
  if (!(await box.count())) return null;
  const text = (await box.locator('.el-message-box__message').innerText().catch(() => '')).trim();
  await box.locator('.el-message-box__btns button').last().click().catch(() => {});
  await box.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return text || '（網站跳出提示）';
}

async function login(page) {
  const { VBS_ACCOUNT, VBS_PASSWORD } = process.env;
  await page.goto(ORDER_URL);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '確認' }).click({ timeout: 3000 }).catch(() => {});
  if (!page.url().includes('/login')) return;
  await page.getByPlaceholder('請輸入電子信箱或統一編號').fill(VBS_ACCOUNT);
  await page.getByPlaceholder('請輸入密碼').fill(VBS_PASSWORD);
  await page.getByPlaceholder('請輸入驗證碼').focus();
  console.log('\n>>> 已填好帳號密碼。請在瀏覽器輸入驗證碼並按「登入」（最多等 5 分鐘）\n');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 5 * 60 * 1000 });
}

// ---------- 預約頁：勾選時段 ----------

async function selectMonth(page, ym) {
  const [y, m] = ym.split('-');
  if (await page.locator(`.calendar [data-date^="${ym}-"]`).count()) return true;
  const select = page.locator('.el-select').filter({ hasText: /\d{4}年\d{2}月/ }).first();
  await select.click();
  const option = page.locator('.el-select-dropdown__item:visible', { hasText: `${y}年${m}月` });
  if (!(await option.count())) {
    await page.keyboard.press('Escape');
    return false; // 這個月份還沒開放預約
  }
  await option.first().click();
  await page.locator(`.calendar [data-date^="${ym}-"]`).first().waitFor({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  return true;
}

async function selectSlots(page, dates) {
  const tab = page.locator(`#tab-${cfg.id3rd}`);
  await tab.waitFor({ timeout: 20000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await page.locator('.calendar').waitFor({ timeout: 20000 });
  await page.waitForLoadState('networkidle');

  const picked = new Set();
  const failed = [];
  for (const d of dates) {
    if (!(await selectMonth(page, d.slice(0, 7)))) {
      failed.push(`${d}：該月份尚未開放預約`);
      continue;
    }
    // 行事曆第一欄是時間軸，依序列出每一列代表的小時
    const hourRows = await page.locator('.calendar > div:first-child > div').evaluateAll((els) =>
      els.slice(1).map((el) => parseInt(el.textContent, 10)));

    for (const h of cfg.hours) {
      const tag = `${d} ${h}:00`;
      const row = hourRows.indexOf(h);
      const cell = page.locator(`.calendar [data-date="${d}"] > div:nth-child(${row + 2})`);
      const box = cell.locator('.box.selectable');
      if (row < 0 || !(await box.count())) {
        const why = row < 0 ? '' : (await cell.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        failed.push(`${tag}：不可預約${why ? `（${why}）` : ''}`);
        continue;
      }
      if (!/\bselected\b/.test((await box.getAttribute('class')) || '')) {
        await box.click();
        // 每勾一格網站都會向伺服器檢查一次，等它勾上或跳出提示
        const ok = await Promise.race([
          box.evaluate((el) => new Promise((res) => {
            const done = () => el.classList.contains('selected') && res(true);
            new MutationObserver(done).observe(el, { attributes: true });
            done();
          })),
          page.locator('.el-message-box:visible').waitFor({ timeout: 20000 }).then(() => false),
        ]).catch(() => false);
        const msg = await dismissMessageBox(page);
        await page.waitForLoadState('networkidle');
        if (!ok || msg) { failed.push(`${tag}：${msg || '勾選逾時'}`); console.log('  ✗', tag, msg || '勾選逾時'); continue; }
      }
      picked.add(d);
      console.log('  ✓', tag);
    }
  }
  return { picked: [...picked], failed };
}

async function unselectDate(page, d) {
  const boxes = page.locator(`.calendar [data-date="${d}"] .box.selectable.selected`);
  for (let i = 0; i < cfg.hours.length && (await boxes.count()); i++) {
    await boxes.first().click();
    await page.waitForLoadState('networkidle');
    await dismissMessageBox(page);
  }
}

// ---------- 預約頁：活動資料 ----------

function formItem(page, label) {
  return page.locator('.el-form-item').filter({
    has: page.locator('.el-form-item__label', { hasText: label }),
  }).first();
}

// 欄位可能是下拉選單或單選按鈕，兩種都處理
async function choose(page, label, optionText) {
  const item = formItem(page, label);
  if (!(await item.count())) return false;
  const select = item.locator('.el-select');
  if (await select.count()) {
    await select.first().click();
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: optionText }).first().click();
  } else {
    await item.getByText(optionText, { exact: true }).first().click();
  }
  return true;
}

async function fillText(page, label, value) {
  const item = formItem(page, label);
  if (!(await item.count())) return false;
  await item.locator('input, textarea').first().fill(String(value));
  return true;
}

async function fillForm(page) {
  const f = cfg.form;
  // 先填類別：其他欄位會依類別出現或隱藏
  if (!(await choose(page, '租借活動類別', f.type))) throw new Error('找不到「租借活動類別」欄位');
  await page.waitForTimeout(500);
  if (!(await choose(page, '減(免)徵(收)', f.deduct))) throw new Error('找不到「減免徵收」欄位');
  await choose(page, '是否售票', '否 ( No )');
  await choose(page, '盥洗設備', '不需要 ( No need )');
  await choose(page, '夜間照明設備', '不需要 ( No need )');
  if (!(await fillText(page, '活動名稱', f.eventName))) throw new Error('找不到「活動名稱」欄位');
  await fillText(page, '活動說明', f.eventDescription);
  if (!(await choose(page, '活動運動種類', f.sport))) throw new Error('找不到「活動運動種類」欄位');
  await fillText(page, '活動參與人數', f.peopleAll);
  await page.waitForLoadState('networkidle');
}

// ---------- 確認頁：同意事項、真人驗證、送出 ----------

async function confirmAndSubmit(page, batchDates) {
  // 預約頁按「直接申請租借」，若跳出「繼續選擇其他場地？」就選不需要
  await page.getByRole('button', { name: '直接申請租借' }).click();
  await page.getByRole('button', { name: '不需要，直接申請租借' }).click({ timeout: 5000 }).catch(() => {});
  const err = await dismissMessageBox(page);
  if (err) throw new Error(`網站提示：${err}`);
  await page.getByRole('button', { name: '確認申請' }).waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle');

  const agree = page.getByText('我同意場地注意事項');
  if (await agree.count()) {
    const cb = page.locator('.el-checkbox').filter({ hasText: '我同意場地注意事項' }).first();
    if (!/is-checked/.test((await cb.getAttribute('class')) || '')) await agree.first().click();
  }

  // 需要簡訊驗證時，由你按「發送簡訊驗證碼」並輸入
  const sms = page.getByPlaceholder('請輸入簡訊驗證碼');
  if (await sms.count()) {
    console.log('\n>>> 網站要求簡訊驗證：請在瀏覽器按「發送簡訊驗證碼」並輸入收到的 6 位數字（最多等 10 分鐘）');
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('input')].find((i) => i.placeholder === '請輸入簡訊驗證碼');
      return el && /^\d{6}$/.test(el.value);
    }, null, { timeout: 10 * 60 * 1000 });
  }

  // Cloudflare 真人驗證：一般會自動通過；若出現需要點選的方塊，請你點一下
  console.log('等待 Cloudflare 真人驗證完成…（若畫面出現需要點選的方塊，請點一下）');
  await page.waitForFunction(() => {
    const el = document.querySelector('#turnstile-container input[name="cf-turnstile-response"]');
    return el && el.value;
  }, null, { timeout: 10 * 60 * 1000 });

  if (cfg.confirmBeforeSubmit) {
    const total = (await page.getByText('總價').first().locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`\n即將送出：${batchDates.join('、')}  ${total}`);
    const a = await ask('請在瀏覽器核對內容，按 Enter 送出（輸入 n 再按 Enter 則跳過這張單）：');
    if (a.trim().toLowerCase() === 'n') return null;
  }

  await page.getByRole('button', { name: '確認申請' }).click();
  await Promise.race([
    page.getByText('租借申請完成').waitFor({ timeout: 60000 }),
    page.locator('.el-message-box:visible').waitFor({ timeout: 60000 }),
  ]);
  const msg = await dismissMessageBox(page);
  if (msg) throw new Error(`送出失敗：${msg}`);
  const body = await page.locator('body').innerText();
  return (body.match(/訂單編號[\s:：]*([A-Za-z0-9-]+)/) || [])[1] || '（請到會員專區查看）';
}

// ---------- 主流程 ----------

(async () => {
  loadEnv();
  if (!process.env.VBS_ACCOUNT || !process.env.VBS_PASSWORD) {
    console.error('請先複製 .env.example 為 .env，並填入 VBS_ACCOUNT 與 VBS_PASSWORD');
    process.exit(1);
  }

  const done = bookedDates();
  const todo = targetDates().filter((d) => !done.has(d));
  if (done.size) console.log(`orders-log.txt 中已有 ${done.size} 天申請成功，這次略過。`);
  if (!todo.length) { console.log('沒有需要申請的日期。'); return; }

  const opts = { headless: false, viewport: null, locale: 'zh-TW', args: ['--start-maximized'] };
  const profile = path.join(__dirname, 'browser-profile');
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, { ...opts, channel: 'msedge' }); // Windows 內建 Edge
  } catch {
    ctx = await chromium.launchPersistentContext(profile, opts);
  }
  const page = ctx.pages()[0] || (await ctx.newPage());

  await login(page);

  const summary = [];
  let queue = [...todo];
  let batchNo = 0;
  while (queue.length) {
    batchNo++;
    console.log(`\n===== 第 ${batchNo} 張申請單（剩 ${queue.length} 天待處理）=====`);
    await page.goto(ORDER_URL);
    await page.waitForLoadState('networkidle');
    if (page.url().includes('/login')) await login(page);

    // 依序嘗試日期，直到勾滿 10 天（勾不到的日期不佔名額）
    const batch = [];
    const failed = [];
    while (queue.length && batch.length < cfg.maxDaysPerOrder) {
      const d = queue.shift();
      const r = await selectSlots(page, [d]);
      if (r.picked.length && r.failed.length === 0) batch.push(d);
      else {
        failed.push(...r.failed);
        await unselectDate(page, d); // 只勾到部分時段的日期整天取消，不送出不完整的時段
      }
    }
    for (const f of failed) { console.log('  略過', f); summary.push(`略過 ${f}`); }
    if (!batch.length) break;

    try {
      await fillForm(page);
      const orderNo = await confirmAndSubmit(page, batch);
      const line = orderNo
        ? `${new Date().toLocaleString()} 申請成功 訂單 ${orderNo}：${batch.join(', ')}`
        : `${new Date().toLocaleString()} 使用者跳過：${batch.join(', ')}`;
      fs.appendFileSync(LOG, line + '\n');
      summary.push(line);
      console.log(line);
    } catch (e) {
      console.error(`\n第 ${batchNo} 張單失敗：${e.message}`);
      await saveDebug(page, `batch-${batchNo}`);
      summary.push(`失敗：${batch.join(', ')}（${e.message}）`);
      const a = await ask('要繼續處理下一批嗎？(Y/n) ');
      if (a.trim().toLowerCase() === 'n') break;
    }
  }

  console.log('\n===== 結果 =====');
  for (const s of summary) console.log(s);
  console.log(`\n紀錄已寫入 ${LOG}`);
  console.log('申請需經審核，通過後會寄 Email 通知，再到會員專區「租借紀錄」線上繳費。');
  console.log('關閉瀏覽器即可結束程式。');
  await new Promise((resolve) => ctx.on('close', resolve));
})().catch((e) => { console.error('錯誤：', e.message); process.exit(1); });
