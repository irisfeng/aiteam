const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiteamDesktop", {
  notify(payload) {
    ipcRenderer.send("notify", {
      title: String(payload?.title ?? "AiTeam"),
      body: String(payload?.body ?? ""),
      target: typeof payload?.target === "string" ? payload.target : "",
    });
  },
  pickFile(mode) {
    return ipcRenderer.invoke("pick-file", { mode });
  },
});
