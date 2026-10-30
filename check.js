// 查空檔（不需登入）：node check.js
// 列出 config.js 指定的每個日期與時段是否可預約，以及場地目前開放預約到哪個月份。
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// 該網站伺服器沒有送出 ZeroSSL 中繼憑證，這裡補上（仍保留完整的憑證驗證）
const ca = [...tls.rootCertificates, fs.readFileSync(path.join(__dirname, 'zerossl-intermediate.pem'), 'utf8')];
const API = 'https://api.preordervenue.com';

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method, ca,
      headers: { 'Content-Type': 'application/json', ...(data && { 'Content-Length': Buffer.byteLength(data) }) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${url}: ${buf.slice(0, 200)}`));
        resolve(JSON.parse(buf));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push([y, m]);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

(async () => {
  const detail = await request('GET', `${API}/api/Venues/2nd/Detail?id=${cfg.id2nd}`);
  const v3 = detail.venues3rd.find((v) => v.id === cfg.id3rd);
  const openTo = `${v3.openYearTo}-${String(v3.openMonthTo).padStart(2, '0')}`;
  console.log(`${detail.nameCH1st} ${v3.nameCH}`);
  console.log(`目前開放預約期間：${v3.openYearFrom}-${String(v3.openMonthFrom).padStart(2, '0')} ~ ${openTo}\n`);

  const rows = [];
  for (const [year, month] of months(cfg.from, cfg.to)) {
    rows.push(...await request('POST', `${API}/api/Order/Member/Schedule`, { id3rd: cfg.id3rd, year, month, ty: cfg.ty }));
  }

  const want = rows
    .filter((r) => {
      const d = r.date.slice(0, 10);
      return d >= cfg.from && d <= cfg.to && new Date(d + 'T00:00:00').getDay() === cfg.weekday && cfg.hours.includes(r.hour);
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);

  const byDate = new Map();
  for (const r of want) {
    const d = r.date.slice(0, 10);
    const ok = r.isOrderAble && !r.isExpired && !r.eventName;
    const status = !ok ? (r.eventName || (r.isExpired ? '已過期' : '不開放')) : d.slice(0, 7) > openTo ? '空（尚未開放預約）' : '可預約';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(`${r.hour}:00 ${status}`);
  }
  let bookable = 0;
  for (const [d, list] of byDate) {
    console.log(d, ' | ', list.join(' | '));
    bookable += list.filter((s) => s.endsWith('可預約')).length;
  }
  console.log(`\n共 ${byDate.size} 天；現在就能預約的時段：${bookable} 小時`);
})().catch((e) => { console.error('錯誤：', e.message); process.exit(1); });
