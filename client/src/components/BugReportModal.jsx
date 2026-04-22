import { useEffect, useMemo, useState } from 'react';
import { Bug, Camera, Loader2, X } from 'lucide-react';
import { captureScreenshot, submitBugReport } from '../utils/bugReport.js';

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

export default function BugReportModal({
  isOpen,
  onClose,
  initialScreenshotBlob,
  projectId,
  agentId,
  onToast,
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [screenshotBlob, setScreenshotBlob] = useState(initialScreenshotBlob || null);
  const [submitting, setSubmitting] = useState(false);
  const [retaking, setRetaking] = useState(false);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(false);

  // Reset state whenever the modal is (re)opened.
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setSeverity('medium');
      setScreenshotBlob(initialScreenshotBlob || null);
      setError(null);
      setSubmitting(false);
      setRetaking(false);
      setHidden(false);
    }
  }, [isOpen, initialScreenshotBlob]);

  // Build an object URL for the preview and revoke it when the blob changes.
  const previewUrl = useMemo(() => {
    if (!screenshotBlob) return null;
    return URL.createObjectURL(screenshotBlob);
  }, [screenshotBlob]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!isOpen) return null;

  const handleRetake = async () => {
    setRetaking(true);
    setError(null);
    // Hide the modal for a tick so the fresh capture doesn't include it.
    setHidden(true);
    try {
      // Wait two animation frames to let the DOM repaint without the modal.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const blob = await captureScreenshot();
      setScreenshotBlob(blob);
    } catch (err) {
      setError(`Screenshot failed: ${err?.message || String(err)}`);
    } finally {
      setHidden(false);
      setRetaking(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitBugReport({
        title,
        description,
        severity,
        screenshotBlob,
        projectId,
        agentId,
      });
      if (typeof onToast === 'function') {
        onToast(
          "Bug reported — the intake agent is processing your report. It'll appear on the board shortly.",
          'info',
        );
      }
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to submit bug report');
    } finally {
      setSubmitting(false);
    }
  };

  if (hidden) {
    // Still mounted (keeps state) but invisible during re-capture.
    return null;
  }

  const canSubmit = !!title.trim() && !submitting;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Report a bug"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Bug size={20} className="text-rose-400" />
            Report a bug
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto">
          <div>
            <label htmlFor="bug-title" className="block text-sm text-gray-400 mb-1.5">
              Title <span className="text-rose-400">*</span>
            </label>
            <input
              id="bug-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary of the issue"
              maxLength={200}
              required
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-1 text-right">{title.length}/200</p>
          </div>

          <div>
            <label htmlFor="bug-description" className="block text-sm text-gray-400 mb-1.5">
              Description
            </label>
            <textarea
              id="bug-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs. actual behavior, context…"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none resize-y"
            />
            <p className="text-xs text-gray-500 mt-1">
              Optional. Included in the report body sent to intake.
            </p>
          </div>

          <div>
            <label htmlFor="bug-severity" className="block text-sm text-gray-400 mb-1.5">
              Severity
            </label>
            <select
              id="bug-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            >
              {SEVERITIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Submitted with your report; the intake workflow maps this to the new card&apos;s
              priority.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-gray-400">Screenshot</span>
              <button
                type="button"
                onClick={handleRetake}
                disabled={retaking || submitting}
                className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md px-2 py-1 disabled:opacity-50"
              >
                {retaking ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                Retake screenshot
              </button>
            </div>
            {previewUrl ? (
              <div className="rounded-lg border border-gray-700 overflow-hidden bg-gray-950">
                <img
                  src={previewUrl}
                  alt="Bug report screenshot preview"
                  className="w-full max-h-64 object-contain"
                />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-700 bg-gray-950/60 px-3 py-6 text-center text-xs text-gray-500">
                No screenshot yet. Use &quot;Retake screenshot&quot; to capture the window; it is
                attached when you submit.
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center gap-2 bg-rose-600 hover:bg-rose-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />}
              {submitting ? 'Submitting…' : 'Submit bug report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
