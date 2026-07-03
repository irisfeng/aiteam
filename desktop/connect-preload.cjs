const { contextBridge, ipcRenderer } = require("electron");

// 「连接远端工作区」小窗口专用 preload：只暴露连接状态读写，不含主窗口的 notify/pickFile 能力。
contextBridge.exposeInMainWorld("aiteamConnect", {
  getState() {
    return ipcRenderer.invoke("get-connection-state");
  },
  setRemote(url) {
    return ipcRenderer.invoke("set-remote", String(url ?? ""));
  },
  switchLocal() {
    return ipcRenderer.invoke("switch-local");
  },
});
