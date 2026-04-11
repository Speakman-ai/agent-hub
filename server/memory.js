import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';

function today() {
  return new Date().toISOString().split('T')[0];
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Read memory context for an agent (returns string to inject into prompt)
 */
export function getMemoryContext(workspace) {
  if (!workspace) return '';

  const parts = [];

  // Read MEMORY.md (last 3000 chars if too long)
  const memoryPath = path.join(workspace, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    try {
      let memory = readFileSync(memoryPath, 'utf-8');
      if (memory.length > 3000) {
        memory = '...(truncated)\n' + memory.slice(-3000);
      }
      if (memory.trim()) {
        parts.push(`## MEMORY.md (Long-term)\n${memory}`);
      }
    } catch {
      /* skip */
    }
  }

  // Read today's daily note
  const todayPath = path.join(workspace, 'memory', `${today()}.md`);
  if (existsSync(todayPath)) {
    try {
      const content = readFileSync(todayPath, 'utf-8');
      if (content.trim()) {
        parts.push(`## Today's Notes (${today()})\n${content}`);
      }
    } catch {
      /* skip */
    }
  }

  // Read yesterday's daily note
  const yesterdayPath = path.join(workspace, 'memory', `${yesterday()}.md`);
  if (existsSync(yesterdayPath)) {
    try {
      const content = readFileSync(yesterdayPath, 'utf-8');
      if (content.trim()) {
        parts.push(`## Yesterday's Notes (${yesterday()})\n${content}`);
      }
    } catch {
      /* skip */
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

/**
 * Append to today's daily note
 */
export function appendDailyNote(workspace, entry) {
  if (!workspace) return;

  const memoryDir = path.join(workspace, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  const filePath = path.join(memoryDir, `${today()}.md`);
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const formatted = `## ${time}\n${entry}\n\n`;

  try {
    let existing = '';
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, 'utf-8');
    }
    writeFileSync(filePath, existing + formatted, 'utf-8');
  } catch (err) {
    console.error('Failed to append daily note:', err.message);
  }
}

/**
 * Update MEMORY.md (full overwrite — agent decides content)
 */
export function updateMemory(workspace, content) {
  if (!workspace) return;

  const memoryPath = path.join(workspace, 'MEMORY.md');
  try {
    writeFileSync(memoryPath, content, 'utf-8');
  } catch (err) {
    console.error('Failed to update MEMORY.md:', err.message);
  }
}

/**
 * Get memory data for API (MEMORY.md + daily notes)
 */
export function getMemoryData(workspace) {
  if (!workspace) return { memory: '', dailyNotes: [] };

  let memory = '';
  const memoryPath = path.join(workspace, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    try {
      memory = readFileSync(memoryPath, 'utf-8');
    } catch {
      /* skip */
    }
  }

  const dailyNotes = [];
  const memoryDir = path.join(workspace, 'memory');
  if (existsSync(memoryDir)) {
    try {
      const files = readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 14); // Last 14 days
      for (const file of files) {
        try {
          const content = readFileSync(path.join(memoryDir, file), 'utf-8');
          dailyNotes.push({ date: file.replace('.md', ''), content });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }

  return { memory, dailyNotes };
}
