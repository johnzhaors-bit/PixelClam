(function () {
  const api = window.uxchecker;
  const state = {
    view: 'home',
    mode: 'dom',
    auditStrategy: 'deep',
    running: false,
    skills: [],
    reports: [],
    selectedSkillId: '',
    selectedReportId: '',
    reportPath: '',
    pendingHistoryId: '',
    pendingHistoryTitle: '',
    selectedImageName: '',
    selectedImagePath: '',
    requestedAuditUrl: '',
    urlDraft: '',
    progressCount: 0,
    roundStates: []
  };

  const el = {
    newAuditButton: document.getElementById('newAuditButton'),
    refreshHistoryButton: document.getElementById('refreshHistoryButton'),
    historyList: document.getElementById('historyList'),
    appStatus: document.getElementById('appStatus'),
    modelSettingsButton: document.getElementById('modelSettingsButton'),
    modelSettingsOverlay: document.getElementById('modelSettingsOverlay'),
    modelSettingsForm: document.getElementById('modelSettingsForm'),
    modelSettingsClose: document.getElementById('modelSettingsClose'),
    modelEnabled: document.getElementById('modelEnabled'),
    modelProvider: document.getElementById('modelProvider'),
    modelBaseUrl: document.getElementById('modelBaseUrl'),
    modelName: document.getElementById('modelName'),
    modelApiKey: document.getElementById('modelApiKey'),
    modelTimeout: document.getElementById('modelTimeout'),
    modelTestResult: document.getElementById('modelTestResult'),
    toggleModelKey: document.getElementById('toggleModelKey'),
    resetKimiDefaults: document.getElementById('resetKimiDefaults'),
    openModelConfigFolder: document.getElementById('openModelConfigFolder'),
    testModelConnection: document.getElementById('testModelConnection'),
    backButton: document.getElementById('backButton'),
    forwardButton: document.getElementById('forwardButton'),
    reloadButton: document.getElementById('reloadButton'),
    urlInput: document.getElementById('urlInput'),
    skillSelect: document.getElementById('skillSelect'),
    auditStrategySelect: document.getElementById('auditStrategySelect'),
    reportFolderButton: document.getElementById('reportFolderButton'),
    primaryActionButton: document.getElementById('primaryActionButton'),
    homeView: document.getElementById('homeView'),
    domModeCard: document.getElementById('domModeCard'),
    imageModeCard: document.getElementById('imageModeCard'),
    imageModeDescription: document.getElementById('imageModeDescription'),
    homeNoticeText: document.getElementById('homeNoticeText'),
    browserPlaceholder: document.getElementById('browserPlaceholder'),
    reportPlaceholder: document.getElementById('reportPlaceholder'),
    auditOverlay: document.getElementById('auditOverlay'),
    progressTitle: document.getElementById('progressTitle'),
    progressMessage: document.getElementById('progressMessage'),
    progressBar: document.getElementById('progressBar'),
    progressSteps: document.getElementById('progressSteps'),
    roundList: document.getElementById('roundList'),
    toast: document.getElementById('toast')
  };

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  function modelFormValue() {
    return {
      enabled: el.modelEnabled.checked,
      provider: el.modelProvider.value,
      baseUrl: el.modelBaseUrl.value.trim(),
      model: el.modelName.value.trim(),
      apiKey: el.modelApiKey.value.trim(),
      timeoutMs: Math.max(180, Number(el.modelTimeout.value || 300)) * 1000
    };
  }

  function fillModelForm(config = {}) {
    el.modelEnabled.checked = config.enabled !== false;
    el.modelProvider.value = ['anthropic-compatible', 'kimi-coding-anthropic'].includes(config.provider)
      ? 'anthropic-compatible' : 'openai-compatible';
    el.modelBaseUrl.value = config.baseUrl || 'https://api.moonshot.cn/v1';
    el.modelName.value = config.model || 'kimi-k3';
    el.modelApiKey.value = config.apiKey || '';
    el.modelTimeout.value = Math.round(Number(config.timeoutMs || 300000) / 1000);
  }

  async function openModelSettings() {
    try {
      fillModelForm(await api.loadModelConfig());
      el.modelTestResult.textContent = '尚未测试连接';
      el.modelSettingsOverlay.classList.remove('hidden');
    } catch (error) {
      showToast(error.message || String(error));
    }
  }

  function closeModelSettings() {
    el.modelSettingsOverlay.classList.add('hidden');
  }

  function roundDisplayName(roundId) {
    switch (roundId) {
      case 'origin': return '组件盘点 · 识别页面实际组件';
      case 'layout': return '整页布局 · 对齐与间距';
      case 'collection-pass': return '第 0 轮 · 采集识别';
      case 'layout-pass': return '第 1 轮 · 布局结构';
      case 'component-style-pass': return '第 2 轮 · 组件样式';
      case 'typography-pass': return '第 3 轮 · 字体体系';
      case 'skin-pass': return '第 4 轮 · 皮肤差异';
      case 'summary-pass': return '第 5 轮 · 汇总报告';
      default: return roundId || '未命名轮次';
    }
  }

  function describeCheckedItems(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return items.map((item) => String(item || '').trim()).filter(Boolean).join(' / ');
  }

  function renderRoundStates() {
    if (!el.roundList) return;
    if (!state.roundStates.length) {
      el.roundList.innerHTML = '<div class="history-empty">尚未进入多轮验收</div>';
      return;
    }
    el.roundList.innerHTML = state.roundStates.map((round) => `
      <div class="round-item ${escapeHtml(round.status || 'idle')}">
        <span class="round-dot" aria-hidden="true"></span>
        <div class="round-main">
          <div class="round-name">${escapeHtml(round.name)}</div>
          <div class="round-meta">${escapeHtml(round.meta || '')}</div>
        </div>
        <div class="round-count">${escapeHtml(round.countText || '')}</div>
      </div>
    `).join('');
  }

  function resetRoundStates() {
    state.roundStates = [];
    renderRoundStates();
  }

  function ensureRound(roundId) {
    let found = state.roundStates.find((round) => round.id === roundId);
    if (found) return found;
    found = {
      id: roundId,
      name: roundDisplayName(roundId),
      status: 'idle',
      meta: '等待执行',
      countText: ''
    };
    state.roundStates.push(found);
    renderRoundStates();
    return found;
  }

  function updateRound(roundId, patch = {}) {
    const round = ensureRound(roundId);
    Object.assign(round, patch);
    renderRoundStates();
  }

  function describeAiStatus(aiStatus) {
    if (!aiStatus) return '';
    if (aiStatus.success) {
      const rounds = aiStatus.totalRounds ? `，完成 ${aiStatus.roundsCompleted || 0}/${aiStatus.totalRounds} 轮` : '';
      return `AI 执行成功：${aiStatus.model || aiStatus.provider || '模型'}${rounds}`;
    }
    if (aiStatus.fallback) {
      return `AI 执行失败，已回退确定性规则：${aiStatus.failureReason || aiStatus.message || '未知原因'}`;
    }
    if (aiStatus.state === 'skipped') {
      return aiStatus.message || 'AI 已跳过';
    }
    if (!aiStatus.enabled) {
      return aiStatus.message || '本次未启用 AI';
    }
    return aiStatus.message || '';
  }

  function isPreferredDefaultSkill(skill) {
    if (!skill || skill.disabled || skill.entryType === 'group') return false;
    const id = String(skill.id || '');
    const skinId = String(skill.skinId || '');
    const name = String(skill.name || '');
    return (
      skinId === 'default' ||
      id.endsWith('::skin::default') ||
      /晴空蓝\(default\)/i.test(name)
    );
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  function renderHistory() {
    const items = [];
    if (state.pendingHistoryId) {
      items.push(`
        <button class="history-item pending active" type="button" data-pending="true">
          <span class="history-title">${escapeHtml(state.pendingHistoryTitle || '正在检测当前页面')}</span>
          <span class="history-time">生成报告中</span>
          <span class="history-score pending-spinner" aria-label="检测中"></span>
        </button>
      `);
    }
    for (const report of state.reports) {
      const active = report.id === state.selectedReportId ? ' active' : '';
      const score = report.score === null ? '报告' : `${report.score}分`;
      items.push(`
        <button class="history-item${active}" type="button" data-report-id="${escapeHtml(report.id)}">
          <span class="history-title" title="${escapeHtml(report.title)}">${escapeHtml(report.title)}</span>
          <span class="history-time">${formatTime(report.createdAt)}</span>
          <span class="history-score">${score}</span>
        </button>
      `);
    }
    el.historyList.innerHTML = items.length ? items.join('') : '<div class="history-empty">暂无监测记录</div>';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function loadHistory(selectReportPath = '') {
    try {
      const result = await api.listReports();
      state.reports = result.reports || [];
      if (selectReportPath) {
        const selected = state.reports.find((report) => report.reportPath === selectReportPath);
        if (selected) state.selectedReportId = selected.id;
      }
      renderHistory();
    } catch (error) {
      showToast(`历史记录读取失败：${error.message || error}`);
    }
  }

  async function loadSkills() {
    try {
      const result = await api.listSkills();
      state.skills = result.skills || [];
      el.skillSelect.innerHTML = '';
      if (!state.skills.length) {
        el.skillSelect.innerHTML = '<option value="">未安装 Skill</option>';
        el.skillSelect.disabled = true;
        state.selectedSkillId = '';
        el.homeNoticeText.textContent = '请先将完整验收 Skill 文件夹复制到应用打开的本地 Skill 目录。';
        updatePrimaryAction();
        return;
      }
      const selectableSkills = state.skills.filter((skill) => !skill.disabled && skill.entryType !== 'group');
      const groupedNodes = new Map();
      const looseFragment = document.createDocumentFragment();

      for (const skill of state.skills) {
        if (skill.entryType === 'group') {
          const optgroup = document.createElement('optgroup');
          optgroup.label = skill.groupName || skill.name || 'Skill 分组';
          groupedNodes.set(skill.baseSkillId || skill.id, optgroup);
          continue;
        }

        const option = document.createElement('option');
        option.value = skill.id;
        option.textContent = `${skill.skinName || skill.name || skill.id}${Number.isFinite(Number(skill.componentCount)) ? `（${skill.componentCount} 个组件规范）` : ''}`;
        option.title = skill.description || skill.path;
        if (skill.disabled) {
          option.disabled = true;
        }

        const groupKey = skill.baseSkillId || '';
        if (groupKey && groupedNodes.has(groupKey)) {
          groupedNodes.get(groupKey).appendChild(option);
        } else {
          looseFragment.appendChild(option);
        }
      }

      for (const skill of state.skills) {
        if (skill.entryType !== 'group') continue;
        const groupKey = skill.baseSkillId || skill.id;
        const optgroup = groupedNodes.get(groupKey);
        if (optgroup && optgroup.children.length) {
          el.skillSelect.appendChild(optgroup);
        }
      }

      if (looseFragment.childNodes.length) {
        el.skillSelect.appendChild(looseFragment);
      }
      el.skillSelect.disabled = false;
      const preferredDefaultSkill = selectableSkills.find(isPreferredDefaultSkill);
      state.selectedSkillId = state.selectedSkillId && selectableSkills.some((skill) => skill.id === state.selectedSkillId)
        ? state.selectedSkillId
        : (preferredDefaultSkill?.id || selectableSkills[0]?.id || '');
      el.skillSelect.value = state.selectedSkillId;
      const selectedSkill = selectableSkills.find((skill) => skill.id === state.selectedSkillId);
      const skinCount = selectableSkills.length;
      el.appStatus.textContent = selectedSkill
        ? `已加载 ${skinCount} 个皮肤项，当前：${selectedSkill.skinName || selectedSkill.name}，可验收 ${selectedSkill.componentCount ?? '未知'} 个组件规范`
        : `已加载 ${skinCount} 个皮肤项`;
      if (state.view === 'home' && state.mode === 'dom') {
        el.homeNoticeText.textContent = '选择皮肤后将自动验收该皮肤下的全部组件；DOM 登录状态保存在本机。';
      }
      updatePrimaryAction();
    } catch (error) {
      el.skillSelect.innerHTML = '<option value="">Skill 读取失败</option>';
      el.skillSelect.disabled = true;
      showToast(error.message || String(error));
    }
  }

  function setView(view) {
    state.view = view;
    el.homeView.classList.toggle('hidden', view !== 'home');
    el.browserPlaceholder.classList.toggle('hidden', view !== 'browser');
    el.reportPlaceholder.classList.toggle('hidden', view !== 'report');
    el.reportFolderButton.classList.toggle('hidden', view !== 'report' || !state.reportPath);
    if (view === 'home') {
      api.closeReportInApp();
      api.setEmbeddedVisible(false);
      state.selectedReportId = '';
      el.appStatus.textContent = '新建监测';
    } else if (view === 'browser') {
      api.closeReportInApp();
      api.setEmbeddedVisible(true);
      el.appStatus.textContent = '内置浏览器';
    } else if (view === 'report') {
      api.setEmbeddedVisible(false);
      el.appStatus.textContent = '验收报告';
    }
    renderHistory();
    updatePrimaryAction();
  }

  function setMode(mode) {
    state.mode = mode;
    el.domModeCard.classList.toggle('selected', mode === 'dom');
    el.imageModeCard.classList.toggle('selected', mode === 'image');
    if (mode === 'dom') {
      el.auditStrategySelect.disabled = false;
      el.homeNoticeText.textContent = '选择皮肤后将自动验收该皮肤下的全部组件；DOM 登录状态保存在本机。';
      el.urlInput.disabled = false;
    } else {
      state.auditStrategy = 'deep';
      el.auditStrategySelect.value = 'deep';
      el.auditStrategySelect.disabled = true;
      el.homeNoticeText.textContent = state.selectedImageName
        ? `已选择图片：${state.selectedImageName}`
        : '截图模式按视觉证据验收，尺寸与间距采用截图容差。';
      el.urlInput.disabled = true;
    }
    updatePrimaryAction();
  }

  function updatePrimaryAction() {
    const hasSkill = Boolean(state.selectedSkillId);
    el.primaryActionButton.disabled = state.running || !hasSkill;
    if (state.running) {
      el.primaryActionButton.textContent = '检测中';
    } else if (state.view === 'home' && state.mode === 'dom') {
      el.primaryActionButton.textContent = '进入网页';
    } else if (state.view === 'home' && state.mode === 'image') {
      el.primaryActionButton.textContent = '开始图片检测';
      el.primaryActionButton.disabled = state.running || !hasSkill || !state.selectedImagePath;
    } else if (state.view === 'browser') {
      el.primaryActionButton.textContent = '检测当前页';
    } else {
      el.primaryActionButton.textContent = '重新检测';
    }
  }

  async function enterBrowser() {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const url = String(el.urlInput.value || state.urlDraft || el.urlInput.getAttribute('value') || '').trim();
    if (!url) {
      showToast('请输入完整地址，支持 http://、https://、file:// 或本地文件绝对路径');
      el.urlInput.focus();
      return;
    }
    try {
      state.requestedAuditUrl = url;
      el.appStatus.textContent = '正在打开页面';
      setView('browser');
      const result = await api.navigateEmbedded({ url });
      state.requestedAuditUrl = result?.url || url;
      el.urlInput.value = state.requestedAuditUrl;
      state.urlDraft = state.requestedAuditUrl;
    } catch (error) {
      showToast(error.message || String(error));
      el.appStatus.textContent = '页面打开失败';
      setView('home');
    }
  }

  function beginProgress(mode = 'dom') {
    state.running = true;
    state.progressCount = 0;
    state.pendingHistoryId = `pending-${Date.now()}`;
    state.pendingHistoryTitle = mode === 'image' ? '正在识别上传截图' : '正在识别当前页面';
    state.selectedReportId = '';
    resetRoundStates();
    el.progressSteps.innerHTML = '';
    el.progressBar.style.width = '12%';
    el.progressTitle.textContent = mode === 'image' ? '分析页面截图' : '采集运行态页面';
    el.progressMessage.textContent = mode === 'image'
      ? '正在读取截图、识别视觉元素并按 ±2px 容差验收。'
      : '正在锁定页面、提取 DOM 与视觉证据，请稍候。';
    el.auditOverlay.classList.remove('hidden');
    document.body.classList.add('audit-running');
    renderHistory();
    updatePrimaryAction();
  }

  function addProgress(message) {
    if (!message) return;
    const item = document.createElement('li');
    item.textContent = message;
    el.progressSteps.appendChild(item);
    el.progressSteps.scrollTop = el.progressSteps.scrollHeight;
    state.progressCount += 1;
    el.progressBar.style.width = `${Math.min(92, 12 + state.progressCount * 9)}%`;
    el.progressMessage.textContent = message;
    if (/模型|AI/i.test(message)) el.progressTitle.textContent = '分析页面与规范';
    if (/报告|HTML/i.test(message)) el.progressTitle.textContent = '生成验收报告';
  }

  async function auditCurrentPage() {
    if (!state.selectedSkillId) {
      showToast('请先安装并选择验收 Skill');
      return;
    }
    try {
      // Capture the user's address before restoring BrowserView. Restoring the
      // hidden view emits its stale URL and would otherwise overwrite the input.
      const requestedUrl = state.requestedAuditUrl || el.urlInput.value.trim();
      // A BrowserView can only be captured while attached to the window. When a
      // rerun starts from a report, restore the tested page before collecting it.
      await api.closeReportInApp();
      state.view = 'browser';
      el.reportPlaceholder.classList.add('hidden');
      el.browserPlaceholder.classList.remove('hidden');
      el.reportFolderButton.classList.add('hidden');
      await api.setEmbeddedVisible(true);
      await new Promise((resolve) => setTimeout(resolve, 180));
      beginProgress('dom');
      const result = await api.auditEmbeddedCurrentPage({
        skillId: state.selectedSkillId,
        auditStrategy: state.auditStrategy,
        requestedUrl
      });
      if (result?.reportPath) state.reportPath = result.reportPath;
      if (state.running) await finishProgress(true);
    } catch (error) {
      const message = error.message || String(error);
      api.reportAuditError(message);
      if (state.running) finishProgress(false, message);
    }
  }

  async function chooseImage() {
    setMode('image');
    try {
      const result = await api.selectAuditImage();
      if (!result?.path) return;
      state.selectedImagePath = result.path;
      state.selectedImageName = result.name || '页面截图';
      const sizeText = result.width && result.height ? `，${result.width}×${result.height}` : '';
      el.imageModeDescription.textContent = `已选择：${state.selectedImageName}${sizeText}`;
      el.homeNoticeText.textContent = '图片模式允许 ±2px 视觉容差；检测时截图会发送给当前配置的视觉模型。';
      updatePrimaryAction();
    } catch (error) {
      showToast(error.message || String(error));
    }
  }

  async function auditSelectedImage() {
    if (!state.selectedSkillId) {
      showToast('请先安装并选择验收 Skill');
      return;
    }
    if (!state.selectedImagePath) {
      await chooseImage();
      if (!state.selectedImagePath) return;
    }
    beginProgress('image');
    try {
      const result = await api.auditImage({
        skillId: state.selectedSkillId,
        imagePath: state.selectedImagePath
      });
      if (result?.reportPath) state.reportPath = result.reportPath;
      if (state.running) await finishProgress(true);
    } catch (error) {
      const message = error.message || String(error);
      api.reportAuditError(message);
      if (state.running) finishProgress(false, message);
    }
  }

  async function finishProgress(success, message = '') {
    if (!state.running) return;
    state.running = false;
    document.body.classList.remove('audit-running');
    if (!success) {
      state.pendingHistoryId = '';
      state.pendingHistoryTitle = '';
      el.auditOverlay.classList.add('hidden');
      el.appStatus.textContent = '检测失败';
      showToast(message || '检测失败');
      setView(state.mode === 'image' ? 'home' : 'browser');
      return;
    }
    el.progressBar.style.width = '100%';
    el.progressTitle.textContent = '报告已生成';
    el.progressMessage.textContent = '正在打开报告并更新历史记录。';
    await new Promise((resolve) => setTimeout(resolve, 320));
    state.pendingHistoryId = '';
    state.pendingHistoryTitle = '';
    await loadHistory(state.reportPath);
    el.auditOverlay.classList.add('hidden');
    resetRoundStates();
    setView('report');
    if (state.reportPath) await api.openReportInApp(state.reportPath);
  }

  async function openHistoryReport(reportId) {
    if (state.running) return;
    const report = state.reports.find((item) => item.id === reportId);
    if (!report) return;
    state.selectedReportId = report.id;
    state.reportPath = report.reportPath;
    renderHistory();
    setView('report');
    await api.openReportInApp(report.reportPath);
  }

  async function newAudit() {
    if (state.running) {
      showToast('当前检测尚未完成');
      return;
    }
    state.reportPath = '';
    state.selectedImageName = '';
    state.selectedImagePath = '';
    el.imageModeDescription.textContent = '适合无法访问运行环境的页面，按截图视觉容差进行验收。';
    setMode('dom');
    setView('home');
    await Promise.all([loadSkills(), loadHistory()]);
  }

  el.newAuditButton.addEventListener('click', newAudit);
  el.modelSettingsButton.addEventListener('click', openModelSettings);
  el.modelSettingsClose.addEventListener('click', closeModelSettings);
  el.modelSettingsOverlay.addEventListener('click', (event) => {
    if (event.target === el.modelSettingsOverlay) closeModelSettings();
  });
  el.toggleModelKey.addEventListener('click', () => {
    const showing = el.modelApiKey.type === 'text';
    el.modelApiKey.type = showing ? 'password' : 'text';
    el.toggleModelKey.textContent = showing ? '显示' : '隐藏';
  });
  el.resetKimiDefaults.addEventListener('click', () => {
    const currentKey = el.modelApiKey.value;
    fillModelForm({ enabled: true, provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', apiKey: currentKey, timeoutMs: 300000 });
    el.modelTestResult.textContent = '已恢复默认参数，API Key 未清空';
  });
  el.openModelConfigFolder.addEventListener('click', async () => {
    const result = await api.openModelConfigFolder();
    if (!result?.ok) showToast(result?.message || '无法打开配置文件夹');
  });
  el.testModelConnection.addEventListener('click', async () => {
    el.testModelConnection.disabled = true;
    el.modelTestResult.textContent = '正在测试文本连接…';
    try {
      const result = await api.testModelConfig(modelFormValue());
      el.modelTestResult.textContent = `连接成功：${result.model || el.modelName.value}`;
      el.modelTestResult.className = 'settings-result success';
    } catch (error) {
      el.modelTestResult.textContent = `连接失败：${error.message || String(error)}`;
      el.modelTestResult.className = 'settings-result failed';
    } finally {
      el.testModelConnection.disabled = false;
    }
  });
  el.modelSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.saveModelConfig(modelFormValue());
      closeModelSettings();
      showToast('模型配置已保存到本机');
    } catch (error) {
      showToast(error.message || String(error));
    }
  });
  el.refreshHistoryButton.addEventListener('click', () => Promise.all([loadSkills(), loadHistory()]));
  el.domModeCard.addEventListener('click', () => setMode('dom'));
  el.imageModeCard.addEventListener('click', chooseImage);
  el.skillSelect.addEventListener('change', () => {
    const selected = state.skills.find((skill) => skill.id === el.skillSelect.value);
    if (!selected || selected.disabled || selected.entryType === 'group') {
      return;
    }
    state.selectedSkillId = selected.id;
    el.appStatus.textContent = `当前验收皮肤：${selected.skinName || selected.name}`;
    updatePrimaryAction();
  });
  el.auditStrategySelect.addEventListener('change', () => {
    state.auditStrategy = el.auditStrategySelect.value === 'fast' ? 'fast' : 'deep';
    el.homeNoticeText.textContent = state.auditStrategy === 'fast'
      ? '快速模式不做组件盘点，将完整 DOM 与当前皮肤全部规范按模型上下文动态分包。'
      : '深度模式先盘点页面组件，再逐组件发送独立规范，准确率优先。';
    el.appStatus.textContent = state.auditStrategy === 'fast' ? '已选择快速模式' : '已选择深度模式';
  });
  el.primaryActionButton.addEventListener('click', () => {
    if (state.view === 'home') {
      if (state.mode === 'dom') enterBrowser();
      else auditSelectedImage();
    } else if (state.mode === 'image') {
      auditSelectedImage();
    } else {
      auditCurrentPage();
    }
  });
  el.reportFolderButton.addEventListener('click', async () => {
    if (!state.reportPath) return;
    const result = await api.revealReport(state.reportPath);
    if (!result?.ok) showToast(result?.message || '无法打开报告文件夹');
  });
  el.backButton.addEventListener('click', () => api.browserBack());
  el.forwardButton.addEventListener('click', () => api.browserForward());
  el.reloadButton.addEventListener('click', () => api.browserReload());
  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.mode === 'dom') {
      event.preventDefault();
    }
  });
  el.urlInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter' && state.mode === 'dom' && !event.isComposing) enterBrowser();
  });
  const syncUrlDraft = () => {
    state.urlDraft = String(el.urlInput.value || el.urlInput.getAttribute('value') || '').trim();
  };
  el.urlInput.addEventListener('input', syncUrlDraft);
  el.urlInput.addEventListener('beforeinput', syncUrlDraft);
  el.urlInput.addEventListener('compositionend', syncUrlDraft);
  el.urlInput.addEventListener('keyup', syncUrlDraft);
  el.urlInput.addEventListener('change', syncUrlDraft);
  el.urlInput.addEventListener('blur', syncUrlDraft);
  el.historyList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-report-id]');
    if (item) openHistoryReport(item.dataset.reportId);
  });

  api.onBrowserState((event) => {
    if (event.url) {
      el.urlInput.value = event.url;
      state.urlDraft = event.url;
      if (!state.running && state.view === 'browser') state.requestedAuditUrl = event.url;
    }
    if (typeof event.canGoBack === 'boolean') el.backButton.disabled = !event.canGoBack;
    if (typeof event.canGoForward === 'boolean') el.forwardButton.disabled = !event.canGoForward;
    el.reloadButton.disabled = false;
    if (event.loading) el.appStatus.textContent = '页面加载中';
    else if (event.title || event.url) el.appStatus.textContent = event.title || event.url;
    if (event.message) showToast(event.message);
  });

  api.onAuditEvent((event) => {
    if (event.phase === 'run:init' && event.pendingTitle) {
      state.pendingHistoryTitle = event.pendingTitle;
      renderHistory();
    }
    if (event.phase === 'ai:multiround:prepare') {
      resetRoundStates();
      const totalRounds = Number(event.totalRounds || 0);
      const order = ['layout-pass', 'component-style-pass', 'typography-pass', 'skin-pass', 'summary-pass'];
      order.slice(0, totalRounds || order.length).forEach((roundId) => ensureRound(roundId));
    }
    if (event.phase === 'ai:round:plan' && event.roundId) {
      const checks = describeCheckedItems(event.checkedItems);
      updateRound(event.roundId, {
        status: 'planned',
        meta: checks ? `待执行 · ${checks}` : '待执行',
        countText: ''
      });
    }
    if (event.phase === 'origin:start') {
      updateRound('origin', { status: 'running', meta: '正在盘点页面实际出现的组件族', countText: '' });
    }
    if (event.phase === 'origin:done') {
      const absentCount = event.skippedAbsentFamilies?.length || 0;
      updateRound('origin', { status: 'done', meta: `盘点完成 · 页面未出现 ${absentCount} 个组件族`, countText: '完成' });
    }
    if (event.phase === 'layout:start') {
      updateRound('layout', { status: 'running', meta: '正在检查整页对齐、间距、分组和溢出', countText: '' });
    }
    if (event.phase === 'layout:done') {
      updateRound('layout', { status: 'done', meta: '整页布局验收完成', countText: '完成' });
    }
    if (event.phase === 'ai:round:start' && event.roundId) {
      const checks = describeCheckedItems(event.checkedItems);
      updateRound(event.roundId, {
        status: 'running',
        meta: checks ? `执行中 · ${checks}` : '执行中',
        countText: ''
      });
    }
    if (event.phase === 'ai:round:done' && event.roundId) {
      const issueCount = Number.isFinite(Number(event.issueCount)) ? Number(event.issueCount) : null;
      const checks = describeCheckedItems(event.checkedItems);
      const summary = String(event.summary || '').trim();
      updateRound(event.roundId, {
        status: 'done',
        meta: summary || (issueCount === 0
          ? (checks ? `已完成，未发现问题 · ${checks}` : '已完成，未发现问题')
          : (checks ? `已完成 · ${checks}` : '已完成')),
        countText: issueCount === null ? '' : `${issueCount} 条`
      });
    }
    if (event.phase === 'ai:failed') {
      const runningRound = [...state.roundStates].reverse().find((round) => round.status === 'running');
      if (runningRound) {
        updateRound(runningRound.id, {
          status: 'failed',
          meta: '执行失败',
          countText: ''
        });
      }
    }
    if (event.phase === 'snapshot:done' && state.running && state.mode === 'dom') {
      state.view = 'report';
      el.homeView.classList.add('hidden');
      el.browserPlaceholder.classList.add('hidden');
      el.reportPlaceholder.classList.remove('hidden');
      api.setEmbeddedVisible(false);
      el.appStatus.textContent = '正在生成验收报告';
      updatePrimaryAction();
    }
    if (event.message) addProgress(event.message);
    if (event.phase === 'run:done' && event.aiStatus) {
      const aiMessage = describeAiStatus(event.aiStatus);
      if (aiMessage) addProgress(aiMessage);
    }
    if (event.reportPath) {
      state.reportPath = event.reportPath;
    }
  });

  api.onAuditStatus((event) => {
    if (event.message && state.running) addProgress(event.message);
    if (event.phase === 'completed' && state.running) finishProgress(true);
    if (['failed', 'stopped'].includes(event.phase) && state.running) finishProgress(false, event.message);
  });

  api.onAuditLog((event) => {
    if (state.running && event.message) addProgress(event.message.trim());
  });

  api.onReportState((event) => {
    if (event.message) showToast(event.message);
  });

  Promise.all([loadSkills(), loadHistory()]).finally(() => {
    setMode('dom');
    setView('home');
    resetRoundStates();
  });
})();
