/**
 * Runs the real AgentHub WoW addon (integrations/wow-addon) in a Lua VM (wasmoon) with
 * the WoW API stubbed, to pin its queue and acknowledgement behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LuaFactory } from 'wasmoon';
import { renderDataLua } from './wow-bridge.js';
const ADDON_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'integrations',
  'wow-addon',
  'AgentHub',
);
const NOW = 1794082000;

// WoW API stand-ins. Frames accept any method call; text, scripts, shown state
// and edit box contents are tracked so tests can drive the UI.
const STUBS = `
local out = {}
function emit(s) out[#out + 1] = tostring(s) end
function output() return table.concat(out, "\\n") end
printed = {}
print = function(s) printed[#printed + 1] = s end
time = function() return NOW end
strtrim = function(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
tinsert = table.insert
UISpecialFrames, StaticPopupDialogs, SlashCmdList, UIParent = {}, {}, {}, {}
popups = 0
StaticPopup_Show = function() popups = popups + 1 end
InCombatLockdown = function() return false end
reloads = 0
C_UI = { Reload = function() reloads = reloads + 1 end }
frames = {}
local function mock(kind)
  local o = { kind = kind, scripts = {}, text = "", shown = true }
  setmetatable(o, { __index = function(_, k)
    if k == "SetScript" then return function(self, ev, fn) self.scripts[ev] = fn end end
    if k == "SetText" then return function(self, s) self.text = s end end
    if k == "GetText" then return function(self) return self.text end end
    if k == "CreateFontString" or k == "CreateTexture" then
      return function() local f = mock(k); frames[#frames + 1] = f; return f end
    end
    if k == "GetStringHeight" or k == "GetHeight" then return function() return 100 end end
    if k == "SetShown" then return function(self, v) self.shown = not not v end end
    if k == "Hide" then return function(self) self.shown = false end end
    if k == "IsShown" then return function(self) return self.shown end end
    return function() end
  end })
  return o
end
CreateFrame = function(kind, _, _, template)
  local f = mock(kind)
  f.template = template
  frames[#frames + 1] = f
  return f
end
`;

const ADDON_FILES = ['Data.lua', 'AgentHub.lua', 'UI.lua'];

async function runAddon(opts: {
  dataLua?: string;
  savedQueue?: string;
  script: string;
}): Promise<string[]> {
  const factory = new LuaFactory();
  // The VM has its own file system; mount the addon so dofile reads the real files.
  for (const file of ADDON_FILES) {
    await factory.mountFile(`/addon/${file}`, readFileSync(path.join(ADDON_DIR, file), 'utf-8'));
  }
  const lua = await factory.createEngine();
  try {
    const code = [
      `NOW = ${NOW}`,
      STUBS,
      `AgentHubDB = { defaultAgent = "agent-hub-dev", queue = ${opts.savedQueue ?? '{}'} }`,
      opts.dataLua ?? 'dofile("/addon/Data.lua")',
      'dofile("/addon/AgentHub.lua")',
      'dofile("/addon/UI.lua")',
      // The game fires ADDON_LOADED after SavedVariables are restored.
      'frames[1].scripts.OnEvent(frames[1], "ADDON_LOADED", "AgentHub")',
      opts.script,
      'return output()',
    ].join('\n');
    const result = (await lua.doString(code)) as string;
    return result.split('\n').filter(Boolean);
  } finally {
    lua.global.close();
  }
}

function sentQueue(n: number, ageSeconds = 60): string {
  const entries = Array.from(
    { length: n },
    (_, i) =>
      `{ id = "q${i + 1}", agent = "dev", prompt = "p${i + 1}", createdAt = ${NOW - ageSeconds}, sent = true }`,
  );
  return `{ ${entries.join(', ')} }`;
}

const QUEUE_IDS =
  'local ids = {} for _, e in ipairs(AgentHubDB.queue) do ids[#ids + 1] = e.id end emit(table.concat(ids, ","))';

describe('AgentHub addon queue', () => {
  it('keeps every unacknowledged request across reloads and refuses new ones when full', async () => {
    const [before, after, refused] = await runAddon({
      savedQueue: sentQueue(20),
      script: `
        ${QUEUE_IDS}
        SlashCmdList["AGENTHUB"]("one more")
        ${QUEUE_IDS}
        emit(printed[#printed])
      `,
    });
    const ids = Array.from({ length: 20 }, (_, i) => `q${i + 1}`).join(',');
    expect(before).toBe(ids);
    expect(after).toBe(ids);
    expect(refused).toContain('20 requests are waiting');
  });

  it('drops requests the desktop app acknowledged in Data.lua, and only those', async () => {
    const dataLua = renderDataLua([], NOW * 1000, ['q2', 'q5', 'unrelated']);
    const [ids, sent] = await runAddon({
      dataLua: `(function() ${dataLua} end)()`,
      savedQueue: sentQueue(6),
      script: `
        ${QUEUE_IDS}
        local all = true for _, e in ipairs(AgentHubDB.queue) do all = all and e.sent end
        emit(tostring(all))
      `,
    });
    expect(ids).toBe('q1,q3,q4,q6');
    expect(sent).toBe('true');
  });

  it('drops requests older than a day, as the desktop app ignores them', async () => {
    const [ids] = await runAddon({
      savedQueue: `{ { id = "old", prompt = "x", createdAt = ${NOW - 2 * 86400} }, { id = "new", prompt = "y", createdAt = ${NOW - 10} } }`,
      script: QUEUE_IDS,
    });
    expect(ids).toBe('new');
  });

  it('queues new sessions and replies from the window, with a reload prompt', async () => {
    const dataLua = renderDataLua(
      [
        {
          id: 's1',
          name: 'Fix test',
          agentName: 'Dev',
          projectName: 'agent-hub',
          state: 'working',
          updatedAt: '2026-11-07 20:00:00',
          lastReply: 'ok',
          messages: [],
        },
      ],
      NOW * 1000,
      [],
      'https://a.example.com|u1',
    );
    const lines = await runAddon({
      dataLua,
      script: `
        SlashCmdList["AGENTHUB"]("")
        local win
        for _, f in ipairs(frames) do if f.template == "BasicFrameTemplateWithInset" then win = f end end
        win.scripts.OnShow()
        local boxes = {}
        for _, f in ipairs(frames) do if f.kind == "EditBox" then boxes[#boxes + 1] = f end end
        boxes[2].text = "ship it"
        boxes[2].scripts.OnEnterPressed(boxes[2])
        boxes[1].text = "@qa run smoke"
        boxes[1].scripts.OnEnterPressed(boxes[1])
        for _, e in ipairs(AgentHubDB.queue) do
          emit(tostring(e.sessionId) .. "|" .. tostring(e.agent) .. "|" .. e.prompt .. "|" .. tostring(e.binding))
        end
        emit("popups=" .. popups)
        local body = ""
        for _, f in ipairs(frames) do if f.text:find("waiting for /reload", 1, true) then body = f.text end end
        emit(body ~= "" and "pending shown" or "pending missing")
      `,
    });
    expect(lines).toEqual([
      's1|nil|ship it|https://a.example.com|u1',
      'nil|qa|run smoke|nil',
      'popups=2',
      'pending shown',
    ]);
  });
});
