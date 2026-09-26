import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createUseLiveRef } from '@shared/hooks/useLiveRef';

const useLiveRef = createUseLiveRef({ useEffect, useRef });
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderInput,
  Trash2,
  Upload,
  BookOpen,
} from 'lucide-react';
import { getAuthHeaders } from '../utils/connection';
import {
  buildWikiFolderTree,
  formatWikiFileSize,
  listWikiFolderPaths,
  normalizeWikiFolderInput,
  wikiFileUploadUrl,
  WIKI_FILE_ACCEPT,
  WIKI_UPLOAD_MAX_ATTEMPTS,
  wikiUploadRetryDelayMs,
  wikiFileActionError,
  type WikiFileWire,
  type WikiFolderNode,
} from '@shared/utils/wikiFiles';

interface UploadStatus {
  /** Stable per-upload id; results are applied by id, never by list position. */
  id: number;
  name: string;
  state: 'uploading' | 'done' | 'error';
  message?: string;
}

interface WikiFilesProps {
  projectId: string;
  apiBase: string;
  onOpenPage: (slug: string) => void;
}

/**
 * Files view of the wiki: upload documents into folders. Each upload's text is
 * extracted into a linked `documents` page, which is what agents retrieve via
 * wiki search and RAG.
 */
export default function WikiFiles(props: WikiFilesProps) {
  // One instance per project. Every piece of state here (the file list,
  // selection, upload rows) belongs to a single project, so switching
  // projects remounts instead of reusing it: callbacks still in flight for
  // the old project (an upload finishing, its refresh, a retry timer) belong
  // to an unmounted instance and cannot touch the new project's view.
  return <WikiFilesForProject key={props.projectId} {...props} />;
}

