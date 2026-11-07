-- The /ah window: your recent sessions on the left, the selected one on the
-- right with its latest messages and a reply box. The list is the snapshot
-- the desktop app wrote before the last /reload.

local AH = _G.AgentHub

local WIDTH, HEIGHT = 720, 460
local LIST_WIDTH = 260
local ROW_HEIGHT = 38

local STATE_LABELS = {
  working = { "Working", "ffd200" },
  needs_input = { "Needs you", "ff4040" },
  idle = { "Idle", "a0a0a0" },
  finalizing = { "Finalizing", "40c0ff" },
  pushed = { "Pushed", "40ff80" },
  merged = { "Merged", "40ff80" },
}

-- Chat text uses `|` for color codes, links and textures; show it literally.
local function plain(s)
  return (tostring(s or ""):gsub("|", "||"))
end

local function colored(hex, s)
  return "|cff" .. hex .. s .. "|r"
end

local function stateLabel(state)
  local entry = STATE_LABELS[state]
  if entry then
    return colored(entry[2], entry[1])
  end
  return colored("a0a0a0", plain((state or "unknown"):gsub("_", " ")))
end

local function ago(ts)
  if type(ts) ~= "number" or ts <= 0 then
    return "never"
  end
  local d = math.max(0, time() - ts)
  if d < 60 then
    return "just now"
  elseif d < 3600 then
    return math.floor(d / 60) .. "m ago"
  elseif d < 86400 then
    return math.floor(d / 3600) .. "h ago"
  end
  return math.floor(d / 86400) .. "d ago"
end

local function sessions()
  local data = _G.AgentHubData
  if type(data) == "table" and type(data.sessions) == "table" then
    return data.sessions
  end
  return {}
end

local frame, rows, selectedId = nil, {}, nil
local detail = {}

local function selectedSession()
  for _, s in ipairs(sessions()) do
    if s.id == selectedId then
      return s
    end
  end
end

