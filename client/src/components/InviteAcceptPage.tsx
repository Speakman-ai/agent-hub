import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { setToken } from '../utils/auth';
import BrandLogo from './BrandLogo';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function inviteStateMessage(error: any) {
  const message = String(error?.message || error || '');
  if (message.includes('410')) return 'This invite has expired or was already used.';
  if (message.includes('404')) return 'This invite link was not found.';
  return message || 'Unable to load invite.';
}

export default function InviteAcceptPage({ token }: any) {
  const [invite, setInvite] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const body = await api.previewInvite(token);
        if (cancelled) return;
        setInvite(body);
        setEmail(body.email || '');
        if (body.accepted) setError('This invite has already been accepted.');
      } catch (err: any) {
        if (!cancelled) setError(inviteStateMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (event: any) => {
    event.preventDefault();
    const nextEmail = email.trim();
    setError(null);
    if (!isValidEmail(nextEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Enter a password.');
      return;
    }
    setSubmitting(true);
    try {
      const body = await api.acceptInvite(token, {
        email: nextEmail,
        username: nextEmail,
        password,
      });
      setToken(body);
      setAccepted(true);
      window.location.assign('/');
    } catch (err: any) {
      setError(inviteStateMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-6">
        <div className="flex flex-col items-center gap-2 mb-5">
          <BrandLogo size="lg" />
          <h1 className="text-lg font-semibold text-white">Join Agent Hub</h1>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-gray-400 py-8">
            <Loader2 size={16} className="animate-spin" /> Loading invite…
          </div>
        ) : invite ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="rounded-lg border border-gray-700 bg-gray-800 p-3 text-sm text-gray-300">
              <p>
                You were invited to <span className="text-white font-medium">{invite.orgName}</span>{' '}
                as <span className="text-white font-medium">{invite.role}</span>.
              </p>
              <p className="text-xs text-gray-500 mt-1">Expires {invite.expiresAt}</p>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1" htmlFor="invite-email">
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e: any) => setEmail(e.target.value)}
                disabled={!!invite.email || submitting || accepted}
                autoComplete="email"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded text-white disabled:opacity-70"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1" htmlFor="invite-password">
                Password
              </label>
              <input
                id="invite-password"
                type="password"
                value={password}
                onChange={(e: any) => setPassword(e.target.value)}
                disabled={submitting || accepted}
                autoComplete="new-password"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded text-white"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {accepted && (
              <div
                role="status"
                className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded p-2"
              >
                <CheckCircle size={14} /> Invite accepted. Redirecting…
              </div>
            )}

            <button
              type="submit"
              disabled={
                submitting ||
                accepted ||
                !!invite.accepted ||
                !isValidEmail(email) ||
                password.length === 0
              }
              className="w-full inline-flex items-center justify-center gap-2 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
              {submitting ? 'Accepting…' : 'Accept invite'}
            </button>
          </form>
        ) : (
          <div
            role="alert"
            className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded p-3"
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{error || 'Unable to load invite.'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
