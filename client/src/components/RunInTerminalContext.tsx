import { createContext, useContext } from 'react';

/**
 * Lets anything rendered inside the chat transcript offer a "Run in terminal"
 * affordance without knowing the session id or how the terminal pane is
 * opened. `markdownComponents` is a module-level object shared by the wiki,
 * kanban, notes and PR views, so a context — defaulting to `null` — is what
 * keeps the button chat-only: no provider, no button.
 *
 * The handler pastes into the shared shell; it never presses Enter. The user
 * reviews the line and runs it.
 */
export type RunInTerminalHandler = (command: string) => void;

const RunInTerminalContext = createContext<RunInTerminalHandler | null>(null);

export function RunInTerminalProvider({
  onRun,
  children,
}: {
  onRun: RunInTerminalHandler | null;
  children: React.ReactNode;
}) {
  return <RunInTerminalContext.Provider value={onRun}>{children}</RunInTerminalContext.Provider>;
}

/** The active handler, or `null` when there is no terminal to send to. */
export function useRunInTerminal(): RunInTerminalHandler | null {
  return useContext(RunInTerminalContext);
}
