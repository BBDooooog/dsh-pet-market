// Preload bridge for the desktop stage window. The page never touches Node:
// state comes in as one immutable payload, positions go out as integers.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petStage', {
  onState(callback) {
    ipcRenderer.on('petmarket:state', (_event, payload) => callback(payload))
    return () => ipcRenderer.removeAllListeners('petmarket:state')
  },
  ready() {
    ipcRenderer.send('petmarket:ready')
  },
  persist(petId, position) {
    ipcRenderer.send('petmarket:persist', { petId, position })
  },
  dragging(active) {
    ipcRenderer.send('petmarket:dragging', active === true)
  },
  openMarket() {
    ipcRenderer.send('petmarket:open-market')
  },
})
