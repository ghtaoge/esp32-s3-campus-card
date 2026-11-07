(function () {
  'use strict';
  const B = window.CampusBusiness, C = window.CampusCatalog, L = window.CampusLogs, M = window.CampusModel;
  const $ = id => document.getElementById(id);
  const esc = value => String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = { issue: '开卡', topup: '充值', spend: '消费' };
  const titles = { trade: ['业务办理', '每一笔刷卡，都清清楚楚。', '连接你的终端，管理卡片与模拟校园消费。'], logs: ['交易流水', '校园日常，有迹可循。', '完整读取设备保留的记录，按卡片、场景和结果查看。'], catalog: ['商品与档位', '把常用业务，放在手边。', '配置当前浏览器的商品、消费场景和充值档位。'], screen: ['屏幕与电源', '让小屏幕，恰到好处。', '实时预览布局，调整金额字号、动画、亮度与闲置行为。'], diagnostics: ['终端诊断', '看清终端的每个状态。', '检查连接、硬件状态和运行计数，安全续办原订单。'] };
  const app = { connected: false, busy: false, storageReady: true, mode: null, client: null, key: null, view: 'trade', kind: 'spend', state: {}, logs: [], loaded: false, diagnostics: {}, log: [], latency: null, settingsDirty: false, powerDirty: false };
  let storage, book, catalog, previewFrame = 0;
  function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  function errorText(error) {
    if (!error) return '';
    if (error.name === 'NotFoundError') return '已取消设备选择，可以重新连接。';
    if (error.name === 'SecurityError' || error.name === 'NotAllowedError') return '浏览器未允许连接，请从 localhost 打开并在设备选择窗口授权。';
    return error.message || String(error);
  }
  function failure(error) { const text = errorText(error); $('error').textContent = text; $('error').hidden = !text; }
  function diagnostic(text) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    app.log.push(`${time}  ${String(text).slice(0, 600)}`); app.log = app.log.slice(-80);
    $('diagnostic-log').textContent = app.log.join('\n') || '等待连接终端。';
  }
  try { storage = M.browserStorage(window.localStorage); book = new B.OperationBook(storage); catalog = C.loadCatalog(storage); }
  catch (error) { app.storageReady = false; catalog = C.defaultCatalog(); failure(new Error('浏览器本地存储不可用，暂时禁止创建交易。请检查浏览器设置。')); }
  const outstanding = () => book && app.key ? book.get(app.key) : null;
  async function act(action) {
    if (app.busy) return;
    app.busy = true; failure(null); render();
    try { return await action(); }
    catch (error) { failure(error); diagnostic(errorText(error)); }
    finally { app.busy = false; render(); }
  }
  async function request(body) {
    if (!app.client || !app.connected) throw new Error('请先连接终端');
    const started = performance.now(); const response = await app.client.request(body);
    app.latency = Math.round(performance.now() - started);
    diagnostic(`${{ state: '读取状态', arm: '提交业务', result: '核对原订单', logs: '读取流水', settings: '保存显示设置', power: '保存电源设置', wake: '唤醒屏幕', cancel: '取消等待', diagnostics: '读取运行诊断' }[body.op] || body.op} · ${app.latency} ms`);
    return response;
  }
  function applyState(state) {
    if (state.device) { app.state.device = state.device; app.key = M.deviceKey(state, app.client && app.client.label); }
    for (const key of ['card', 'pending', 'lastResult', 'settings', 'power']) if (Object.prototype.hasOwnProperty.call(state, key)) app.state[key] = state[key];
    if (state.result) app.state.lastResult = state.result;
    if (state.diagnostics) app.diagnostics = state.diagnostics;
    try { if (book && app.key) book.reconcile(app.key, state); }
    catch (_) { app.storageReady = false; failure(new Error('设备结果已收到，但本地订单标记保存失败。请重新打开并核对原订单。')); }
    if (state.ok === false) failure(new Error(state.message || state.code || '终端返回错误'));
    if (state.event === 'transaction' && state.lastResult) {
      notice(state.lastResult.message || '交易结果已更新');
      if (app.view === 'logs' && !app.busy) act(loadLogs);
    }
    if (state.settings && (!app.settingsDirty || state.op === 'settings')) {
      $('font-size').value = String(state.settings.fontSize); $('effect').value = state.settings.effect;
      $('hold-seconds').value = String(state.settings.holdMs / 1000); app.settingsDirty = false;
    }
    if (state.power && (!app.powerDirty || state.op === 'power')) {
      $('brightness').value = String(state.power.brightness); $('idle-seconds').value = String(state.power.idleSeconds); $('battery-mode').checked = !!state.power.batteryMode; app.powerDirty = false;
    }
    render(); drawPreview(0, false);
  }
  async function connect(mode) {
    return act(async () => {
      if (app.client) await app.client.disconnect();
      app.mode = mode; app.state = {}; app.key = null; app.logs = []; app.loaded = false; app.diagnostics = {}; app.settingsDirty = app.powerDirty = false;
      let client;
      const events = {
        onConnection(connected, label) { if (app.client !== client) return; app.connected = connected; diagnostic(connected ? `已连接：${label}` : '连接已关闭；未确认业务编号保留'); render(); },
        onState(state) { if (app.client === client) applyState(state); },
        onDiagnostic(text) { if (app.client === client) diagnostic(text); }
      };
      client = mode === 'demo' ? new window.CampusDemo.DemoClient(storage, events) : mode === 'usb' ? new window.CampusTransport.SerialClient(events) : new window.CampusTransport.BleClient(events);
      app.client = client;
      try {
        await client.connect(); await request({ op: 'state', unixTime: Math.floor(Date.now() / 1000) }); await reconcileOriginal(); await loadLogs();
        notice(mode === 'demo' ? '已进入演示设备。请选择卡片并点击“刷演示卡”完成业务。' : '终端已连接。待机刷卡只查询余额，充值和消费需要先提交业务。');
      } catch (error) { await client.disconnect(); throw error; }
    });
  }
  async function reconcileOriginal() {
    const entry = outstanding(); if (!entry) return;
    await request({ op: 'result', id: entry.id }); await request({ op: 'state', unixTime: Math.floor(Date.now() / 1000) });
    if (outstanding() && !app.state.pending) notice('设备暂未查到原订单。可继续核对，或手动重发同一编号的近期原订单。');
  }
  async function loadLogs() { if (!app.connected) throw new Error('请先连接终端'); app.logs = await L.loadAllLogs(request); app.loaded = true; renderLogs(); }
  function consumeExpired(response, id) {
    if (!response || response.code !== 'RESULT_EXPIRED' || !book || !app.key) return false;
    book.clear(app.key, id); failure(null); notice('原订单已处理，明细已过期，请刷卡查询余额；不会创建新编号重试。'); return true;
  }
  async function submitTrade(event) {
    event.preventDefault();
    if (!app.storageReady || !M.canTrade(app.state, outstanding(), app.busy, app.connected)) return;
    return act(async () => {
      const command = M.buildCommand(app.kind, { amount: $('amount').value, scene: $('scene').value, name: $('issue-name').value, studentNo: $('student-no').value });
      const entry = book.begin(app.key, command); render();
      try {
        const response = await request(Object.assign({}, command, { id: entry.id }));
        if (!consumeExpired(response, entry.id) && outstanding()) notice(`已提交${names[app.kind]}任务，请在 30 秒内刷卡。`);
      } catch (error) {
        if (consumeExpired(error.response, entry.id)) return;
        if (error.response && error.response.ok === false && (!error.response.pending || error.response.pending.id !== entry.id) && error.response.code !== 'UNCERTAIN') book.clear(app.key, entry.id);
        throw error;
      }
    });
  }
  async function resumeOriginal() {
    return act(async () => {
      const key = app.key, entry = outstanding(); if (!entry || app.state.pending) return;
      const command = B.originalCommand(entry); await reconcileOriginal(); if (!outstanding() || app.state.pending) return;
      const description = command.kind === 'issue' ? `${command.name}（${command.studentNo}）开卡` : `${names[command.kind]} ${B.money(command.amountCents)} 元 · ${command.scene}`;
      if (!window.confirm(`继续原订单：${description}\n\n将保留原编号和全部资料，仅续办刚才中断的业务。久未处理的订单请先核对余额和流水。`)) return;
      await reconcileOriginal(); if (!outstanding() || app.state.pending || app.key !== key) return;
      try { const response = await request(command); if (!consumeExpired(response, entry.id)) notice('已使用原编号续办，请重新刷卡。'); }
      catch (error) { if (!consumeExpired(error.response, entry.id)) throw error; }
    });
  }
  function render() {
    const state = app.state, device = state.device || {}, pending = state.pending, entry = outstanding();
    const blocked = !!(app.busy || pending || entry);
    $('connection-status').textContent = app.connected ? app.mode === 'demo' ? '演示设备已连接' : '终端已连接' : '未连接终端';
    $('connection-status').classList.toggle('connected', app.connected); $('device-dot').classList.toggle('online', app.connected);
    $('device-name').textContent = app.connected ? device.name || app.client.label : '连接你的 ESP32-S3';
    $('transport-description').textContent = app.connected ? `${app.client.label} · ${device.readerReady ? 'RC522 就绪' : 'RC522 未就绪'} · ${device.oledReady ? 'OLED 就绪' : 'OLED 未就绪'}` : '优先使用 USB，电池供电时可选蓝牙。';
    for (const id of ['connect-usb', 'connect-ble', 'connect-demo']) $(id).hidden = app.connected;
    $('disconnect').hidden = !app.connected;
    for (const id of ['connect-usb', 'connect-ble', 'connect-demo']) $(id).disabled = app.busy || !app.storageReady;
    $('refresh-state').disabled = !app.connected || app.busy;
    $('demo-banner').hidden = $('demo-diagnostics').hidden = !(app.connected && app.mode === 'demo');
    $('demo-scan').disabled = app.busy; if (app.mode === 'demo' && app.client) { $('demo-card').value = app.client.selected; $('demo-interrupt').checked = app.client.interruptNext; }
    const card = state.card;
    const balance = card ? B.money(card.balanceCents).split('.') : ['--', '--'];
    $('card-balance').innerHTML = `${esc(balance[0])}<span>.${esc(balance[1] || '--')}</span>`;
    $('card-owner').textContent = card ? card.name : '等待刷卡'; $('card-student').textContent = card ? `学号 ${card.studentNo || '未填写'}` : '待机刷卡只查询余额';
    $('card-number').textContent = card ? `NO. ${card.cardNo}` : 'S50 TEST CARD'; $('card-uid').textContent = card ? card.uid : '尚未读取';
    $('pending-panel').hidden = !(pending || entry);
    if (pending || entry) {
      const item = pending || entry; const uncertain = pending && pending.phase === 'uncertain';
      $('pending-title').textContent = uncertain ? '交易结果待核对' : pending ? `等待刷卡${names[item.kind] || ''}` : '原订单等待核对';
      $('pending-detail').textContent = uncertain ? '请移开后重新刷原卡。结果确认前，不能创建新交易。' : pending ? `${names[item.kind] || '交易'}${item.kind === 'issue' ? '' : ` ${B.money(item.amountCents)} 元`} · 约 30 秒内刷卡` : '连接中断不会创建新编号，请先核对原订单。';
      $('pending-id').textContent = item.id; $('cancel-pending').hidden = !(pending && pending.phase === 'waiting');
      $('resume-original').hidden = !(entry && !pending); $('query-original').disabled = $('cancel-pending').disabled = $('resume-original').disabled = !app.connected || app.busy;
    }
    $('submit-trade').disabled = !app.storageReady || !M.canTrade(state, entry, app.busy, app.connected);
    document.querySelectorAll('[data-kind],#trade-form input,.quick-option').forEach(element => { element.disabled = blocked; });
    $('trade-note').textContent = !app.connected ? '连接终端后办理业务；每个订单只会成功一次。' : device.storageReady === false ? '终端存储不可用，请先检查设备。' : pending || entry ? '请先完成或核对当前订单，再办理下一笔业务。' : '写卡后回读确认才显示成功，请保持卡片贴近读卡器。';
    $('refresh-logs').disabled = !app.connected || app.busy; $('export-csv').disabled = !filteredLogs().length;
    $('save-screen').disabled = !app.connected || app.busy;
    document.querySelectorAll('#screen-form input,#screen-form select,#power-form input').forEach(element => { element.disabled = app.busy; });
    const hasPower = !!(device.capabilities && device.capabilities.power);
    $('save-power').disabled = $('wake-screen').disabled = !app.connected || app.busy || !hasPower;
    $('power-capability').textContent = hasPower ? '电源配置保存在终端，闲置熄屏后刷卡可唤醒。' : '连接支持电源设置的新固件后可应用。';
    $('brightness-value').textContent = `${Math.round(Number($('brightness').value) / 255 * 100)}%`;
    const power = state.power || {};
    $('battery-reading').textContent = power.batteryMeasurement && Number.isFinite(power.batteryVoltage) ? `${power.batteryVoltage.toFixed(2)} V` : '电量采样未配置';
    renderReceipt(); renderDiagnostics(); renderLogs();
  }
  function renderReceipt() {
    const result = app.state.lastResult && B.decorateResult(app.state.lastResult);
    $('receipt-empty').hidden = !!result; $('receipt-content').hidden = !result;
    $('receipt-status').className = 'result-tag' + (result ? result.status === 'success' ? ' success' : result.status === 'uncertain' ? ' warning' : ' error' : '');
    $('receipt-status').textContent = result ? result.statusText : '等待交易'; if (!result) return;
    $('receipt-card').textContent = result.cardNo ? `NO. ${result.cardNo}` : '未读取';
    $('receipt-message').textContent = result.message || result.kindText; $('receipt-scene').textContent = `${result.kindText} · ${result.scene || ''}`;
    $('receipt-amount').textContent = `${result.amountPrefix}${result.amountText} 元`;
    $('receipt-balance-label').textContent = result.balanceLabel || '交易后余额';
    $('receipt-balance').textContent = result.status === 'uncertain' || !result.cardNo ? result.balanceText : `${result.balanceText} 元`;
    $('receipt-time').textContent = result.timeText; $('receipt-id').textContent = result.id;
  }
  function filteredLogs() { return C.filterLogs(app.logs, { cardNo: $('filter-card').value, scene: $('filter-scene').value, kind: $('filter-kind').value, status: $('filter-status').value }); }
  function renderLogs() {
    const logs = filteredLogs(), summary = C.summarizeLogs(logs);
    $('stat-count').textContent = summary.count; $('stat-success').textContent = `成功 ${summary.successCount} 笔`;
    $('stat-topup').textContent = B.money(summary.topupCents); $('stat-spend').textContent = B.money(summary.spendCents); $('stat-net').textContent = B.money(summary.netCents);
    $('logs-empty').hidden = !!logs.length; $('logs-empty').textContent = !app.loaded ? '连接终端后，读取完整交易流水。' : !app.logs.length ? '终端还没有交易记录。' : '当前条件下没有记录。';
    $('logs-body').innerHTML = logs.map(value => { const item = B.decorateResult(value); return `<tr><td><strong>${esc(item.kindText)} · ${esc(item.scene)}</strong><small>${esc(item.id)}</small></td><td>${esc(item.cardNo || '--')}</td><td class="money-cell">${esc(item.amountPrefix)}${esc(item.amountText)}</td><td class="money-cell">${esc(item.balanceText)}</td><td><span class="result-tag ${item.status === 'success' ? 'success' : item.status === 'uncertain' ? 'warning' : 'error'}">${esc(item.statusText)}</span></td><td>${esc(item.timeText)}</td></tr>`; }).join('');
    $('logs-summary').textContent = app.loaded ? `已读取 ${app.logs.length} 条，当前显示 ${logs.length} 条` : '尚未读取'; $('export-csv').disabled = !logs.length;
  }
  function renderDiagnostics() {
    const d = app.state.device || {}, power = app.state.power || {}, stats = app.diagnostics;
    const bytes = value => Number.isFinite(value) ? `${Math.round(value / 1024)} KB` : '未读取';
    const pairs = [['连接方式', app.connected ? app.client.label : '未连接'], ['设备标识', d.id || '未读取'], ['读卡器', d.readerReady ? 'RC522 就绪' : '未检测到'], ['OLED', d.oledReady ? 'SSD1306 就绪' : '未检测到'], ['交易存储', d.storageReady === false ? '不可用' : d.storageReady ? 'NVS 就绪' : '未读取'], ['屏幕状态', power.screenAwake === undefined ? '未读取' : power.screenAwake ? '点亮' : '闲置熄屏'], ['最近请求耗时', app.latency === null ? '未测量' : app.latency + ' ms'], ['空闲内存', bytes(stats.freeHeapBytes)], ['历史最低内存', bytes(stats.minFreeHeapBytes)], ['最大循环耗时', Number.isFinite(stats.maxLoopMs) ? stats.maxLoopMs + ' ms' : '未读取'], ['最近卡片读写', stats.lastCardMs ? stats.lastCardMs + ' ms' : '尚未实测'], ['蓝牙 / USB 队列', stats.bleQueue === undefined ? '未读取' : `${stats.bleQueue} / ${stats.usbQueue}`]];
    $('diagnostic-values').innerHTML = pairs.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('');
  }
  function switchKind(kind) {
    if (!names[kind] || app.busy) return; app.kind = kind;
    document.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('active', button.dataset.kind === kind));
    $('payment-fields').hidden = kind === 'issue'; $('issue-fields').hidden = kind !== 'issue';
    $('amount').required = kind !== 'issue'; $('issue-name').required = $('student-no').required = kind === 'issue';
    $('amount').value = kind === 'topup' ? '50.00' : '12.50'; $('scene').value = kind === 'topup' ? '充值' : '食堂';
    document.querySelector('label[for="amount"]').textContent = kind === 'topup' ? '充值金额' : '本次消费金额';
    document.querySelector('label[for="scene"]').textContent = kind === 'topup' ? '充值备注' : '消费场景';
    $('submit-trade').innerHTML = `${kind === 'issue' ? '保存资料，等待刷卡开卡' : `确认金额，等待刷卡${names[kind]}`} <span>→</span>`; renderQuickOptions(); render();
  }
  function renderQuickOptions() {
    const items = app.kind === 'topup' ? catalog.topups.map(cents => ({ name: `${B.money(cents)} 元`, amountCents: cents, scene: '充值' })) : catalog.products;
    $('quick-label').textContent = app.kind === 'topup' ? '常用充值档位' : '选择商品';
    $('quick-options').innerHTML = items.map((item, index) => `<button type="button" class="quick-option" data-quick="${index}"><strong>${esc(item.name)}</strong><small>${app.kind === 'topup' ? '快速填入金额' : `¥ ${esc(B.money(item.amountCents))} · ${esc(item.scene)}`}</small></button>`).join('');
  }
  function readProductDraft() { return Array.from(document.querySelectorAll('.product-row')).map(row => ({ id: row.dataset.id, name: row.querySelector('[data-product="name"]').value, amount: row.querySelector('[data-product="amount"]').value, scene: row.querySelector('[data-product="scene"]').value })); }
  function showProductDraft(rows) { $('product-rows').innerHTML = rows.map((item, index) => `<div class="product-row" data-id="${esc(item.id)}"><input data-product="name" aria-label="商品 ${index + 1} 名称" value="${esc(item.name)}" maxlength="24" placeholder="商品名称" required><input data-product="amount" aria-label="商品 ${index + 1} 价格" value="${esc(item.amount)}" inputmode="decimal" placeholder="0.00" required><input data-product="scene" aria-label="商品 ${index + 1} 场景" value="${esc(item.scene)}" maxlength="24" placeholder="场景" required><button class="delete-product" type="button" data-delete="${index}" aria-label="删除商品 ${index + 1}">删除</button></div>`).join(''); }
  function showCatalog() { showProductDraft(catalog.products.map(item => Object.assign({}, item, { amount: B.money(item.amountCents) }))); $('topup-values').value = catalog.topups.map(B.money).join(', '); }
  function screenSettings() { return { fontSize: Number($('font-size').value), effect: $('effect').value, holdMs: Math.round(Number($('hold-seconds').value) * 1000) }; }
  function drawPreview(elapsed, animated) {
    const canvas = $('oled-preview'), context = canvas.getContext('2d'), settings = screenSettings(), layout = M.previewLayout(app.state.card, settings);
    context.fillStyle = '#0b0e0b'; context.fillRect(0, 0, 128, 64); context.fillStyle = '#f0f4ed'; context.textBaseline = 'alphabetic';
    const shift = animated && settings.effect === 'slide' ? Math.max(0, 1 - elapsed / 400) * 64 : 0;
    context.font = '12px "Microsoft YaHei",sans-serif'; context.fillText(`${layout.name} / 余额`, 1, 12 + shift);
    let amount = layout.amount;
    if (animated && settings.effect === 'type') amount = amount.slice(0, Math.floor(elapsed / 130) + 1);
    context.font = `${layout.fontSize}px monospace`; context.fillText(amount, Math.max(1, (128 - context.measureText(layout.amount).width) / 2), 49 + shift);
    context.font = '10px monospace'; context.fillText('NO. ' + layout.number, 1, 63 + shift);
    if (!app.state.power || app.state.power.screenAwake !== false) canvas.style.opacity = String(0.45 + Number($('brightness').value) / 255 * 0.55);
    else canvas.style.opacity = '0.25';
  }
  function playPreview() {
    cancelAnimationFrame(previewFrame); const start = performance.now(); const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function tick(now) { if (app.view !== 'screen') return; drawPreview(now - start, !reduced); if (!reduced && now - start < 2200) previewFrame = requestAnimationFrame(tick); }
    previewFrame = requestAnimationFrame(tick);
  }
  function setView(view) {
    if (!titles[view]) return; app.view = view; cancelAnimationFrame(previewFrame);
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
    window.scrollTo(0, 0);
    $('breadcrumb').textContent = titles[view][0]; $('page-title').textContent = titles[view][1]; $('page-subtitle').textContent = titles[view][2];
    if (view === 'screen') drawPreview(0, false);
    if (view === 'logs' && app.connected && !app.busy) act(loadLogs);
    if (view === 'diagnostics' && app.connected && !app.busy && app.state.device.capabilities && app.state.device.capabilities.diagnostics) act(() => request({ op: 'diagnostics' }));
  }
  $('connect-usb').onclick = () => connect('usb'); $('connect-ble').onclick = () => connect('ble'); $('connect-demo').onclick = () => connect('demo');
  $('disconnect').onclick = async () => { try { if (app.client) await app.client.disconnect(); notice('已断开连接。未确认订单的原编号已保留。'); } catch (error) { failure(error); diagnostic(errorText(error)); } finally { render(); } };
  $('refresh-state').onclick = () => act(async () => { await request({ op: app.view === 'diagnostics' && app.state.device && app.state.device.capabilities && app.state.device.capabilities.diagnostics ? 'diagnostics' : 'state', unixTime: Math.floor(Date.now() / 1000) }); await reconcileOriginal(); });
  $('trade-form').onsubmit = submitTrade; document.querySelectorAll('[data-kind]').forEach(button => { button.onclick = () => switchKind(button.dataset.kind); });
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => setView(button.dataset.view); });
  $('quick-options').onclick = event => { const button = event.target.closest('[data-quick]'); if (!button || app.busy || app.state.pending || outstanding()) return; const item = app.kind === 'topup' ? { amountCents: catalog.topups[Number(button.dataset.quick)], scene: '充值' } : catalog.products[Number(button.dataset.quick)]; $('amount').value = B.money(item.amountCents); $('scene').value = item.scene; };
  $('query-original').onclick = () => act(async () => { if (outstanding()) await reconcileOriginal(); else { const id = app.state.pending && app.state.pending.id; if (id) await request({ op: 'result', id }); await request({ op: 'state' }); } });
  $('cancel-pending').onclick = () => act(async () => { await request({ op: 'cancel' }); await reconcileOriginal(); notice('等待任务已取消。'); }); $('resume-original').onclick = resumeOriginal;
  $('refresh-logs').onclick = () => act(loadLogs); for (const id of ['filter-card', 'filter-scene', 'filter-kind', 'filter-status']) $(id).addEventListener('input', renderLogs);
  $('export-csv').onclick = () => { const csv = C.logsToCsv(filteredLogs()), url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = '校园卡流水-' + new Date().toLocaleDateString('sv-SE') + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('已导出当前筛选结果。'); };
  $('add-product').onclick = () => { const rows = readProductDraft(); if (rows.length >= 12) return failure(new Error('最多添加 12 个商品')); rows.push({ id: 'p' + Date.now().toString(16), name: '', amount: '', scene: '' }); showProductDraft(rows); };
  $('product-rows').onclick = event => { const button = event.target.closest('[data-delete]'); if (!button) return; const rows = readProductDraft(); rows.splice(Number(button.dataset.delete), 1); showProductDraft(rows); };
  $('catalog-form').onsubmit = event => { event.preventDefault(); try { const products = readProductDraft().map(item => ({ id: item.id, name: item.name, amountCents: B.parseMoney(item.amount), scene: item.scene })), topups = $('topup-values').value.split(/[,，\s]+/).filter(Boolean).map(B.parseMoney); catalog = C.saveCatalog(storage, { products, topups }); renderQuickOptions(); render(); failure(null); notice('本机商品和充值档位已保存。'); } catch (error) { failure(error); } };
  $('reset-catalog').onclick = () => { if (!confirm('恢复本机默认商品和充值档位？')) return; try { catalog = C.saveCatalog(storage, C.defaultCatalog()); showCatalog(); renderQuickOptions(); render(); notice('已恢复默认配置。'); } catch (error) { failure(error); } };
  $('screen-form').onsubmit = event => { event.preventDefault(); act(async () => { await request(Object.assign({ op: 'settings' }, screenSettings())); notice('显示设置已由终端确认并保存。'); playPreview(); }); };
  for (const id of ['font-size', 'effect', 'hold-seconds']) $(id).addEventListener('input', () => { app.settingsDirty = true; drawPreview(0, false); }); $('play-preview').onclick = playPreview;
  for (const id of ['brightness', 'idle-seconds', 'battery-mode']) $(id).addEventListener('input', () => { app.powerDirty = true; $('brightness-value').textContent = Math.round(Number($('brightness').value) / 255 * 100) + '%'; drawPreview(0, false); });
  $('power-form').onsubmit = event => { event.preventDefault(); if (!app.state.device || !app.state.device.capabilities || !app.state.device.capabilities.power) return failure(new Error('当前固件未提供电源设置，请连接新版终端。')); act(async () => { const idleSeconds = Number($('idle-seconds').value); if (!Number.isInteger(idleSeconds) || (idleSeconds !== 0 && (idleSeconds < 10 || idleSeconds > 3600))) throw new Error('闲置熄屏设为 0，或 10–3600 秒'); await request({ op: 'power', batteryMode: $('battery-mode').checked, brightness: Number($('brightness').value), idleSeconds }); notice('电源设置已由终端确认并保存。'); }); };
  $('wake-screen').onclick = () => { if (!app.state.device || !app.state.device.capabilities || !app.state.device.capabilities.power) return failure(new Error('当前固件未提供屏幕唤醒功能，请连接新版终端。')); return act(async () => { await request({ op: 'wake' }); notice('屏幕已唤醒。'); }); };
  $('demo-card').onchange = () => { if (app.mode === 'demo') app.client.selectCard($('demo-card').value); };
  $('demo-scan').onclick = () => act(async () => { if (app.mode === 'demo') { app.client.scan(); if (app.view === 'logs') await loadLogs(); } });
  $('demo-interrupt').onchange = () => { if (app.mode === 'demo') app.client.interruptNext = $('demo-interrupt').checked; };
  $('reset-demo').onclick = () => { if (app.mode !== 'demo' || !confirm('清空本机演示卡片与流水，恢复初始演示数据？实体卡不会受影响。')) return; try { const entry = outstanding(); if (entry) book.clear(app.key, entry.id); app.logs = []; app.loaded = false; app.client.reset(); notice('演示设备已重置，A 卡预置 50 元、B 卡为空白。'); } catch (error) { failure(error); } };
  $('clear-diagnostics').onclick = () => { app.log = []; $('diagnostic-log').textContent = '连接记录已清空。'; };
  $('copy-diagnostics').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify({ device: app.state.device || null, power: app.state.power || null, diagnostics: app.diagnostics, connected: app.connected, transport: app.mode, recentLatencyMs: app.latency, log: app.log }, null, 2)); notice('诊断信息已复制。'); } catch (_) { failure(new Error('浏览器未允许复制，请在连接记录中手动选择文本。')); } };
  window.addEventListener('beforeunload', () => { if (app.client) app.client.disconnect(); });
  showCatalog(); renderQuickOptions(); switchKind('spend'); render(); drawPreview(0, false);
})();
