// ╔══════════════════════════════════════════════════════╗
// ║     SmartBudget Pro — Google Apps Script Backend     ║
// ║     Gmail: vasanthdata07@gmail.com                   ║
// ╚══════════════════════════════════════════════════════╝

const SPREADSHEET_ID = "1MOGhhAngqlS9YnAYYFuXfblNPk-PV160OyA0n-m8pq4";

const S_USERS = 'Users';
const S_DATA  = 'BudgetData';
const S_OTP   = 'OTPStore';
const S_BILLS = 'Bills';
const S_SESS  = 'Sessions';

const OTP_TTL          = 10 * 60 * 1000;
const OTP_COOLDOWN_SEC = 60;
const SESSION_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSS() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet(name) {
  const ss = getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

// ══════════════════════════════
// MAIN ROUTER
// ══════════════════════════════
function doGet(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const action = p.action || '';

    if (action === 'ping')      return ok({ status: 'connected', time: new Date().toISOString() });
    if (action === 'sendOTP')   return sendOTP(p.email);
    if (action === 'verifyOTP') return verifyOTP(p.email, p.otp);
    if (action === 'loadData')  return loadData(p.email, p.token);
    if (action === 'loadBills') return loadBills(p.email, p.token);

    return ok({ success: true, status: 'SmartBudget API running' });
  } catch (ex) {
    return err('doGet error: ' + ex.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';

    if (action === 'saveMonth') return saveMonth(body.email, body.token, body.key, body.data);
    if (action === 'saveBills') return saveBills(body.email, body.token, body.bills);

    return err('Unknown action');
  } catch (ex) {
    return err('doPost error: ' + ex.message);
  }
}

// ══════════════════════════════
// OTP — SEND
// ══════════════════════════════
function sendOTP(email) {
  if (!email || !isEmail(email)) return err('Invalid email');
  email = email.toLowerCase().trim();

  if (!checkOTPCooldown(email))
    return err('Please wait 60 seconds before requesting OTP again');

  const otp    = String(Math.floor(100000 + Math.random() * 900000));
  const expiry = Date.now() + OTP_TTL;

  saveOTP(email, otp, expiry);

  try {
    GmailApp.sendEmail(
      email,
      'SmartBudget Pro — Your OTP Code',
      `Your OTP is: ${otp}\nValid for 10 minutes.`,
      { htmlBody: buildOTPEmail(otp), name: 'SmartBudget Pro' }
    );
    registerUser(email);
    return ok({ sent: true });
  } catch (ex) {
    return err('Email send failed: ' + ex.message);
  }
}

// ══════════════════════════════
// OTP — VERIFY
// ══════════════════════════════
function verifyOTP(email, otp) {
  if (!email || !otp) return err('Email and OTP required');
  email = email.toLowerCase().trim();

  const stored = getOTP(email);
  if (!stored)                            return err('No OTP found. Please request again.');
  if (Date.now() > stored.expiry)         return err('OTP expired. Please request again.');
  if (stored.otp !== String(otp).trim())  return err('Wrong OTP. Please try again.');

  clearOTP(email);
  const token = createSession(email);
  return ok({ verified: true, token: token, email: email });
}

// ══════════════════════════════
// DATA — LOAD
// ══════════════════════════════
function loadData(email, token) {
  if (!email || !token) return err('Auth required');
  email = email.toLowerCase().trim();
  if (!isValidToken(email, token)) return err('Session expired. Please login again.');

  const sheet = getSheet(S_DATA);
  if (sheet.getLastRow() < 2) return ok({ months: {} });

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const months = {};

  rows.forEach(r => {
    if (String(r[0]).toLowerCase() === email && r[1]) {
      try { months[r[1]] = JSON.parse(r[2]); } catch(e) {}
    }
  });

  return ok({ months });
}

// ══════════════════════════════
// DATA — SAVE
// ══════════════════════════════
function saveMonth(email, token, key, data) {
  if (!email || !token) return err('Auth required');
  email = email.toLowerCase().trim();
  if (!isValidToken(email, token)) return err('Session expired. Please login again.');
  if (!key || !data) return err('Missing fields');

  const sheet = getSheet(S_DATA);

  if (sheet.getLastRow() < 2) {
    sheet.appendRow(['Email', 'MonthKey', 'Data', 'Updated']);
  }

  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).toLowerCase() === email && rows[i][1] === key) {
        sheet.getRange(i + 2, 3).setValue(JSON.stringify(data));
        sheet.getRange(i + 2, 4).setValue(new Date());
        return ok({ saved: true, action: 'updated' });
      }
    }
  }

  sheet.appendRow([email, key, JSON.stringify(data), new Date()]);
  return ok({ saved: true, action: 'created' });
}