function WikiFilesForProject({ projectId, apiBase, onOpenPage }: WikiFilesProps) {
  // False once this project's view is gone; stops old callbacks from starting
  // new requests (state setters are already inert after unmount).
  const live = useLiveRef();

  const [files, setFiles] = useState<WikiFileWire[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [uploadFolder, setUploadFolder] = useState('');
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The only way this view talks to the server. Transport failures and non-OK
   * responses both land in the error banner with one consistent message, so
   * no action can fail silently; callers get the Response only on success.
   */
  const request = useCallback(
    async (action: string, path: string, init: RequestInit = {}): Promise<Response | null> => {
      let res: Response;
      try {
        res = await fetch(`${apiBase}/projects/${projectId}/${path}`, {
          ...init,
          headers: { ...getAuthHeaders(), ...(init.headers as Record<string, string>) },
        });
      } catch (err) {
        setError(wikiFileActionError(action, { network: err }));
        return null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(wikiFileActionError(action, { status: res.status, body }));
        return null;
      }
      return res;
    },
    [apiBase, projectId],
  );

  // Within this project, only the newest list request may update state (an
  // upload's refresh and a websocket refresh can overlap).
  const listSeq = useRef(0);
  const fetchFiles = useCallback(async () => {
    if (!projectId || !live.current) return;
    const seq = ++listSeq.current;
    const res = await request('Loading files', 'wiki-files');
    if (!res || seq !== listSeq.current) return;
    try {
      const data = await res.json();
      if (seq === listSeq.current) setFiles(data);
    } catch (err) {
      if (seq === listSeq.current) setError(wikiFileActionError('Loading files', { network: err }));
    }
  }, [projectId, request, live]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId?: string } | undefined;
      if (detail?.projectId === projectId) fetchFiles();
    };
    window.addEventListener('wiki_files_update', handler);
    return () => window.removeEventListener('wiki_files_update', handler);
  }, [projectId, fetchFiles]);

  const tree = useMemo(() => buildWikiFolderTree(files), [files]);
  const folderPaths = useMemo(() => listWikiFolderPaths(tree), [tree]);
  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;

  useEffect(() => {
    setUploadFolder(selectedFolder);
  }, [selectedFolder]);

  useEffect(() => {
    setMoveTarget(selectedFile?.folder ?? '');
    setConfirmDelete(false);
  }, [selectedFile?.id, selectedFile?.folder]);

  const nextUploadId = useRef(0);

  const updateUpload = (id: number, patch: Partial<UploadStatus>) =>
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const uploadFiles = async (list: FileList | File[]) => {
    const picked = Array.from(list).map((file) => ({ file, id: ++nextUploadId.current }));
    if (picked.length === 0) return;
    const folder = normalizeWikiFolderInput(uploadFolder);
    setError(null);
    // Batches may overlap (the picker and drop zone stay live). Keep rows that
    // are still in flight from earlier batches and add this batch's rows.
    setUploads((prev) => [
      ...prev.filter((u) => u.state === 'uploading'),
      ...picked.map(({ file, id }) => ({ id, name: file.name, state: 'uploading' as const })),
    ]);
    for (const { file, id } of picked) {
      try {
        // Always send octet-stream so the server stores the exact bytes; the
        // server picks the extractor from the filename.
        let res: Response;
        for (let attempt = 0; ; attempt++) {
          res = await fetch(wikiFileUploadUrl(apiBase, projectId, folder, file.name), {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/octet-stream' },
            body: file,
          });
          // 503 means the server's upload slots are full; wait and retry.
          if (res.status !== 503 || attempt + 1 >= WIKI_UPLOAD_MAX_ATTEMPTS || !live.current) {
            break;
          }
          const delay = wikiUploadRetryDelayMs(res.headers.get('Retry-After'), attempt);
          updateUpload(id, { message: `server busy, retrying in ${Math.round(delay / 1000)}s` });
          await new Promise((r) => setTimeout(r, delay));
        }
        const body = await res.json().catch(() => ({}));
        updateUpload(
          id,
          res.ok
            ? { state: 'done', message: body.replaced ? 'replaced' : 'indexed' }
            : {
                state: 'error',
                message: wikiFileActionError('Upload', { status: res.status, body }),
              },
        );
      } catch (err) {
        updateUpload(id, {
          state: 'error',
          message: wikiFileActionError('Upload', { network: err }),
        });
      }
    }
    setSelectedFolder(folder);
    fetchFiles();
  };

  const downloadFile = async (file: WikiFileWire) => {
    const res = await request('Download', `wiki-files/${file.id}/download`);
    if (!res) return;
    try {
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(null);
    } catch (err) {
      setError(wikiFileActionError('Download', { network: err }));
    }
  };

  const moveFile = async (file: WikiFileWire) => {
    const res = await request('Move', `wiki-files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: normalizeWikiFolderInput(moveTarget) }),
    });
    if (!res) return;
    const body = await res.json().catch(() => ({}));
    setError(null);
    setSelectedFolder(body.folder ?? '');
    fetchFiles();
  };

  const deleteFile = async (file: WikiFileWire) => {
    const res = await request('Delete', `wiki-files/${file.id}`, { method: 'DELETE' });
    if (!res) return;
    setError(null);
    setSelectedFileId(null);
    fetchFiles();
  };

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderFolder = (node: WikiFolderNode) => {
    const isRoot = node.path === '';
    const isCollapsed = collapsed.has(node.path);
    const pad = { paddingLeft: `${node.depth * 12 + 8}px` };
    return (
      <div key={node.path || '__root'}>
        <div
          onClick={() => {
            setSelectedFolder(node.path);
            setSelectedFileId(null);
          }}
          style={pad}
          className={`flex items-center gap-1.5 pr-2 py-1.5 cursor-pointer text-sm ${
            selectedFolder === node.path && !selectedFileId
              ? 'bg-gray-800 text-white'
              : 'text-gray-300 hover:bg-gray-800/50'
          }`}
        >
          {!isRoot && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.path);
              }}
              className="text-gray-500 hover:text-gray-300"
              aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          {isCollapsed ? (
            <Folder size={14} className="text-amber-400 flex-shrink-0" />
          ) : (
            <FolderOpen size={14} className="text-amber-400 flex-shrink-0" />
          )}
          <span className="truncate flex-1">{isRoot ? 'All files' : node.name}</span>
          <span className="text-xs text-gray-600">{node.totalFiles}</span>
        </div>
        {!isCollapsed && (
          <>
            {node.folders.map(renderFolder)}
            {node.files.map((f) => (
              <div
                key={f.id}
                onClick={() => {
                  setSelectedFileId(f.id);
                  setSelectedFolder(f.folder);
                }}
                style={{ paddingLeft: `${(node.depth + 1) * 12 + 8}px` }}
                className={`flex items-center gap-1.5 pr-2 py-1.5 cursor-pointer text-sm ${
                  selectedFileId === f.id
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-800/50'
                }`}
              >
                <FileText size={14} className="flex-shrink-0 text-gray-500" />
                <span className="truncate flex-1">{f.filename}</span>
                {!f.page_slug && (
                  <span className="text-[10px] text-amber-500" title="Not indexed">
                    !
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="w-[300px] flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
        <div className="flex-1 overflow-y-auto py-1">
          {files.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              No files uploaded yet.
            </div>
          ) : (
            renderFolder(tree)
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-gray-900 overflow-y-auto p-6 gap-6">
        {error && (
          <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {selectedFile ? (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-100 break-all">
                {selectedFile.filename}
              </h1>
              <div className="text-xs text-gray-500 mt-1 space-x-3">
                <span>/{selectedFile.folder}</span>
                <span>{formatWikiFileSize(selectedFile.size_bytes)}</span>
                <span>{selectedFile.extracted_chars.toLocaleString()} chars indexed</span>
                {selectedFile.truncated ? <span className="text-amber-500">truncated</span> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedFile.page_slug ? (
                <button
                  onClick={() => onOpenPage(selectedFile.page_slug!)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg"
                >
                  <BookOpen size={14} />
                  View indexed text
                </button>
              ) : (
                <span className="text-sm text-amber-500 px-1 py-1.5">
                  Not indexed. Re-upload the file to index it again.
                </span>
              )}
              <button
                onClick={() => downloadFile(selectedFile)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg"
              >
                <Download size={14} />
                Download
              </button>
              <button
                onClick={() => (confirmDelete ? deleteFile(selectedFile) : setConfirmDelete(true))}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900 text-red-300 rounded-lg"
              >
                <Trash2 size={14} />
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <FolderInput size={14} className="text-gray-500" />
              <input
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
                list="wiki-folder-options"
                placeholder="Folder (blank for root)"
                className="flex-1 max-w-sm bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600"
              />
              <button
                onClick={() => moveFile(selectedFile)}
                disabled={normalizeWikiFolderInput(moveTarget) === selectedFile.folder}
                className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg disabled:opacity-50"
              >
                Move
              </button>
            </div>
          </div>
        ) : null}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFiles(e.dataTransfer.files);
          }}
          className={`rounded-xl border-2 border-dashed p-6 space-y-4 ${
            dragOver ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700'
          }`}
        >
          <div className="flex items-center gap-2 text-gray-200 font-medium">
            <Upload size={16} />
            Upload documents
          </div>
          <p className="text-sm text-gray-500">
            SOPs, runbooks, and reference docs (PDF, DOCX, Markdown, HTML, text, CSV, JSON, YAML).
            Their text is indexed so agents find them through wiki search. Uploading a file with the
            same name into the same folder replaces it.
          </p>
          <div className="flex items-center gap-2">
            <Folder size={14} className="text-amber-400" />
            <input
              value={uploadFolder}
              onChange={(e) => setUploadFolder(e.target.value)}
              list="wiki-folder-options"
              placeholder="Folder, e.g. SOPs/Safety (blank for root)"
              className="flex-1 max-w-sm bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-600"
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
            >
              <Upload size={14} />
              Choose files
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={WIKI_FILE_ACCEPT.join(',')}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          <p className="text-xs text-gray-600">Or drop files here.</p>
          {uploads.length > 0 && (
            <ul className="text-sm space-y-1">
              {uploads.map((u) => (
                <li key={u.id} className="flex gap-2">
                  <span className="truncate text-gray-300">{u.name}</span>
                  <span
                    className={
                      u.state === 'error'
                        ? 'text-red-400'
                        : u.state === 'done'
                          ? 'text-green-400'
                          : 'text-gray-500'
                    }
                  >
                    {u.state === 'uploading' ? u.message || 'uploading…' : u.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <datalist id="wiki-folder-options">
          {folderPaths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
