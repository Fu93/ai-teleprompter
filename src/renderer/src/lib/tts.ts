// Web Speech API TTS（Windows 內建語音，免費離線）
export function listVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis.getVoices()
}

export function pickVoice(langPrefix: string): SpeechSynthesisVoice | null {
  const voices = listVoices()
  return (
    voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) ??
    voices.find((v) => v.lang.toLowerCase().startsWith('zh')) ??
    voices[0] ??
    null
  )
}

export function speak(text: string, opts?: { lang?: string; rate?: number; onEnd?: () => void }): void {
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const lang = opts?.lang ?? 'zh-TW'
  u.lang = lang
  const voice = pickVoice(lang.toLowerCase().slice(0, 2))
  if (voice) u.voice = voice
  u.rate = opts?.rate ?? 1
  if (opts?.onEnd) u.onend = opts.onEnd
  synth.speak(u)
}

export function stopSpeaking(): void {
  window.speechSynthesis.cancel()
}

/** 預熱語音清單（Chrome 需要一次觸發） */
export function warmUpVoices(): void {
  listVoices()
  window.speechSynthesis.onvoiceschanged = () => undefined
}