// ══════════════════════════════
// BILLS — LOAD
// ══════════════════════════════
function loadBills(email, token) {
  if (!email || !token) return err('Auth required');
  email = email.toLowerCase().trim();
  if (!isValidToken(email, token)) return err('Session expired. Please login again.');

  const sheet = getSheet(S_BILLS);
  if (sheet.getLastRow() < 2) return ok({ bills: [] });

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (const r of rows) {
    if (String(r[0]).toLowerCase() === email) {
      try { return ok({ bills: JSON.parse(r[1]) }); }
      catch(e) { return ok({ bills: [] }); }
    }
  }
  return ok({ bills: [] });
}

// ══════════════════════════════
// BILLS — SAVE
// ══════════════════════════════
function saveBills(email, token, bills) {
  if (!email || !token) return err('Auth required');
  email = email.toLowerCase().trim();
  if (!isValidToken(email, token)) return err('Session expired. Please login again.');

  const sheet = getSheet(S_BILLS);

  if (sheet.getLastRow() < 2) {
    sheet.appendRow(['Email', 'Bills', 'Updated']);
  }

  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    const idx = emails.findIndex(e => String(e).toLowerCase() === email);
    if (idx >= 0) {
      sheet.getRange(idx + 2, 2).setValue(JSON.stringify(bills));
      sheet.getRange(idx + 2, 3).setValue(new Date());
      return ok({ saved: true });
    }
  }

  sheet.appendRow([email, JSON.stringify(bills), new Date()]);
  return ok({ saved: true });
}

// ══════════════════════════════
// SESSION HELPERS
// ══════════════════════════════
function createSession(email) {
  const sheet = getSheet(S_SESS);
  sheet.hideSheet();

  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['Email', 'Token', 'Expiry', 'Created']);
  }

  const token  = Utilities.getUuid().replace(/-/g, '');
  const expiry = Date.now() + SESSION_TTL_MS;
  sheet.appendRow([email, token, expiry, new Date()]);
  return token;
}

function isValidToken(email, token) {
  const sheet = getSheet(S_SESS);
  if (sheet.getLastRow() < 2) return false;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (const r of rows) {
    if (String(r[0]) === email && String(r[1]) === token && Date.now() <= Number(r[2])) {
      return true;
    }
  }
  return false;
}

// ══════════════════════════════
// OTP HELPERS
// ══════════════════════════════
function saveOTP(email, otp, expiry) {
  const sheet = getSheet(S_OTP);
  sheet.hideSheet();

  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['Email', 'OTP', 'Expiry']);
  }

  // Remove old OTP for this email
  if (sheet.getLastRow() >= 2) {
    const emails = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
    const idx = emails.findIndex(e => String(e) === email);
    if (idx >= 0) sheet.deleteRow(idx + 2);
  }

  sheet.appendRow([email, otp, expiry]);
}

function getOTP(email) {
  const sheet = getSheet(S_OTP);
  if (sheet.getLastRow() < 2) return null;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (const r of rows) {
    if (String(r[0]) === email) return { otp: String(r[1]), expiry: Number(r[2]) };
  }
  return null;
}

function clearOTP(email) {
  const sheet = getSheet(S_OTP);
  if (sheet.getLastRow() < 2) return;

  const emails = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
  const idx = emails.findIndex(e => String(e) === email);
  if (idx >= 0) sheet.deleteRow(idx + 2);
}

function checkOTPCooldown(email) {
  const stored = getOTP(email);
  if (!stored) return true;
  const sentAt = stored.expiry - OTP_TTL;
  return (Date.now() - sentAt) > OTP_COOLDOWN_SEC * 1000;
}

// ══════════════════════════════
// USER REGISTRY
// ══════════════════════════════
function registerUser(email) {
  const sheet = getSheet(S_USERS);

  if (sheet.getLastRow() < 1) {
    sheet.appendRow(['Email', 'First Login', 'Last Login', 'Login Count']);
  }

  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    const idx = emails.findIndex(e => String(e).toLowerCase() === email);

    if (idx >= 0) {
      const r = idx + 2;
      const count = sheet.getRange(r, 4).getValue() || 0;
      sheet.getRange(r, 3).setValue(new Date());
      sheet.getRange(r, 4).setValue(count + 1);
      return;
    }
  }

  sheet.appendRow([email, new Date(), new Date(), 1]);
}

// ══════════════════════════════
// EMAIL TEMPLATE
// ══════════════════════════════
function buildOTPEmail(otp) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:400px;margin:auto;padding:30px;border-radius:12px;background:#f9f9f9;text-align:center">
    <h2 style="color:#6c63ff">💰 SmartBudget Pro</h2>
    <p style="color:#555">உங்கள் OTP Code:</p>
    <div style="font-size:42px;font-weight:bold;letter-spacing:8px;color:#6c63ff;padding:20px;background:#fff;border-radius:8px;margin:20px 0">${otp}</div>
    <p style="color:#888;font-size:13px">✅ 10 minutes மட்டும் valid<br>யாரிடமும் share பண்ணாதீங்க!</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="color:#aaa;font-size:11px">SmartBudget Pro — Personal Finance Tracker</p>
  </div>`;
}

// ══════════════════════════════
// UTILS
// ══════════════════════════════
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function ok(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
