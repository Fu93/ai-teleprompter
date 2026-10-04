import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { APP_UPDATE_DOWNLOADED, IPC } from '../shared/types'
import type {
  AppSettings,
  AppInfo,
  RescuePayload,
  TurnYieldPayload,
  CoachingPayload,
  UpdateDownloadedInfo
} from '../shared/types'
import type {
  Api,
  OverlayShowPayload,
  OllamaChatApiRequest,
  CloudTranscribeArgs,
  ChatCompletionApiRequest
} from '../shared/api'
import type { DebugOverlayAction, DebugSignalKind, CoachingKind } from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: Api = {
  getSettings: () => ipcRenderer.invoke(IPC.SettingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SettingsSet, patch),
  onSettingsChanged: (cb) => on<AppSettings>(IPC.OverlaySettingsChanged, cb),

  overlayShow: (payload: OverlayShowPayload) => ipcRenderer.invoke(IPC.OverlayShow, payload),
  overlaySync: (payload: OverlayShowPayload) => ipcRenderer.invoke(IPC.OverlaySync, payload),
  overlayGetLastPayload: () => ipcRenderer.invoke(IPC.OverlayGetLastPayload),
  overlayHide: () => ipcRenderer.invoke(IPC.OverlayHide),
  overlayToggle: () => ipcRenderer.invoke(IPC.OverlayToggle),
  overlayIsVisible: () => ipcRenderer.invoke(IPC.OverlayIsVisible),
  overlaySetClickThrough: (v) => ipcRenderer.invoke(IPC.OverlaySetClickThrough, v),
  overlaySetCaptureProtection: (v) => ipcRenderer.invoke(IPC.OverlaySetCaptureProtection, v),
  overlaySetSize: (w, h) => ipcRenderer.invoke(IPC.OverlaySetSize, w, h),
  overlaySetSizeLive: (w, h) => ipcRenderer.invoke(IPC.OverlaySetSizeLive, w, h),
  onOverlayVisibility: (cb) => on<boolean>(IPC.OverlayVisibilityChanged, cb),
  onOverlayLoadScript: (cb) => on<OverlayShowPayload>(IPC.OverlayLoadScript, cb),

  ollamaListModels: (baseUrl) => ipcRenderer.invoke(IPC.OllamaListModels, baseUrl),
  ollamaChat: (req: OllamaChatApiRequest) => ipcRenderer.invoke(IPC.OllamaChat, req),
  ollamaAbort: (requestId) => ipcRenderer.invoke(IPC.OllamaAbort, requestId),
  openAiChat: (req) => ipcRenderer.invoke(IPC.OpenAiChat, req),

  cloudTranscribe: (args: CloudTranscribeArgs) => ipcRenderer.invoke(IPC.CloudTranscribe, args),

  // 統一 AI / panic / 場景
  chatCompletion: (req: ChatCompletionApiRequest) => ipcRenderer.invoke(IPC.AiChatCompletion, req),
  testConnection: (args) => ipcRenderer.invoke(IPC.AiTestConnection, args),
  keysGet: () => ipcRenderer.invoke(IPC.KeysGet),
  keysSet: (keys) => ipcRenderer.invoke(IPC.KeysSet, keys),
  sceneList: () => ipcRenderer.invoke(IPC.SceneList),
  pushTranscript: (args) => ipcRenderer.invoke(IPC.ContextPushTranscript, args),
  panicTrigger: () => ipcRenderer.invoke(IPC.PanicTrigger),
  onPanicThinking: (cb: () => void) => on<void>(IPC.PanicThinking, cb),
  onPanicRescue: (cb: (payload: RescuePayload) => void) => on(IPC.PanicRescue, cb),
  onPanicError: (cb: (message: string) => void) => on<string>(IPC.PanicError, cb),
  onTurnYield: (cb: (payload: TurnYieldPayload) => void) => on(IPC.TurnYieldSignal, cb),
  onCoaching: (cb: (payload: CoachingPayload) => void) => on(IPC.CoachingSignal, cb),
  contextReset: () => ipcRenderer.invoke(IPC.ContextReset),
  coachingStats: () => ipcRenderer.invoke(IPC.CoachingStatsGet),
  onOverlayPlayPause: (cb: () => void) => on<void>(IPC.OverlayPlayPause, cb),
  onOverlaySpeedStep: (cb: (dir: 1 | -1) => void) => on<1 | -1>(IPC.OverlaySpeedStep, cb),

  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.AppInfo),
  saveRecording: (args: { bytes: Uint8Array; defaultName: string }) =>
    ipcRenderer.invoke(IPC.SaveRecording, args),
  videoRecordingBegin: () => ipcRenderer.invoke(IPC.VideoRecordingBegin),
  videoRecordingChunk: (bytes: Uint8Array) => ipcRenderer.invoke(IPC.VideoRecordingChunk, bytes),
  videoRecordingFinish: () => ipcRenderer.invoke(IPC.VideoRecordingFinish),
  videoRecordingSave: (args: { defaultName: string }) => ipcRenderer.invoke(IPC.VideoRecordingSave, args),
  videoRecordingAbort: () => ipcRenderer.invoke(IPC.VideoRecordingAbort),
  videoRecordingOrphans: () => ipcRenderer.invoke(IPC.VideoRecordingOrphans),
  videoRecordingResolveOrphans: (args: { mode: 'keep' | 'discard' }) =>
    ipcRenderer.invoke(IPC.VideoRecordingResolveOrphans, args),
  powerSaveStart: () => ipcRenderer.invoke(IPC.PowerSaveStart),
  powerSaveStop: () => ipcRenderer.invoke(IPC.PowerSaveStop),
  windowCaptureIndicator: (s) => ipcRenderer.invoke(IPC.WindowCaptureIndicator, s),
  relaunchApp: () => ipcRenderer.invoke(IPC.AppRelaunch),
  showMain: () => ipcRenderer.invoke(IPC.AppShowMain),
  onUpdateDownloaded: (cb: (info: UpdateDownloadedInfo) => void) => on(APP_UPDATE_DOWNLOADED, cb),
  shareSimulation: () => ipcRenderer.invoke(IPC.ShareSimulation),
  snapOverlayCorner: (corner: 'tl' | 'tc' | 'tr') => ipcRenderer.invoke(IPC.OverlaySnapCorner, corner),
  recenterOverlay: () => ipcRenderer.invoke(IPC.OverlayRecenter),

  // 開發者除錯(見 src/main/debug.ts;未啟用時 main 端一律回 null/false)
  debugOpenDevTools: (target: 'main' | 'overlay') => ipcRenderer.invoke(IPC.DebugOpenDevTools, target),
  debugEmitSignal: (args: { kind: DebugSignalKind; text?: string; coachingKind?: CoachingKind }) =>
    ipcRenderer.invoke(IPC.DebugEmitSignal, args),
  debugOverlaySnapshot: () => ipcRenderer.invoke(IPC.DebugOverlaySnapshot),
  debugOverlayCall: (action: DebugOverlayAction) => ipcRenderer.invoke(IPC.DebugOverlayCall, action),
  debugOverlayInfo: () => ipcRenderer.invoke(IPC.DebugOverlayInfo),
  debugOverlayAudit: () => ipcRenderer.invoke(IPC.DebugOverlayAudit),

  // 關閉視窗守衛(見 src/main/windows.ts 的 close 事件處理)
  setCloseBlocker: (text) => ipcRenderer.invoke(IPC.AppSetCloseBlocker, text),
  setRecording: (recording) => ipcRenderer.invoke(IPC.AppSetRecording, recording),
  confirmClose: () => ipcRenderer.invoke(IPC.AppConfirmClose),
  cancelClose: () => ipcRenderer.invoke(IPC.AppCancelClose),
  onCloseRequested: (cb) => on<string>(IPC.AppCloseRequested, cb),
  revealPath: (path: string) => ipcRenderer.invoke(IPC.RevealPath, path),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.OpenExternal, url),
  exportFile: (args) => ipcRenderer.invoke(IPC.ExportFile, args),
  importJsonFile: (args) => ipcRenderer.invoke(IPC.ImportJsonFile, args),
  logFromRenderer: (level, message) => ipcRenderer.invoke(IPC.LogFromRenderer, { level, message }),
  logEvent: (payload) => ipcRenderer.invoke(IPC.LogEvent, payload),
  diagnosticsReport: () => ipcRenderer.invoke(IPC.DiagnosticsReport),
  openLogDir: () => ipcRenderer.invoke(IPC.OpenLogDir)
}

contextBridge.exposeInMainWorld('api', api)
