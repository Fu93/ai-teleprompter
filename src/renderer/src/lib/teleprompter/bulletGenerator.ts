/**
 * bulletGenerator.ts — Bullet 模式要點提取器(自 flowprompt-v3 v27.6 移植)
 *
 * 策略:
 * 1. Layer 1: 偵測既有 Markdown 大綱(#, ##, -, *, 1., 【標籤】)直接使用
 * 2. Layer 2: 無結構時按 雙換行 → 單行 → 句子 順序分段
 */

const MAX_BULLETS = 12

export interface Bullet {
  title: string
  text: string
  detail: string
  subPoints: string[]
  cues?: string[]
}

export function generateBullets(
  rawText: unknown,
  options: { maxBullets?: number } = {}
): Bullet[] {
  const { maxBullets = MAX_BULLETS } = options

  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return []
  }

  const lines = rawText.split('\n')

  // ── Layer 1: Markdown / 大綱結構檢測 ──
  const bullets: Bullet[] = []
  let currentGroup: Bullet | null = null

  const HEADING_PATTERN = /^(#{1,4}|【[^】]+】)\s*(.+)$/
  const LIST_PATTERN = /^([-–—*•]|\d{1,2}[.)])\s+(.+)$/

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const headingMatch = trimmed.match(HEADING_PATTERN)
    if (headingMatch) {
      const title = cleanInlineFormatting(headingMatch[2])
      currentGroup = {
        title,
        text: title,
        detail: trimmed,
        subPoints: []
      }
      bullets.push(currentGroup)
      continue
    }

    const listMatch = trimmed.match(LIST_PATTERN)
    if (listMatch) {
      const content = cleanInlineFormatting(listMatch[2])
      const cues = extractCues(content)
      const cleanedContent = stripCues(content)

      if (currentGroup) {
        if (cleanedContent) currentGroup.subPoints.push(cleanedContent)
      } else {
        bullets.push({
          title: cleanedContent,
          text: cleanedContent,
          detail: '',
          subPoints: [],
          cues
        })
      }
      continue
    }

    // 普通段落(隸屬於當前標題)
    if (currentGroup) {
      const cleaned = cleanInlineFormatting(trimmed)
      if (cleaned) currentGroup.subPoints.push(cleaned)
    }
  }

  if (bullets.length > 0) {
    return bullets.slice(0, maxBullets)
  }

  // ── Layer 2: 無結構時的 fallback(按段落分割)──
  return extractParagraphsAsBullets(rawText, maxBullets)
}

function extractParagraphsAsBullets(rawText: string, maxBullets: number): Bullet[] {
  const paragraphs = rawText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  let segments: string[]
  if (paragraphs.length >= 2) {
    segments = paragraphs
  } else {
    segments = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    if (segments.length < 2) {
      segments = rawText
        .split(/(?<=[.!?。！？])\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
  }

  return segments.slice(0, maxBullets).map((text) => ({
    title: cleanInlineFormatting(text),
    text: cleanInlineFormatting(text),
    detail: '',
    subPoints: []
  }))
}

function cleanInlineFormatting(text: string): string {
  return text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/** 提取講者提示(cues):(提示:...) / [動作:...] / (Cue:...) / (Note:...) */
export function extractCues(text: unknown): string[] {
  if (!text || typeof text !== 'string') return []

  const cues: string[] = []
  const cueRegex = /[([{](?:提示|動作|提醒|備註|Cue|Note)[：:]\s*(.*?)[)\]}]/gi
  let match
  while ((match = cueRegex.exec(text)) !== null) {
    if (match[1] && match[1].trim().length > 0) {
      cues.push(match[1].trim())
    }
  }
  return cues
}

function stripCues(text: string): string {
  return text.replace(/[([{](?:提示|動作|提醒|備註|Cue|Note)[：:].*?[)\]}]/gi, '').trim()
}

/** 提取關鍵數據 badges:40% / $500K / 3.5倍 等 */
export function extractBadges(text: unknown): string[] {
  if (!text || typeof text !== 'string') return []

  const badges = new Set<string>()
  const statRegex = /(?:\$|¥|€)?\d+(?:\.\d+)?(?:%|[kKmMbB]|倍|萬|億|元|次|[GM]B|ms|FPS|fps)?/g
  const matches = text.match(statRegex) || []

  for (const m of matches) {
    if (m.length >= 2 && /\d/.test(m)) {
      badges.add(m)
    }
  }

  return Array.from(badges).slice(0, 6)
}
