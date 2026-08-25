// DocMint demo recording for n8n's manual:awaiting-video stage.
//
// n8n's own checklist, read off the portal rather than guessed:
//   1. install the node from npm, the same version submitted (0.1.0)
//   2. new workflow, insert the node
//   3. set up a credential AND SHOW THE CREDENTIAL TEST PASSING
//   4. demonstrate the most common actions
//   5. show it used as a tool by an AI agent
// No cuts. Playwright records the context, so the file is continuous by
// construction.
const { chromium } = require('/home/flori/Dev/pdfnode/pdfmint-api/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const N8N   = 'http://localhost:5695';
const EMAIL = 'demo@docmint.dev';
const PASS  = 'DocMintDemo2026';
const KEY   = fs.readFileSync('/tmp/docmint-key.txt', 'utf8').trim();
const OPENAI = process.env.OPENAI_API_KEY;
const SHOTS = '/tmp/dmdemo/shots';
const VIDEO = '/tmp/dmdemo/raw';
const DATA  = JSON.parse(fs.readFileSync('/tmp/dmdemo/data.json', 'utf8'));
const log = (...a) => console.log('[dm]', ...a);
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(VIDEO, { recursive: true });

async function caption(p, text, ms = 2400) {
  await p.evaluate((t) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div'); el.id = '__cap';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
        + 'background:rgba(10,12,14,.93);color:#fff;font:600 19px/1.45 Inter,system-ui,sans-serif;'
        + 'padding:15px 26px;text-align:center;letter-spacing:.1px';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text).catch(() => {});
  await p.waitForTimeout(ms);
}
async function clearCaption(p) {
  await p.evaluate(() => { const e = document.getElementById('__cap'); if (e) e.remove(); }).catch(() => {});
}
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` }).catch(() => {});

async function ensureLoggedIn(p) {
  await p.goto(N8N, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const body = await p.locator('body').innerText().catch(() => '');
  if (/Set up owner account|Get started/i.test(body)) {
    await p.locator('input[type=email], input[name=email]').first().fill(EMAIL);
    const names = p.locator('input[type=text]');
    if (await names.count() >= 2) { await names.nth(0).fill('Doc'); await names.nth(1).fill('Mint'); }
    await p.locator('input[type=password]').first().fill(PASS);
    await p.locator('button[type=submit], [data-test-id="form-submit-button"]').first().click();
    await p.waitForTimeout(6000);
  } else if (/Sign in/i.test(body)) {
    await p.locator('input[type=email], input[name=email]').first().fill(EMAIL);
    await p.locator('input[type=password]').first().fill(PASS);
    await p.click('[data-test-id="form-submit-button"]');
    await p.waitForTimeout(5000);
  }
  for (const sel of ['text=/Skip|Get started|Continue|Later/i']) {
    const b = p.locator(sel).first();
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); await p.waitForTimeout(1500); }
  }
}
async function openNewWorkflow(p) {
  await p.goto(`${N8N}/workflow/new`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
}
async function closeNdv(p) {
  const back = p.locator('[data-test-id="back-to-canvas"]').first();
  if (await back.count().catch(() => 0)) { await back.click().catch(() => {}); await p.waitForTimeout(1200); return 'back'; }
  await p.keyboard.press('Escape'); await p.waitForTimeout(1200); return 'esc';
}
async function subNodePluses(p) {
  return p.evaluate(() => [...document.querySelectorAll('[data-test-id="canvas-handle-plus"]')]
    .map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })
    .sort((a, b) => a.x - b.x));
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  // Owner account + OpenAI credential are set up off-camera; the video starts
  // from a logged-in, node-free n8n, which is what the checklist asks for.
  const setup = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const sp = await setup.newPage();
  await ensureLoggedIn(sp);
  if (OPENAI) {
    const r = await sp.evaluate(async (apiKey) => {
      const bid = localStorage.getItem('n8n-browserId') || '';
      const res = await fetch('/rest/credentials', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'browser-id': bid },
        body: JSON.stringify({ name: 'OpenAi account', type: 'openAiApi', data: { apiKey } }) });
      return res.status;
    }, OPENAI);
    log('openai credential status', r);
  }
  await setup.close();

  const c = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEO, size: { width: 1280, height: 720 } },
  });
  const p = await c.newPage();

  try {
    await ensureLoggedIn(p);
    log('logged in at', p.url());

    // ---- 1. install from npm ------------------------------------------------
    await p.goto(`${N8N}/settings/community-nodes`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3500);
    await caption(p, 'A fresh n8n with no community nodes installed.', 2600);
    await shot(p, '01-empty');
    await p.locator('button:has-text("Install a community node"), button:has-text("Install")').first().click();
    await p.waitForTimeout(1500);
    await caption(p, 'Installing n8n-nodes-docmint 0.1.0 from npm — the version submitted.', 2800);
    await p.locator('input[placeholder*="n8n-nodes"], .el-dialog input[type=text]').first().fill('n8n-nodes-docmint');
    await p.waitForTimeout(900);
    // The risks checkbox gates the Install button. Tick it, then CHECK that
    // Install actually became enabled instead of assuming the click landed —
    // take one failed here because a selector matched a different element.
    const installBtn = () => p.locator('.el-dialog button, [role=dialog] button')
      .filter({ hasText: /^\s*Install\s*$/ }).last();
    for (const attempt of ['label', 'checkbox', 'coords']) {
      if (!(await installBtn().isDisabled().catch(() => true))) break;
      if (attempt === 'label') await p.getByText(/I understand the risks/i).first().click({ force: true }).catch(() => {});
      if (attempt === 'checkbox') await p.locator('input[type=checkbox]').first().click({ force: true }).catch(() => {});
      if (attempt === 'coords') {
        const box = await p.getByText(/I understand the risks/i).first().boundingBox().catch(() => null);
        if (box) await p.mouse.click(box.x - 14, box.y + 8);
      }
      await p.waitForTimeout(1200);
    }
    if (await installBtn().isDisabled().catch(() => true)) throw new Error('risks checkbox never ticked; Install still disabled');
    log('install enabled');
    await installBtn().click();
    await caption(p, 'Downloading from the public registry.', 2000);
    await p.waitForSelector('text=n8n-nodes-docmint', { timeout: 240000 });
    await p.waitForTimeout(2500);
    await caption(p, 'Installed.', 2200);
    await shot(p, '02-installed');
    log('installed');

    // ---- 2. workflow + node -------------------------------------------------
    await openNewWorkflow(p);
    await p.waitForSelector('[data-test-id="canvas-plus-button"]', { timeout: 60000 });
    await p.waitForTimeout(1500);
    await caption(p, 'A new workflow.', 1800);
    await p.click('[data-test-id="canvas-plus-button"]');
    await p.waitForSelector('input[placeholder="Search nodes..."]', { timeout: 30000 });
    await p.waitForTimeout(1200);
    await p.getByText('Trigger manually', { exact: true }).first().click();
    await p.waitForSelector('[data-test-id="canvas-handle-plus"]', { timeout: 30000 });
    await p.waitForTimeout(2000);

    await p.click('[data-test-id="canvas-handle-plus"]');
    await p.waitForSelector('input[placeholder="Search nodes..."]', { timeout: 30000 });
    await caption(p, 'Adding the DocMint node.', 2000);
    await p.fill('input[placeholder="Search nodes..."]', 'DocMint');
    await p.waitForTimeout(2200);
    // `text=` is Playwright syntax and cannot be mixed into a CSS selector list.
    let dmItem = p.locator('[data-test-id="node-creator-item-name"]').filter({ hasText: /DocMint/i }).first();
    if (!(await dmItem.count().catch(() => 0))) dmItem = p.getByText(/DocMint/i).first();
    await dmItem.click();
    await p.waitForTimeout(2500);
    await caption(p, 'Eleven actions across documents, templates and the account.', 3000);
    await shot(p, '02b-actions');
    // The action is "Fill document template" — an exact match on "Fill" finds nothing.
    await p.getByText(/Fill document template/i).first().click();
    await p.waitForTimeout(2500);
    await p.waitForSelector('[data-test-id="node-parameters"]', { timeout: 30000 });
    await p.waitForTimeout(2000);
    await shot(p, '03-node-added');

    // ---- 3. credential + the test result ON SCREEN --------------------------
    await caption(p, 'Creating the DocMint credential.', 2200);
    // This n8n labels it "Connect to DocMint", not "Set up credential".
    await p.getByText(/Connect to DocMint|Set up credential|Create new credential/i).first().click();
    const keyInput = p.locator('input[placeholder*="dm_live"], [data-test-id="parameter-input-apiKey"] input').first();
    await keyInput.waitFor({ state: 'visible', timeout: 45000 });
    await keyInput.fill(KEY);
    await p.waitForTimeout(1200);
    await caption(p, 'Saving. n8n calls the API to test the key.', 2400);
    await p.locator('[data-test-id="credential-save-button"]').click();
    await p.waitForTimeout(5000);
    await caption(p, 'Reopening the credential to show the connection test.', 2400);
    const pencil = p.locator('[data-test-id="credential-edit-button"], [data-test-id="edit-credential-button"]').first();
    if (await pencil.count()) await pencil.click();
    await p.waitForSelector('text=Connection tested successfully', { timeout: 60000 });
    await caption(p, 'Credential test passed: "Connection tested successfully".', 4500);
    await shot(p, '04-credential-tested');
    log('credential banner shown');
    const close = p.locator('[data-test-id="close-credential-modal"], .el-dialog__headerbtn').first();
    if (await close.count()) await close.click().catch(() => {});
    await p.waitForTimeout(2500);
    fs.writeFileSync('/tmp/dmdemo/.stage', 'credential-ok');
  } catch (e) {
    log('FAILED before stage 4:', e.message.split('\n')[0]);
    await shot(p, 'failure');
    await c.close().catch(() => {}); await browser.close().catch(() => {});
    process.exit(1);
  }
  // stage 4 and 5 live in part two so a failure there does not cost the whole take
  fs.writeFileSync('/tmp/dmdemo/.ctx', 'open');
  global.__keep = { browser, c, p };
  await require('/tmp/dmdemo/part2.js')({ p, c, browser, caption, clearCaption, shot, closeNdv, subNodePluses, openNewWorkflow, log, DATA, SHOTS, VIDEO, fs });
})();
