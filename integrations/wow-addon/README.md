# Agent Hub WoW addon

Your Agent Hub sessions inside World of Warcraft (built for WoW Forever, interface 16001): browse recent sessions, read the latest messages, reply, and start new ones.

Addons can't make network calls, so the Agent Hub desktop app on the same PC relays everything through files (`electron/wow-bridge.ts`):

- **Into the game:** the app rewrites `AgentHub/Data.lua` with your 20 most recent sessions every 20 seconds. The game reads it on each `/reload`, so the window shows the list as of your last reload.
- **Out of the game:** new sessions and replies are queued in the addon's SavedVariables, which the game writes on `/reload` or logout. Every send costs one reload. A request stays queued until the desktop app acknowledges it through `Data.lua`, so nothing is lost while the app is closed or signed out; at 20 waiting requests the addon refuses new ones instead of dropping old ones.

## Install

1. Copy the `AgentHub` folder into `World of Warcraft/<flavor>/Interface/AddOns/`.
2. Keep the Agent Hub desktop app running and signed in. It finds `/Applications/World of Warcraft` (macOS) or `Program Files (x86)\World of Warcraft` (Windows) on its own; set `AGENT_HUB_WOW_DIR` if the game lives elsewhere.
3. If the game lists the addon as out of date after a patch, enable "Load out of date AddOns".

## Use

`/ah` opens the window: sessions on the left, the selected one on the right with a reply box, and a "New session" box underneath the list (start with `@agent` to pick one).

```
/ah agent agent-hub-dev        set the default agent (partial names work if unique)
/ah fix the flaky preview test start a session with the default agent
/ah @qa run the smoke plan     start one with a specific agent
/ah status | send | clear | help
```

After sending, accept the "Reload and send" prompt. The desktop app shows a notification when the request goes through, or why it didn't. Requests older than a day are dropped, and each one runs at most once. A request queued from the window shows up in the list on the reload after it was sent.
