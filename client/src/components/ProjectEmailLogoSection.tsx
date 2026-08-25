import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Eye, Image as ImageIcon, Loader2, Trash2, Upload, X } from 'lucide-react';
import { api } from '../utils/api';
import { hasRole, isLocalBundledDeployment } from '../utils/auth';

interface ProjectEmailLogo {
  filename: string;
  contentType: string;
  size: number;
  updatedAt: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Admin-gated control to upload a per-project logo that overrides the global
 * Agent Hub logo in this project's release/deployment notification emails.
 */
export default function ProjectEmailLogoSection({
  projectId,
  showToast,
}: {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
}) {
  const [logo, setLogo] = useState<ProjectEmailLogo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic request generation. Every intent that changes the displayed
  // logo/preview (project switch, load, upload, remove) claims a new value;
  // async results commit only while their generation is still the latest, so
  // out-of-order completions (even for the same project) can never win.
  const requestRef = useRef(0);
  const canEdit = hasRole('Admin') || isLocalBundledDeployment();

  // ── One root cause: this component instance is reused across projects (only
  // the `projectId` prop changes), so it must (1) never render a previous
  // project's state and (2) never let a previous project's async op write into
  // the current one. Both are handled synchronously against the rendered prop.

  // (1) Reset ALL project-bound state synchronously when the identity changes —
  // during render, before commit — so project B never shows project A's logo or
  // controls, not even for the single render before B's request resolves. This
  // is React's supported "adjust state when a prop changes" pattern (the extra
  // render is discarded before the browser paints).
  const [boundProjectId, setBoundProjectId] = useState<string | null | undefined>(projectId);
  if (projectId !== boundProjectId) {
    setBoundProjectId(projectId);
    setLogo(null);
    setPreviewUrl(null); // old blob revoked by the previewUrl-keyed effect below
    setBusy(false);
    setError(null);
    setLoading(false);
    setPreviewHtml(null);
    setPreviewLoading(false);
    requestRef.current += 1; // invalidate any in-flight load/preview for the old project
  }

  // (2) The current identity, updated synchronously during render, so an async
  // completion can check whether it is still current before writing state.
  const activeProjectRef = useRef<string | null | undefined>(projectId);
  activeProjectRef.current = projectId;
  const isActive = useCallback(
    (id: string | null | undefined) => activeProjectRef.current === id,
    [],
  );

  // Own the object URL's lifecycle: revoke the previous URL whenever it changes
  // (including the synchronous reset above) and on unmount. Using an effect
  // keyed on `previewUrl` guarantees the cleanup runs, unlike revoking from a
  // state-setter callback (which React may skip on an unmounted component).
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Load the preview for a specific request generation. Project identity alone
  // is not enough: two loads for the SAME project (e.g. the initial load and an
  // upload's reload) can resolve out of order, so a stale earlier result could
  // otherwise win. Only the latest generation may commit; superseded results
  // revoke their object URL and bail.
  const loadPreview = useCallback(async (id: string, gen: number) => {
    const url = await api.fetchProjectEmailLogoObjectUrl(id);
    if (gen !== requestRef.current) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    setPreviewUrl(url);
  }, []);

  useEffect(() => {
    if (!projectId) return undefined;
    const gen = (requestRef.current += 1);
    setLoading(true);
    api
      .getProjectEmailLogo(projectId)
      .then((res: { emailLogo: ProjectEmailLogo | null }) => {
        if (gen !== requestRef.current) return; // superseded by a newer request
        setLogo(res?.emailLogo ?? null);
        if (res?.emailLogo) void loadPreview(projectId, gen);
        else setPreviewUrl(null);
      })
      .catch((err: any) => {
        if (gen === requestRef.current) setError(err?.message || 'Failed to load project logo.');
      })
      .finally(() => {
        if (gen === requestRef.current) setLoading(false);
      });
    return undefined;
  }, [projectId, loadPreview]);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      const id = projectId;
      if (!file || !id) return;
      if (!ALLOWED.includes(file.type)) {
        setError('Choose a PNG, JPEG, GIF, or WebP image.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setError('Image must be 2MB or smaller.');
        return;
      }
      // Claim the generation at intent start (BEFORE any async work), so an ABA
      // switch (p1 -> p2 -> p1) can't let this stale upload pass a later identity
      // check and then claim a fresh generation to overwrite newer state. Commit
      // only while BOTH the generation and the project identity are current.
      const gen = (requestRef.current += 1);
      setBusy(true);
      setError(null);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        // Re-check after the FileReader await: if the project changed while it
        // was pending, do not issue the PUT to the now-stale project at all.
        if (gen !== requestRef.current || !isActive(id)) return;
        const res = await api.updateProjectEmailLogo(id, dataUrl);
        if (gen !== requestRef.current || !isActive(id)) return;
        setLogo(res.emailLogo);
        await loadPreview(id, gen);
        if (gen === requestRef.current && isActive(id))
          showToast?.('Project email logo updated', 'success');
      } catch (err: any) {
        if (gen === requestRef.current && isActive(id))
          setError(err?.message || 'Failed to upload logo.');
      } finally {
        if (gen === requestRef.current && isActive(id)) setBusy(false);
      }
    },
    [projectId, loadPreview, showToast, isActive],
  );

  const handleRemove = useCallback(async () => {
    const id = projectId;
    if (!id) return;
    // Claim the generation at intent start (see handleFile) so a stale ABA
    // removal cannot commit over newer state.
    const gen = (requestRef.current += 1);
    setBusy(true);
    setError(null);
    try {
      await api.deleteProjectEmailLogo(id);
      if (gen !== requestRef.current || !isActive(id)) return;
      setLogo(null);
      setPreviewUrl(null);
      showToast?.('Reverted to the default Agent Hub logo', 'success');
    } catch (err: any) {
      if (gen === requestRef.current && isActive(id))
        setError(err?.message || 'Failed to remove logo.');
    } finally {
      if (gen === requestRef.current && isActive(id)) setBusy(false);
    }
  }, [projectId, showToast, isActive]);

  const handlePreview = useCallback(async () => {
    const id = projectId;
    if (!id) return;
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await api.getReleaseEmailPreview(id);
      if (!isActive(id)) return;
      setPreviewHtml(res.html);
    } catch (err: any) {
      if (isActive(id)) setError(err?.message || 'Failed to load email preview.');
    } finally {
      if (isActive(id)) setPreviewLoading(false);
    }
  }, [projectId, isActive]);

  return (
    <div
      className="bg-gray-800/30 border border-gray-700 rounded-xl p-4"
      data-testid={`project-email-logo-${projectId}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <ImageIcon size={16} className="text-sky-400" />
        <h4 className="text-sm font-semibold text-gray-200">Email logo</h4>
        {(loading || busy) && <Loader2 size={14} className="animate-spin text-gray-400" />}
      </div>
      <p className="text-xs text-gray-500 mb-3 max-w-2xl">
        Overrides the default Agent Hub logo shown in this project&apos;s release and deployment
        notification emails. Leave unset to use the default. PNG, JPEG, GIF, or WebP, up to 2MB.
      </p>

      <div className="flex items-center gap-4">
        <div className="w-40 h-16 rounded-lg border border-gray-700 bg-gray-950/70 flex items-center justify-center overflow-hidden shrink-0">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Project email logo"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <span className="text-[11px] text-gray-600">Default logo</span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED.join(',')}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !projectId}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-600 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload size={13} />
              {logo ? 'Replace' : 'Upload'}
            </button>
            {logo && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 size={13} />
                Remove
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handlePreview}
          disabled={previewLoading || !projectId}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Preview the branded release/deployment email"
        >
          {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
          Preview email
        </button>
      </div>

      {!canEdit && (
        <p className="mt-3 text-xs text-gray-600">Admin role required to change the email logo.</p>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {previewHtml !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Email preview"
          onClick={() => setPreviewHtml(null)}
          data-testid="email-preview-modal"
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <h4 className="text-sm font-semibold text-gray-200">Email preview</h4>
              <button
                type="button"
                onClick={() => setPreviewHtml(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                aria-label="Close preview"
              >
                <X size={16} />
              </button>
            </div>
            <iframe
              title="Branded email preview"
              sandbox=""
              srcDoc={previewHtml}
              className="w-full flex-1 min-h-[420px] bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
