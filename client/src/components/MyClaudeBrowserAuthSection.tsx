import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';

type Attempt = { loginId: string; loginUrl: string; codeSubmitted?: boolean };

export default function MyClaudeBrowserAuthSection() {
  const [status, setStatus] = useState<any>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(true);
  const [code, setCode] = useState('');
  const [submissionGeneration, setSubmissionGeneration] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  // Invalidated requests cannot keep controls busy or clear a newer submission.
  const submitting = submissionGeneration === generation.current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function invalidate() {
    generation.current += 1;
    setSubmissionGeneration(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    return generation.current;
  }

  async function refresh(version: number, loginId?: string) {
    try {
      const next = await api.getMyClaudeBrowserAuth();
      if (generation.current !== version) return;
      setStatus(next);
      if (loginId && next.loginId && next.loginId !== loginId) {
        setAttempt(null);
        setCode('');
        setBusy(false);
        invalidate();
        setMessage('This sign-in was replaced in another window. Start again.');
        return;
      }
      if (next.loginInProgress) {
        if (next.loginUrl && next.loginId) {
          setAttempt((current) => ({
            ...next,
            codeSubmitted:
              next.codeSubmitted || (current?.loginId === next.loginId && current?.codeSubmitted),
          }));
        }
        setBusy(true);
        timer.current = setTimeout(() => void refresh(version, next.loginId), 3000);
      } else {
        invalidate();
        setAttempt(null);
        setCode('');
        setBusy(false);
        if (next.statusError) setMessage(next.statusError);
        else if (loginId)
          setMessage(
            next.oauth?.loggedIn
              ? 'Signed in to Claude Code.'
              : 'Sign-in did not finish. Start again.',
          );
      }
    } catch (err: any) {
      if (generation.current !== version) return;
      setMessage(err.message || 'Could not check Claude sign-in.');
      setBusy(false);
      // A transient status failure must not abandon a running login.
      if (loginId) timer.current = setTimeout(() => void refresh(version, loginId), 3000);
    }
  }

  useEffect(() => {
    const version = invalidate();
    void refresh(version);
    return () => {
      invalidate();
    };
    // API methods are stable; all requests are invalidated on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    const version = invalidate();
    setBusy(true);
    setAttempt(null);
    setCode('');
    setMessage('');
    try {
      const result = await api.startMyClaudeBrowserLogin();
      if (generation.current !== version) return;
      if (!result.ok) throw new Error(result.output || 'Could not start Claude sign-in.');
      if (result.loginUrl && result.loginId) {
        setAttempt(result);
        // The explicit link also works when the browser blocks this popup.
        try {
          window.open(result.loginUrl, '_blank', 'noopener,noreferrer');
        } catch {
          /* The sign-in link stays available. */
        }
        timer.current = setTimeout(() => void refresh(version, result.loginId), 3000);
      } else {
        await refresh(version, result.loginId);
      }
    } catch (err: any) {
      if (generation.current !== version) return;
      setBusy(false);
      setMessage(err.message || 'Could not start Claude sign-in.');
    }
  }

  async function cancel() {
    const version = invalidate();
    setBusy(true);
    setCode('');
    try {
      await api.cancelMyClaudeBrowserLogin();
      if (generation.current !== version) return;
      setAttempt(null);
      setMessage('Sign-in cancelled.');
      await refresh(version);
    } catch (err: any) {
      if (generation.current !== version) return;
      setMessage(err.message || 'Could not cancel sign-in.');
      await refresh(version, attempt?.loginId);
    }
  }

  async function signOut() {
    const version = invalidate();
    setBusy(true);
    setMessage('');
    try {
      await api.logoutMyClaudeBrowser();
      if (generation.current !== version) return;
      setMessage('Signed out of Claude Code.');
      await refresh(version);
    } catch (err: any) {
      if (generation.current !== version) return;
      setMessage(err.message || 'Could not sign out.');
      setBusy(false);
    }
  }

  async function submit() {
    if (!attempt || !code.trim() || submitting || attempt.codeSubmitted) return;
    const version = generation.current;
    const loginId = attempt.loginId;
    setSubmissionGeneration(version);
    setMessage('');
    const value = code.trim();
    setCode('');
    try {
      await api.submitMyClaudeBrowserCode(loginId, value);
      if (generation.current !== version) return;
      setAttempt((current) =>
        current?.loginId === loginId ? { ...current, codeSubmitted: true } : current,
      );
      setMessage('Code sent. Waiting for Claude Code to finish signing in.');
    } catch (err: any) {
      if (generation.current === version) setMessage(err.message || 'Could not submit the code.');
    } finally {
      if (generation.current === version) setSubmissionGeneration(null);
    }
  }

  const signedIn = status?.oauth?.loggedIn && !attempt;
  const buttonClass =
    'rounded border border-gray-600 px-3 py-2 text-xs text-gray-200 disabled:opacity-50';
  return (
    <section aria-label="Claude Code browser sign-in" className="space-y-3">
      <h5 className="text-xs font-medium text-gray-300">Claude Code browser sign-in</h5>
      <p className="text-xs text-gray-400">
        Sign in with your Claude account. Claude Code saves the sign-in for sessions you own.
      </p>
      {signedIn && <p className="text-xs text-emerald-300">Signed in</p>}
      {message && (
        <p role="status" className="text-xs text-gray-300">
          {message}
        </p>
      )}
      {attempt && (
        <div className="space-y-3 rounded border border-gray-700 p-3">
          <a
            href={attempt.loginUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-300 underline"
          >
            Open Claude sign-in
          </a>
          <p className="text-xs text-gray-400">
            Complete sign-in in the browser. If Claude shows an authorization code, paste the
            complete code here.
          </p>
          {!attempt.codeSubmitted && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="space-y-2"
            >
              <input
                aria-label="Claude authorization code"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={submitting}
                className="w-full rounded border border-gray-700 bg-gray-900 p-2 text-sm text-white"
              />
              <button type="submit" className={buttonClass} disabled={submitting || !code.trim()}>
                {submitting ? 'Submitting…' : 'Submit code'}
              </button>
            </form>
          )}
          {attempt.codeSubmitted && (
            <p className="text-xs text-gray-400">Waiting for sign-in to finish…</p>
          )}
        </div>
      )}
      {attempt || (busy && !signedIn && status) ? (
        <button type="button" className={buttonClass} onClick={() => void cancel()}>
          Cancel sign-in
        </button>
      ) : signedIn ? (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void signOut()}
        >
          Sign out of Claude Code
        </button>
      ) : (
        <button
          type="button"
          className={buttonClass}
          disabled={busy || status?.binary?.present === false}
          onClick={() => void start()}
        >
          {busy ? 'Checking sign-in…' : 'Sign in with browser'}
        </button>
      )}
      {status?.binary?.present === false && (
        <p className="text-xs text-amber-300">Claude Code is not installed on this server.</p>
      )}
    </section>
  );
}
