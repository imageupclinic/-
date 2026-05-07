const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const fs = require('fs');

const TARGET_URL = process.env.TARGET_URL || 'https://www.imageup.co.kr';
const TIMEOUT_MS = 10000;

// 크롤러 차단이 알려진 도메인 (확인 불가로 처리)
const BLOCKED_DOMAINS = ['instagram.com', 'facebook.com', 'blog.naver.com', 'cafe.naver.com'];

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)',
    },
    maxRedirects: 5,
  });
  return response.data;
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim() || '(텍스트 없음)';

    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    let fullUrl = href;
    if (href.startsWith('/')) {
      const base = new URL(baseUrl);
      fullUrl = `${base.protocol}//${base.host}${href}`;
    } else if (!href.startsWith('http')) {
      fullUrl = `${baseUrl.replace(/\/$/, '')}/${href}`;
    }

    if (!links.find(l => l.url === fullUrl)) {
      links.push({ url: fullUrl, text });
    }
  });

  return links;
}

async function checkLink(link) {
  const isBlocked = BLOCKED_DOMAINS.some(d => link.url.includes(d));
  if (isBlocked) {
    return { ...link, status: 0, statusText: '확인불가 (크롤러 차단)', ok: null };
  }

  try {
    const res = await axios.head(link.url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const ok = res.status >= 200 && res.status < 400;
    return { ...link, status: res.status, statusText: res.statusText || '', ok };
  } catch (err) {
    return { ...link, status: 0, statusText: `오류: ${err.message}`, ok: false };
  }
}

function buildEmailHtml(results, checkedAt) {
  const errors = results.filter(r => r.ok === false);
  const ok = results.filter(r => r.ok === true);
  const unknown = results.filter(r => r.ok === null);

  const statusColor = errors.length > 0 ? '#e53935' : '#43a047';
  const statusText = errors.length > 0 ? `⚠️ 오류 ${errors.length}개 발견` : '✅ 모든 링크 정상';

  const rowStyle = 'padding: 8px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px;';
  const badgeOk = 'background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:12px;font-size:11px;';
  const badgeErr = 'background:#ffebee;color:#c62828;padding:2px 8px;border-radius:12px;font-size:11px;';
  const badgeUnk = 'background:#f5f5f5;color:#757575;padding:2px 8px;border-radius:12px;font-size:11px;';

  const renderRows = (list) => list.map(r => `
    <tr>
      <td style="${rowStyle}"><span style="${r.ok === true ? badgeOk : r.ok === false ? badgeErr : badgeUnk}">${r.ok === true ? r.status + ' OK' : r.ok === false ? r.status || 'ERR' : '확인불가'}</span></td>
      <td style="${rowStyle}">${r.text}</td>
      <td style="${rowStyle}"><a href="${r.url}" style="color:#1976d2;">${r.url}</a></td>
      <td style="${rowStyle};color:#888;">${r.statusText}</td>
    </tr>`).join('');

  return `
  <div style="font-family:sans-serif;max-width:700px;margin:0 auto;">
    <div style="background:${statusColor};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:18px;">${statusText}</h2>
      <p style="margin:4px 0 0;font-size:13px;opacity:.85;">${TARGET_URL} · ${checkedAt}</p>
    </div>
    <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;padding:16px 20px;">
      <p style="margin:0 0 12px;font-size:13px;color:#555;">
        전체 <strong>${results.length}</strong>개 · 정상 <strong style="color:#2e7d32">${ok.length}</strong> · 오류 <strong style="color:#c62828">${errors.length}</strong> · 확인불가 <strong style="color:#757575">${unknown.length}</strong>
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">상태</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">링크 텍스트</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">URL</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">상태 메시지</th>
          </tr>
        </thead>
        <tbody>
          ${renderRows([...errors, ...ok, ...unknown])}
        </tbody>
      </table>
    </div>
    <p style="font-size:11px;color:#aaa;margin-top:8px;">GitHub Actions · Weekly Link Checker</p>
  </div>`;
}

async function sendEmail(subject, html) {
  if (!process.env.SMTP_HOST) {
    console.log('📧 SMTP 설정 없음 — 이메일 발송 건너뜀');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject,
    html,
  });
  console.log('📧 이메일 발송 완료');
}

(async () => {
  console.log(`🔍 링크 체크 시작: ${TARGET_URL}`);
  const checkedAt = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  let html;
  try {
    html = await fetchPage(TARGET_URL);
  } catch (err) {
    console.error('❌ 페이지 로드 실패:', err.message);
    process.exit(1);
  }

  const links = extractLinks(html, TARGET_URL);
  console.log(`📄 링크 ${links.length}개 발견`);

  const results = await Promise.all(links.map(checkLink));

  results.forEach(r => {
    const icon = r.ok === true ? '✅' : r.ok === false ? '❌' : '⚪';
    console.log(`${icon} [${r.status || '-'}] ${r.url}`);
  });

  // 리포트 저장
  fs.writeFileSync('report.json', JSON.stringify({ checkedAt, target: TARGET_URL, results }, null, 2));
  console.log('💾 report.json 저장 완료');

  // 이메일 발송
  const errors = results.filter(r => r.ok === false);
  const subject = errors.length > 0
    ? `⚠️ [링크 체커] ${TARGET_URL} — 오류 ${errors.length}개 발견 (${checkedAt})`
    : `✅ [링크 체커] ${TARGET_URL} — 모든 링크 정상 (${checkedAt})`;

  await sendEmail(subject, buildEmailHtml(results, checkedAt));

  if (errors.length > 0) {
    console.error(`\n❌ 오류 링크 ${errors.length}개 발견`);
    process.exit(1); // GitHub Actions에서 실패로 표시
  } else {
    console.log('\n✅ 모든 링크 정상!');
  }
})();
