import { useState } from 'react';
import { Bug } from 'lucide-react';
import BugReportModal from './BugReportModal';
import { captureScreenshot } from '../utils/bugReport';

export default function BugReportButton({ projectId, agentId, onToast }: any) {
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

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={capturing}
        className="text-gray-400 hover:text-rose-400 p-2 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center disabled:opacity-50"
        title="Report a bug"
        aria-label="Report a bug"
      >
        <Bug size={18} />
      </button>
      <BugReportModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        initialScreenshotBlob={screenshotBlob}
        initialScreenshotMissReason={screenshotMissReason}
        projectId={projectId}
        agentId={agentId}
        onToast={onToast}
      />
    </>
  );
}
