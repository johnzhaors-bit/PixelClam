const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uxchecker', {
  startAudit: (options) => ipcRenderer.invoke('audit:start', options),
  navigateEmbedded: (options) => ipcRenderer.invoke('embedded:navigate', options),
  browserBack: () => ipcRenderer.invoke('embedded:back'),
  browserForward: () => ipcRenderer.invoke('embedded:forward'),
  browserReload: () => ipcRenderer.invoke('embedded:reload'),
  setEmbeddedVisible: (visible) => ipcRenderer.invoke('embedded:setVisible', visible),
  auditEmbeddedCurrentPage: (options) => ipcRenderer.invoke('embedded:auditCurrent', options),
  selectAuditImage: () => ipcRenderer.invoke('image:select'),
  auditImage: (options) => ipcRenderer.invoke('image:audit', options),
  reportAuditError: (message) => ipcRenderer.invoke('audit:clientError', message),
  listSkills: () => ipcRenderer.invoke('workspace:listSkills'),
  listReports: () => ipcRenderer.invoke('workspace:listReports'),
  openBrowser: (options) => ipcRenderer.invoke('browser:open', options),
  auditCurrentPage: () => ipcRenderer.invoke('browser:auditCurrent'),
  stopAudit: () => ipcRenderer.invoke('audit:stop'),
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  openReportInApp: (filePath) => ipcRenderer.invoke('report:openInApp', filePath),
  closeReportInApp: () => ipcRenderer.invoke('report:closeInApp'),
  openReportExternal: (filePath) => ipcRenderer.invoke('report:openExternal', filePath),
  revealReport: (filePath) => ipcRenderer.invoke('report:reveal', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('folder:open', folderPath),
  loadModelConfig: () => ipcRenderer.invoke('model:loadConfig'),
  saveModelConfig: (config) => ipcRenderer.invoke('model:saveConfig', config),
  testModelConfig: (config) => ipcRenderer.invoke('model:testConfig', config),
  openModelConfigFolder: () => ipcRenderer.invoke('model:openConfigFolder'),
  onAuditEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('audit:event', listener);
    return () => ipcRenderer.removeListener('audit:event', listener);
  },
  onAuditStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('audit:status', listener);
    return () => ipcRenderer.removeListener('audit:status', listener);
  },
  onAuditLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('audit:log', listener);
    return () => ipcRenderer.removeListener('audit:log', listener);
  },
  onBrowserState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onReportState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('report:state', listener);
    return () => ipcRenderer.removeListener('report:state', listener);
  }
});
