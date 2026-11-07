-- Agent Hub in game.
--
-- Addons can't reach the network, so both directions go through files the
-- Agent Hub desktop app watches:
--   * Requests (new sessions, replies) are queued in the AgentHubDB
--     SavedVariable, which the game writes on /reload or logout.
--   * Your sessions arrive in Data.lua (AgentHubData), which the desktop app
--     rewrites and the game reads on every /reload.

local AH = {}
_G.AgentHub = AH

local MAX_QUEUE = 20
local MAX_AGE = 24 * 60 * 60
local PREFIX = "|cff7fe39aAgent Hub|r: "

local function say(msg)
  print(PREFIX .. msg)
end
AH.say = say

local function db()
  AgentHubDB = AgentHubDB or {}
  if type(AgentHubDB.queue) ~= "table" then
    AgentHubDB.queue = {}
  end
  return AgentHubDB
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

AH.db = db

local function unsentCount()
  local n = 0
  for _, e in ipairs(db().queue) do
    if not e.sent then
      n = n + 1
    end
  end
  return n
end

-- Ids the desktop app has finished with (launched, sent, or refused with a
-- notification), from the Data.lua it wrote before this load.
local function handledIds()
  local out = {}
  local data = _G.AgentHubData
  if type(data) == "table" and type(data.handled) == "table" then
    for _, id in ipairs(data.handled) do
      out[id] = true
    end
  end
  return out
end

-- An entry leaves the queue only once the desktop app acknowledges it, or
-- after a day (the app ignores older requests too). Anything still here was
-- written to disk by the reload that just happened, so mark it sent.
local function onLoaded()
  local d = db()
  local now = time()
  local handled = handledIds()
  local kept = {}
  for _, e in ipairs(d.queue) do
    if
      type(e) == "table"
      and not handled[e.id]
      and type(e.createdAt) == "number"
      and now - e.createdAt < MAX_AGE
    then
      e.sent = true
      kept[#kept + 1] = e
    end
  end
  d.queue = kept
end

local function reload()
  if C_UI and C_UI.Reload then
    C_UI.Reload()
  else
    ReloadUI()
  end
end

StaticPopupDialogs["AGENTHUB_SEND"] = {
  text = "Agent Hub: %s\n\nReload the UI to send it now?",
  button1 = "Reload and send",
  button2 = "Later",
  OnAccept = reload,
  timeout = 0,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

AH.unsentCount = unsentCount
AH.onLoaded = onLoaded

local function offerSend(summary)
  if InCombatLockdown() then
    say("Queued. Type /ah send after combat.")
    return
  end
  StaticPopup_Show("AGENTHUB_SEND", summary)
end

local function push(entry, summary)
  -- Counted against everything not yet acknowledged, so a full queue refuses
  -- new requests instead of pushing out ones the app hasn't picked up.
  if #db().queue >= MAX_QUEUE then
    say(
      MAX_QUEUE
        .. " requests are waiting. Is the Agent Hub desktop app running and signed in? /ah clear drops them."
    )
    return false
  end
  entry.id = string.format("%d-%06d%06d", time(), math.random(0, 999999), math.random(0, 999999))
  entry.createdAt = time()
  table.insert(db().queue, entry)
  offerSend(string.format("%d request(s) waiting. Latest: %s", unsentCount(), summary))
  return true
end

-- Start a new session. Returns true when queued.
function AH.startSession(agent, prompt)
  agent = agent or db().defaultAgent
  if not agent or agent == "" then
    say("Pick an agent first: /ah agent <name>, or start with @<agent>.")
    return false
  end
  return push({ agent = agent, prompt = prompt }, "new session for " .. agent .. ".")
end

-- Reply to an existing session. Returns true when queued.
function AH.reply(sessionId, sessionName, prompt)
  -- `|` starts a WoW escape sequence; the popup should show it literally.
  local label = tostring(sessionName or "session"):gsub("|", "||")
  -- Tie the reply to the Hub and account the session list came from, so the
  -- desktop app never sends it anywhere else.
  local data = _G.AgentHubData
  local binding = type(data) == "table" and type(data.binding) == "string" and data.binding or nil
  return push(
    { sessionId = sessionId, binding = binding, prompt = prompt },
    "reply to " .. label .. "."
  )
end

-- Replies to this session the desktop app hasn't acknowledged yet:
-- `{ text, sent }`, where sent means already written to disk by a reload.
function AH.pendingReplies(sessionId)
  local out = {}
  for _, e in ipairs(db().queue) do
    if e.sessionId == sessionId then
      out[#out + 1] = { text = e.prompt, sent = e.sent and true or false }
    end
  end
  return out
end

function AH.refresh()
  if InCombatLockdown() then
    say("Can't reload in combat.")
    return
  end
  reload()
end

local USAGE = {
  "/ah  open your sessions",
  "/ah <prompt>  start a session with your default agent",
  "/ah @<agent> <prompt>  start one with a specific agent",
  "/ah agent <name>  set the default agent",
  "/ah status  show the default agent and waiting requests",
  "/ah send  reload to send waiting requests",
  "/ah clear  drop all waiting requests",
}

local function handle(msg)
  msg = trim(msg or "")
  local cmd, rest = msg:match("^(%S+)%s*(.*)$")
  cmd = cmd and cmd:lower() or ""

  if cmd == "" then
    if AH.toggleWindow then
      AH.toggleWindow()
    end
  elseif cmd == "help" then
    for _, line in ipairs(USAGE) do
      say(line)
    end
  elseif cmd == "agent" then
    if rest == "" then
      say("Default agent: " .. (db().defaultAgent or "none"))
    else
      db().defaultAgent = rest
      say("Default agent set to " .. rest .. ".")
    end
  elseif cmd == "status" then
    say("Default agent: " .. (db().defaultAgent or "none"))
    say(unsentCount() .. " request(s) waiting for a reload.")
    say((#db().queue - unsentCount()) .. " sent, waiting for the desktop app.")
  elseif cmd == "send" then
    if unsentCount() == 0 then
      say("Nothing waiting.")
    else
      offerSend(unsentCount() .. " request(s) waiting.")
    end
  elseif cmd == "clear" then
    local n = #db().queue
    db().queue = {}
    say("Dropped " .. n .. " waiting request(s). Any the desktop app already picked up still run.")
  else
    local agent, prompt = msg:match("^@(%S+)%s+(.+)$")
    if agent then
      AH.startSession(agent, trim(prompt))
    elseif msg:match("^@%S+$") then
      say("Add a prompt after the agent name.")
    else
      AH.startSession(nil, msg)
    end
  end
end

SLASH_AGENTHUB1 = "/ah"
SLASH_AGENTHUB2 = "/agenthub"
SlashCmdList["AGENTHUB"] = handle

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(self, _, name)
  if name == "AgentHub" then
    onLoaded()
    self:UnregisterEvent("ADDON_LOADED")
  end
end)