local function renderDetail()
  local s = selectedSession()
  if not s then
    detail.title:SetText("Pick a session")
    detail.meta:SetText("")
    detail.body:SetText(#sessions() == 0
        and "No sessions yet. Is the Agent Hub desktop app running and signed in?"
      or "")
    detail.reply:Disable()
    detail.send:Disable()
  else
    detail.title:SetText(plain(s.name))
    detail.meta:SetText(plain(s.agent) .. "  ·  " .. plain(s.project) .. "  ·  " .. stateLabel(s.state)
      .. "  ·  " .. ago(s.updatedAt))
    local parts = {}
    for _, m in ipairs(type(s.messages) == "table" and s.messages or {}) do
      local who = m.role == "user" and colored("7fe39a", "You") or colored("6cb8f0", plain(s.agent))
      parts[#parts + 1] = who .. "  " .. colored("808080", ago(m.at)) .. "\n" .. plain(m.content)
    end
    for _, pending in ipairs(AH.pendingReplies(s.id)) do
      local status = pending.sent and "sent, waiting for the desktop app" or "waiting for /reload"
      parts[#parts + 1] = colored("7fe39a", "You") .. "  " .. colored("808080", status)
        .. "\n" .. plain(pending.text)
    end
    if #parts == 0 and s.lastReply and s.lastReply ~= "" then
      parts[1] = plain(s.lastReply)
    end
    detail.body:SetText(#parts > 0 and table.concat(parts, "\n\n") or "No messages yet.")
    detail.reply:Enable()
    detail.send:Enable()
  end
  detail.scrollChild:SetHeight(math.max(detail.body:GetStringHeight() + 8, 1))
  detail.scroll:SetVerticalScroll(math.max(0, detail.scrollChild:GetHeight() - detail.scroll:GetHeight()))
end

local function renderList()
  local list = sessions()
  for i, s in ipairs(list) do
    local row = rows[i]
    if not row then
      row = CreateFrame("Button", nil, frame.listChild)
      row:SetSize(LIST_WIDTH - 8, ROW_HEIGHT)
      row:SetPoint("TOPLEFT", 0, -(i - 1) * ROW_HEIGHT)
      row:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
      row.selected = row:CreateTexture(nil, "BACKGROUND")
      row.selected:SetAllPoints()
      row.selected:SetColorTexture(1, 1, 1, 0.08)
      row.name = row:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
      row.name:SetPoint("TOPLEFT", 6, -4)
      row.name:SetPoint("RIGHT", -6, 0)
      row.name:SetJustifyH("LEFT")
      row.name:SetWordWrap(false)
      row.sub = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
      row.sub:SetPoint("TOPLEFT", row.name, "BOTTOMLEFT", 0, -3)
      row.sub:SetPoint("RIGHT", -6, 0)
      row.sub:SetJustifyH("LEFT")
      row.sub:SetWordWrap(false)
      row:SetScript("OnClick", function(self)
        selectedId = self.sessionId
        renderList()
        renderDetail()
      end)
      rows[i] = row
    end
    row.sessionId = s.id
    row.name:SetText(plain(s.name))
    row.sub:SetText(stateLabel(s.state) .. colored("a0a0a0", "  " .. plain(s.agent) .. "  ·  " .. ago(s.updatedAt)))
    row.selected:SetShown(s.id == selectedId)
    row:Show()
  end
  for i = #list + 1, #rows do
    rows[i]:Hide()
  end
  frame.listChild:SetHeight(math.max(#list * ROW_HEIGHT, 1))
  local data = _G.AgentHubData
  frame.status:SetText(colored("a0a0a0", "Updated " .. ago(type(data) == "table" and data.updatedAt or 0)
    .. ". Reload to refresh."))
end

local function sendReply()
  local s = selectedSession()
  local text = strtrim(detail.reply:GetText() or "")
  if not s or text == "" then
    return
  end
  if AH.reply(s.id, s.name, text) then
    detail.reply:SetText("")
    detail.reply:ClearFocus()
    renderDetail()
  end
end

local function startNew()
  local text = strtrim(frame.newBox:GetText() or "")
  if text == "" then
    return
  end
  local agent, prompt = text:match("^@(%S+)%s+(.+)$")
  if AH.startSession(agent, prompt or text) then
    frame.newBox:SetText("")
    frame.newBox:ClearFocus()
  end
end

local function editBox(parent, width)
  local box = CreateFrame("EditBox", nil, parent, "InputBoxTemplate")
  box:SetSize(width, 22)
  box:SetAutoFocus(false)
  box:SetMaxLetters(1000)
  box:SetScript("OnEscapePressed", box.ClearFocus)
  return box
end

local function button(parent, text, width, onClick)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width, 22)
  b:SetText(text)
  b:SetScript("OnClick", onClick)
  return b
end

local function build()
  frame = CreateFrame("Frame", "AgentHubFrame", UIParent, "BasicFrameTemplateWithInset")
  frame:SetSize(WIDTH, HEIGHT)
  frame:SetPoint("CENTER")
  frame:SetFrameStrata("DIALOG")
  frame:SetMovable(true)
  frame:SetClampedToScreen(true)
  frame:EnableMouse(true)
  frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", frame.StartMoving)
  frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
  frame:Hide()
  tinsert(UISpecialFrames, "AgentHubFrame")

  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  title:SetPoint("TOP", 0, -5)
  title:SetText("Agent Hub")

  -- Session list
  local list = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
  list:SetPoint("TOPLEFT", 10, -30)
  list:SetSize(LIST_WIDTH - 24, HEIGHT - 112)
  frame.listChild = CreateFrame("Frame", nil, list)
  frame.listChild:SetSize(LIST_WIDTH - 8, 1)
  list:SetScrollChild(frame.listChild)

  -- New session
  frame.newBox = editBox(frame, LIST_WIDTH - 70)
  frame.newBox:SetPoint("BOTTOMLEFT", 18, 38)
  frame.newBox:SetScript("OnEnterPressed", startNew)
  local newLabel = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  newLabel:SetPoint("BOTTOMLEFT", frame.newBox, "TOPLEFT", -4, 2)
  newLabel:SetText("New session (start with @agent to pick one)")
  button(frame, "Start", 54, startNew):SetPoint("LEFT", frame.newBox, "RIGHT", 6, 0)

  -- Footer
  frame.status = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  frame.status:SetPoint("BOTTOMLEFT", 14, 14)
  button(frame, "Reload", 70, AH.refresh):SetPoint("BOTTOMLEFT", LIST_WIDTH - 70, 10)

  -- Detail pane
  local left = LIST_WIDTH + 14
  detail.title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  detail.title:SetPoint("TOPLEFT", left, -32)
  detail.title:SetPoint("RIGHT", -14, 0)
  detail.title:SetJustifyH("LEFT")
  detail.title:SetWordWrap(false)
  detail.meta = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  detail.meta:SetPoint("TOPLEFT", detail.title, "BOTTOMLEFT", 0, -4)
  detail.meta:SetPoint("RIGHT", -14, 0)
  detail.meta:SetJustifyH("LEFT")

  detail.scroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
  detail.scroll:SetPoint("TOPLEFT", left, -72)
  detail.scroll:SetPoint("BOTTOMRIGHT", -32, 44)
  detail.scrollChild = CreateFrame("Frame", nil, detail.scroll)
  detail.scrollChild:SetSize(WIDTH - left - 40, 1)
  detail.scroll:SetScrollChild(detail.scrollChild)
  detail.body = detail.scrollChild:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  detail.body:SetPoint("TOPLEFT")
  detail.body:SetWidth(WIDTH - left - 44)
  detail.body:SetJustifyH("LEFT")
  detail.body:SetJustifyV("TOP")
  detail.body:SetSpacing(2)

  detail.reply = editBox(frame, WIDTH - left - 90)
  detail.reply:SetPoint("BOTTOMLEFT", left + 6, 12)
  detail.reply:SetScript("OnEnterPressed", sendReply)
  detail.send = button(frame, "Reply", 64, sendReply)
  detail.send:SetPoint("LEFT", detail.reply, "RIGHT", 6, 0)

  frame:SetScript("OnShow", function()
    if not selectedSession() then
      local first = sessions()[1]
      selectedId = first and first.id or nil
    end
    renderList()
    renderDetail()
  end)
end

function AH.toggleWindow()
  if not frame then
    build()
  end
  frame:SetShown(not frame:IsShown())
end
