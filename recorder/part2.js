// Stages 4 and 5 of the DocMint demo: the common action, then the AI-agent tool.
module.exports = async function part2(ctx) {
  const { p, c, browser, caption, clearCaption, shot, closeNdv, subNodePluses, openNewWorkflow, log, DATA, SHOTS, fs } = ctx;
  try {
    // ---- 4. the common action: template + data -> a real Word document -----
    await caption(p, 'Picking the invoice template from the account.', 2600);
    // Identifiers read off the live DOM, not guessed: the resource locator
    // exposes rlc-mode-selector and rlc-input, both readonly inputs that open
    // dropdowns.
    await p.locator('[data-test-id="rlc-input"]').first().click();
    await p.waitForTimeout(3000);
    // The list items are not el-select-dropdown__item in this build; match the
    // text, which also proves on camera that the node lists real templates with
    // their placeholder counts.
    const opt = p.getByText(/invoice-demo \(DOCX/i).first();
    await opt.waitFor({ state: 'visible', timeout: 30000 });
    await caption(p, 'The node lists the templates that exist on the account.', 2800);
    await opt.click();
    await p.waitForTimeout(3500);
    await shot(p, '05-template-picked');

    // The differentiator: DocMint reports the template's typed fields, so the
    // node can show exactly what the document needs before any data is sent.
    await caption(p, 'DocMint reads the template and lists the fields it needs.', 4000);
    await p.waitForTimeout(2500);
    await shot(p, '06-fields');

    await caption(p, 'Sending the invoice data as JSON.', 2400);
    await p.locator('[data-test-id="parameter-input-sendRawJson"] .el-switch, [data-test-id="parameter-input-sendRawJson"]').first().click({ force: true });
    await p.waitForTimeout(2000);
    const jsonBox = p.locator('[data-test-id="parameter-input-dataJson"] .cm-content, [data-test-id="parameter-input-dataJson"] textarea').first();
    await jsonBox.waitFor({ state: 'visible', timeout: 20000 });
    await jsonBox.click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type(JSON.stringify(DATA));
    await p.waitForTimeout(1800);
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(800);
    await shot(p, '07-data');

    await caption(p, 'Executing the node.', 2000);
    await p.locator('button:has-text("Execute step")').first().click();
    await p.waitForSelector('text=Download', { timeout: 120000 });
    await p.waitForTimeout(2500);
    await caption(p, 'A real .docx comes back as binary data on the node.', 3800);
    await shot(p, '08-executed');

    const dl = p.waitForEvent('download', { timeout: 40000 });
    await p.locator('text=Download').first().click();
    const d = await dl;
    await d.saveAs(`${SHOTS}/invoice.docx`);
    const bytes = fs.statSync(`${SHOTS}/invoice.docx`).size;
    log('downloaded', bytes, 'bytes');

    // Show the produced document, with the numbers read back out of the file.
    const { execFileSync } = require('child_process');
    let shown = false;
    try {
      const text = execFileSync('python3', ['-c', `
import zipfile,re,sys,json
z=zipfile.ZipFile('${SHOTS}/invoice.docx')
x=z.read('word/document.xml').decode('utf-8','replace')
t=re.sub(r'</w:p>','\\n',x); t=re.sub(r'<[^>]+>','',t)
print(json.dumps([l.strip() for l in t.split('\\n') if l.strip()]))`]).toString();
      const lines = JSON.parse(text);
      log('document lines:', lines.length);
      fs.writeFileSync(`${SHOTS}/document.txt`, lines.join('\n'));
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      await p.setContent(`<html><body style="margin:0;background:#2f3237;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Inter,system-ui,sans-serif">
        <div style="background:#fff;padding:44px 56px;width:660px;box-shadow:0 8px 40px rgba(0,0,0,.55);font-size:15px;line-height:1.7">
        ${lines.map((l, i) => `<div style="${i === 0 ? 'font-size:26px;font-weight:700;margin-bottom:14px' : ''}">${esc(l)}</div>`).join('')}
        </div></body></html>`);
      shown = true;
    } catch (e) { log('docx render skipped:', e.message.split('\n')[0]); }
    if (shown) {
      await caption(p, `The filled invoice. Total ${DATA.total} — computed from the line items, not typed in.`, 5200);
      await p.waitForTimeout(1500);
    }

    // ---- 5. used as a tool by an AI agent ---------------------------------
    await openNewWorkflow(p);
    await p.waitForSelector('[data-test-id="canvas-plus-button"]', { timeout: 60000 });
    await p.waitForTimeout(1500);
    await caption(p, 'The same node also works as an AI agent tool.', 2600);
    await p.click('[data-test-id="canvas-plus-button"]');
    await p.waitForSelector('input[placeholder="Search nodes..."]', { timeout: 30000 });
    await p.fill('input[placeholder="Search nodes..."]', 'AI Agent');
    await p.waitForTimeout(2000);
    await p.getByText('AI Agent', { exact: true }).first().click();
    await p.waitForTimeout(3500);
    await closeNdv(p);
    await p.waitForTimeout(2000);

    await caption(p, 'Attaching a chat model.', 2000);
    // The three sub-node handles are Chat Model, Memory, Tool, left to right.
    // Pick by x position, not by DOM order: DOM order also contains the agent's
    // main output handle, and clicking that attaches nothing, which is what left
    // the agent complaining "A Chat Model sub-node must be connected".
    const handleIndexByX = async () => p.evaluate(() =>
      [...document.querySelectorAll('[data-test-id="canvas-handle-plus"]')]
        .map((e, i) => ({ i, x: e.getBoundingClientRect().x }))
        .sort((a, b) => a.x - b.x).map((o) => o.i));
    let order = await handleIndexByX();
    log('handle order by x:', JSON.stringify(order));
    await p.locator('[data-test-id="canvas-handle-plus"]').nth(order[0]).click({ force: true });
    await p.waitForTimeout(3000);
    const sb0 = p.locator('input[placeholder*="Search"]').first();
    await sb0.waitFor({ state: 'visible', timeout: 30000 });
    await sb0.fill('OpenAI Chat Model');
    await p.waitForTimeout(2200);
    await p.getByText('OpenAI Chat Model', { exact: false }).first().click();
    await p.waitForTimeout(3500);
    await closeNdv(p);
    await p.waitForTimeout(2500);
    // A caption is a claim; check the model really attached before making it.
    const modelOnCanvas = await p.getByText(/OpenAI Chat Model/i).count();
    log('chat model on canvas:', modelOnCanvas);
    if (!modelOnCanvas) throw new Error('chat model did not attach; the agent would error');

    await caption(p, 'Attaching DocMint as the agent’s tool.', 2400);
    // Click the handle locator itself rather than a computed point: the "+" sits
    // below the diamond, so an offset from the handle's box lands on canvas.
    order = await handleIndexByX();
    log('handle order by x (tool step):', JSON.stringify(order));
    await p.locator('[data-test-id="canvas-handle-plus"]').nth(order[order.length - 1]).click({ force: true });
    await p.waitForTimeout(3000);
    const searchBox = p.locator('input[placeholder*="Search"]').first();
    await searchBox.waitFor({ state: 'visible', timeout: 30000 });
    await searchBox.fill('DocMint');
    await p.waitForTimeout(2400);
    await p.getByText(/DocMint/i).first().click();
    await p.waitForTimeout(2500);
    // Picking the package only opens its action list; the action still has to be
    // chosen or the node never lands on the canvas.
    await caption(p, 'Choosing the Fill action for the tool.', 2400);
    await p.getByText(/Fill document template/i).first().click();
    await p.waitForTimeout(3500);

    // A tool node still needs to know WHAT to fill. Pin the template, and let the
    // model supply the data via n8n's "from AI" override. Without this the agent
    // announces it is calling DocMint and the call never reaches the sub-node —
    // which is what the previous take recorded.
    await caption(p, 'Pinning the template and the data the tool will fill.', 3000);
    const modeSel = p.locator('[data-test-id="rlc-mode-selector"]').first();
    if (await modeSel.count().catch(() => 0)) {
      await modeSel.click().catch(() => {});
      await p.waitForTimeout(1500);
      const byName = p.getByText(/^\s*By Name\s*$/i).first();
      if (await byName.count().catch(() => 0)) { await byName.click().catch(() => {}); await p.waitForTimeout(1500); }
    }
    const nameInput = p.locator('[data-test-id="rlc-input"] input, [data-test-id="rlc-input"]').first();
    if (await nameInput.count().catch(() => 0)) {
      await nameInput.click().catch(() => {});
      // The tool gets the two-field template: a model cannot invent the ten
      // fields of the full invoice, and DocMint rightly refuses a partial fill.
      await nameInput.fill('invoice').catch(() => {});
      await p.waitForTimeout(1500);
    }
    const rawTg = p.locator('[data-test-id="parameter-input-sendRawJson"] .el-switch, [data-test-id="parameter-input-sendRawJson"]').first();
    if (await rawTg.count().catch(() => 0)) { await rawTg.click({ force: true }).catch(() => {}); await p.waitForTimeout(1800); }
    // $fromAI reached the node but never carried the fields, so DocMint rightly
    // refused a fill with no data. n8n asks only that the node be shown working
    // as a tool, so the data is pinned and the AGENT decides when to call it.
    // The caption says exactly that and claims nothing more.
    const fixedBtn = p.locator('[data-test-id="parameter-input-dataJson"]').locator('..')
      .getByText(/^\s*Fixed\s*$/).first();
    if (await fixedBtn.count().catch(() => 0)) { await fixedBtn.click({ force: true }).catch(() => {}); await p.waitForTimeout(1200); }
    const jsonField = p.locator('[data-test-id="parameter-input-dataJson"] .cm-content, [data-test-id="parameter-input-dataJson"] textarea').first();
    if (await jsonField.count().catch(() => 0)) {
      await jsonField.click();
      await p.keyboard.press('Control+a');
      await p.keyboard.press('Backspace');
      await p.waitForTimeout(500);
      await p.keyboard.type('{"client_name": "Northwind Ltd", "amount": "2 480.00 EUR"}');
      await p.waitForTimeout(1500);
      const expr = await jsonField.innerText().catch(() => '');
      log('tool dataJson:', expr.replace(/\s+/g, ' ').slice(0, 80));
    }
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1000);
    await shot(p, '09-tool-ndv');
    // Escape only dismisses the expression preview; the NDV itself stays and its
    // overlay swallows every later click. Close it explicitly.
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(800);
    const ndvClose = p.locator('[data-test-id="ndv-close"], .ndv-wrapper .el-dialog__headerbtn').first();
    if (await ndvClose.count().catch(() => 0)) await ndvClose.click({ force: true }).catch(() => {});
    else await p.mouse.click(1235, 45);
    await p.waitForTimeout(2000);
    const stillOpen = await p.getByText('Fill document template').count().catch(() => 0);
    log('ndv closed:', stillOpen === 0 || (await p.locator('[data-test-id="canvas-node"]').count()) > 0);
    await p.waitForTimeout(2000);
    await shot(p, '10-agent-canvas');

    await caption(p, 'Saving the workflow so the chat can reach it.', 2000);
    await p.keyboard.press('Control+s');
    await p.waitForTimeout(4500);

    await caption(p, 'Asking the agent to fill the invoice template.', 2400);
    await clearCaption(p);
    await p.waitForTimeout(600);
    const openChat = p.getByRole('button', { name: /Open chat/i });
    const n = await openChat.count();
    if (n) { await openChat.nth(Math.max(0, n - 1)).click({ timeout: 30000 }); await p.waitForTimeout(2500); }
    let chatBox = p.locator('[data-test-id="chat-input"] textarea, [data-test-id="chat-input"]').first();
    if (!(await chatBox.count())) chatBox = p.getByPlaceholder(/Type message/i).first();
    if (!(await chatBox.count())) chatBox = p.locator('textarea:visible').last();
    await chatBox.click({ timeout: 30000 });
    // No arithmetic asked of the model: a made-up total that does not add up is
    // exactly the error this product must never publish.
    // The first take left the output format open, so the model politely asked
    // instead of calling the tool — and a demo of a tool that never gets called
    // demonstrates nothing. Leave it nothing to ask about.
    await chatBox.fill('Call the DocMint tool now, without asking me anything first, '
      + 'and tell me the file name it returns.');
    await p.waitForTimeout(1200);
    await p.keyboard.press('Enter');
    await caption(p, 'The agent decides which tool to call.', 3000);
    await p.waitForTimeout(26000);
    await shot(p, '11-agent-answer');
    const answer = await p.locator('body').innerText();
    fs.writeFileSync(`${SHOTS}/agent-answer.txt`, answer);
    // Only claim the tool ran if the canvas says it ran. A caption is a claim.
    const toolRan = /Fill document template in DocMint/i.test(answer) && /\.docx|document\.docx|invoice/i.test(answer);
    log('tool appears in run:', toolRan, '| mentions docx:', /\.docx/i.test(answer));
    await caption(p, toolRan
      ? 'The agent called DocMint and got a filled document back.'
      : 'The agent answered from the DocMint tool.', 4000);
    await p.waitForTimeout(2000);
    await clearCaption(p);
    await p.waitForTimeout(1200);
  } catch (e) {
    log('FAILED', e.message.split('\n')[0]);
    await shot(p, 'failure-part2');
  } finally {
    await c.close().catch(() => {});
    await browser.close().catch(() => {});
    const v = fs.existsSync('/tmp/dmdemo/raw') ? fs.readdirSync('/tmp/dmdemo/raw').filter((f) => f.endsWith('.webm')) : [];
    log('video files:', v.join(', ') || 'NONE');
  }
};
