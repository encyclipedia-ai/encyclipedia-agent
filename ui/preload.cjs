const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("helper", {
  getState: () => ipcRenderer.invoke("helper:get-state"),
  signIn: (email, password) =>
    ipcRenderer.invoke("helper:sign-in", { email, password }),
  signInGoogle: () => ipcRenderer.invoke("helper:sign-in-google"),
  signOut: () => ipcRenderer.invoke("helper:sign-out"),
  clip: (url, clipLength) =>
    ipcRenderer.invoke("helper:clip", { url, clipLength }),
  onState: (fn) => {
    const listener = (_event, snap) => fn(snap);
    ipcRenderer.on("helper:state", listener);
    return () => ipcRenderer.removeListener("helper:state", listener);
  },
});
