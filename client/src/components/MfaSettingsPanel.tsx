import { useEffect, useState } from 'react';
import { Copy, Loader2, QrCode, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import QRCode from 'qrcode';
import { api } from '../utils/api';

function errorMessage(err: any) {
  return err?.message || String(err);
}

function normalizeCode(value: string) {
  return value.trim().replace(/\s+/g, '');
}

export default function MfaSettingsPanel({ mfaEnabled, onMfaChanged }: any) {
  const [enrollment, setEnrollment] = useState<any>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [actionCode, setActionCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl('');
    if (!enrollment?.otpauthUri) return;
    QRCode.toDataURL(enrollment.otpauthUri, { margin: 1, width: 192 })
      .then((url: any) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment?.otpauthUri]);

  const startEnrollment = async () => {
    setBusy('start');
    setStatus(null);
    setRecoveryCodes([]);
    setCode('');
    try {
      const body = await api.startMfaEnrollment();
      setEnrollment(body);
      setStatus({ type: 'success', msg: 'Scan the QR code, then enter a current code.' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirmEnrollment = async () => {
    setBusy('confirm');
    setStatus(null);
    try {
      const body = await api.confirmMfaEnrollment(normalizeCode(code));
      setRecoveryCodes(body.recoveryCodes || []);
      setEnrollment(null);
      setCode('');
      onMfaChanged?.(true);
      setStatus({ type: 'success', msg: 'MFA enabled. Save these recovery codes now.' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const regenerateCodes = async () => {
    setBusy('regenerate');
    setStatus(null);
    try {
      const body = await api.regenerateMfaRecoveryCodes(normalizeCode(actionCode));
      setRecoveryCodes(body.recoveryCodes || []);
      setActionCode('');
      setStatus({ type: 'success', msg: 'Recovery codes regenerated. Save the new codes now.' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    if (!window.confirm('Disable MFA for your account?')) return;
    setBusy('disable');
    setStatus(null);
    try {
      await api.disableMfa(normalizeCode(actionCode));
      setActionCode('');
      setEnrollment(null);
      setRecoveryCodes([]);
      onMfaChanged?.(false);
      setStatus({ type: 'success', msg: 'MFA disabled.' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const copySecret = async () => {
    if (!enrollment?.secret) return;
    await navigator.clipboard?.writeText(enrollment.secret);
    setStatus({ type: 'success', msg: 'Manual secret copied.' });
  };

  const copyRecoveryCodes = async () => {
    if (recoveryCodes.length === 0) return;
    await navigator.clipboard?.writeText(recoveryCodes.join('\n'));
    setStatus({ type: 'success', msg: 'Recovery codes copied.' });
  };

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <ShieldCheck size={14} /> Multi-factor authentication
          </h4>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
            App-based one-time codes plus single-use recovery codes.
          </p>
        </div>
        <span className={`text-[11px] ${mfaEnabled ? 'text-emerald-300' : 'text-gray-500'}`}>
          {mfaEnabled ? 'Enabled' : 'Not enabled'}
        </span>
      </div>

      {!mfaEnabled && !enrollment && recoveryCodes.length === 0 && (
        <button
          type="button"
          onClick={startEnrollment}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
        >
          {busy === 'start' ? <Loader2 size={12} className="animate-spin" /> : <QrCode size={12} />}
          Start enrollment
        </button>
      )}

      {enrollment && (
        <div className="grid grid-cols-1 md:grid-cols-[12rem_1fr] gap-4 border border-gray-700 rounded-lg p-3">
          <div className="bg-white rounded-md p-2 w-48 h-48 flex items-center justify-center">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="MFA QR code" className="w-44 h-44" />
            ) : (
              <Loader2 size={18} className="animate-spin text-gray-700" />
            )}
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Manual secret</label>
              <div className="flex gap-2">
                <code className="flex-1 break-all rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-gray-200">
                  {enrollment.secret}
                </code>
                <button
                  type="button"
                  onClick={copySecret}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700"
                >
                  <Copy size={12} /> Copy
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1" htmlFor="mfa-confirm-code">
                Current code
              </label>
              <input
                id="mfa-confirm-code"
                value={code}
                onChange={(e: any) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={confirmEnrollment}
                disabled={busy !== null || !normalizeCode(code)}
                className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
              >
                {busy === 'confirm' ? <Loader2 size={12} className="animate-spin" /> : null}
                Confirm and enable
              </button>
              <button
                type="button"
                onClick={() => {
                  setEnrollment(null);
                  setCode('');
                }}
                className="text-xs text-gray-400 hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-amber-100">Recovery codes are shown once.</p>
            <button
              type="button"
              onClick={copyRecoveryCodes}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-500/40 text-amber-100 hover:bg-amber-500/10"
            >
              <Copy size={12} /> Copy codes
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {recoveryCodes.map((item: any) => (
              <code key={item} className="rounded bg-gray-950 px-2 py-1.5 text-xs text-gray-100">
                {item}
              </code>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRecoveryCodes([])}
            className="text-xs text-amber-100 hover:text-white"
          >
            I saved these codes
          </button>
        </div>
      )}

      {mfaEnabled && (
        <div className="border border-gray-700 rounded-lg p-3 space-y-3">
          <label className="block text-xs text-gray-400" htmlFor="mfa-action-code">
            Authenticator or recovery code
            <input
              id="mfa-action-code"
              value={actionCode}
              onChange={(e: any) => setActionCode(e.target.value)}
              autoComplete="one-time-code"
              className="mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={regenerateCodes}
              disabled={busy !== null || !normalizeCode(actionCode)}
              className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              {busy === 'regenerate' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Regenerate recovery codes
            </button>
            <button
              type="button"
              onClick={disable}
              disabled={busy !== null || !normalizeCode(actionCode)}
              className="inline-flex items-center gap-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50 text-xs px-3 py-1.5 rounded-lg"
            >
              {busy === 'disable' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ShieldOff size={12} />
              )}
              Disable MFA
            </button>
          </div>
        </div>
      )}

      {status && (
        <div
          role={status.type === 'success' ? 'status' : 'alert'}
          className={`text-xs ${status.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}
