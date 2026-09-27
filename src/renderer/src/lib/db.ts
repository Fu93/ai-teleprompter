import Dexie, { type Table } from 'dexie'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'

export class TeleprompterDB extends Dexie {
  scripts!: Table<Script, number>
  sessions!: Table<MeetingSession, number>
  practiceRuns!: Table<PracticeRun, number>

  constructor() {
    super('ai-teleprompter')
    this.version(1).stores({
      scripts: '++id, title, updatedAt, lastUsedAt',
      sessions: '++id, startedAt, endedAt',
      practiceRuns: '++id, createdAt'
    })
  }
}

export const db = new TeleprompterDB()
