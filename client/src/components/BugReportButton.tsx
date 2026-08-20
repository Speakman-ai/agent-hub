import { useState } from 'react';
import { Bug } from 'lucide-react';
import BugReportModal from './BugReportModal';
import { captureScreenshot, BUG_REPORT_ENABLED } from '../utils/bugReport';

export default function BugReportButton({
  projectId,
  agentId,
  onToast,
  descriptionPrefix,
  label,
}: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [screenshotBlob, setScreenshotBlob] = useState<any>(null);
  const [screenshotMissReason, setScreenshotMissReason] = useState<any>(null);
  const [capturing, setCapturing] = useState(false);

  const handleClick = async () => {
    if (capturing) return;
    setCapturing(true);
    let blob = null;
    let missReason = null;
    try {
      blob = await captureScreenshot();
    } catch (err: any) {
      // Don't block the user — open the modal without a screenshot. The modal
      // shows an empty-state hint and a "Retake screenshot" button.
      console.warn('Bug report screenshot capture failed:', err);
      blob = null;
      missReason = 'initial-capture-failed';
    } finally {
      setScreenshotBlob(blob);
      setScreenshotMissReason(missReason);
      setIsOpen(true);
      setCapturing(false);
    }
  };

  // Self-hosted builds that haven't configured an intake endpoint don't phone
  // home — so there's no "Report a bug" control to offer. Checked after the
  // hooks above (a module constant, so hook order stays stable across renders).
  if (!BUG_REPORT_ENABLED) return null;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={capturing}
        className={
          label
            ? 'inline-flex items-center gap-1.5 rounded-lg border border-rose-900/60 bg-rose-950/40 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-900/40 transition-colors disabled:opacity-50'
            : 'text-gray-400 hover:text-rose-400 p-2 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center disabled:opacity-50'
        }
        title="Report a bug"
        aria-label="Report a bug"
      >
        <Bug size={label ? 13 : 18} />
        {label ? <span>{label}</span> : null}
      </button>
      <BugReportModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        initialScreenshotBlob={screenshotBlob}
        initialScreenshotMissReason={screenshotMissReason}
        projectId={projectId}
        agentId={agentId}
        descriptionPrefix={descriptionPrefix}
        onToast={onToast}
      />
    </>
  );
}
