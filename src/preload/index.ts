import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, CommandDef, OpenArcApi } from '../shared/types'

const api: OpenArcApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onStateChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },
  onTabLoading: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, tabId: string, loading: boolean): void => cb(tabId, loading)
    ipcRenderer.on('tab:loading', listener)
    return () => ipcRenderer.removeListener('tab:loading', listener)
  },
  onDownloadDone: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, info: { filename: string; path: string; state: string }): void => cb(info)
    ipcRenderer.on('download:done', listener)
    return () => ipcRenderer.removeListener('download:done', listener)
  },

  switchSpace: (id) => ipcRenderer.send('space:switch', id),
  createSpace: (name) => ipcRenderer.send('space:create', name),
  renameSpace: (id, name) => ipcRenderer.send('space:rename', id, name),

  openTab: (url) => ipcRenderer.send('tab:open', url),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  switchTab: (id) => ipcRenderer.send('tab:switch', id),
  pinTab: (id) => ipcRenderer.send('tab:pin', id),
  unpinTab: (id) => ipcRenderer.send('tab:unpin', id),
  restoreTab: (id) => ipcRenderer.send('tab:restore', id),

  navigate: (cmd) => ipcRenderer.send('nav', cmd),
  findInPage: (text, findNext) => ipcRenderer.invoke('find:in-page', text, !!findNext),
  stopFind: () => ipcRenderer.send('find:stop'),
  zoom: (action) => ipcRenderer.invoke('tab:zoom', action),
  copyActiveUrl: () => ipcRenderer.invoke('tab:copy-url'),
  toggleMute: () => ipcRenderer.invoke('tab:mute-toggle'),
  toggleSidebar: () => ipcRenderer.send('sidebar:toggle'),
  windowControl: (action) => ipcRenderer.send('window:control', action),

  runCommand: (id, arg) => ipcRenderer.send('command:run', id, arg),
  listCommands: () => ipcRenderer.invoke('commands:list') as Promise<CommandDef[]>
}

contextBridge.exposeInMainWorld('openArc', api)
