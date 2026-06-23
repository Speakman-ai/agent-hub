import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

function FolderIcon() {
  return (
    <svg
      className="w-4 h-4 text-yellow-400 flex-shrink-0"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  );
}

export default function ServerBrowser({ isOpen, onClose, onSelect, initialPath }: any) {
  const [currentPath, setCurrentPath] = useState(initialPath || '');
  const [entries, setEntries] = useState<any[]>([]);
  const [parentPath, setParentPath] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);

  const fetchDirectory = useCallback(async (path: any) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browse(path);
      setCurrentPath(result.path || path);
      setParentPath(result.parent || null);
      setEntries(result.entries || []);
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('not valid JSON') || msg.includes('DOCTYPE')) {
        setError('Server browse endpoint not available. Restart the server to pick up changes.');
      } else {
        setError(msg || 'Failed to browse directory');
      }
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchDirectory(initialPath || '');
    }
  }, [isOpen, initialPath, fetchDirectory]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: any) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        onSelect(currentPath);
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, onSelect, currentPath]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: any) => {
    if (e.target === e.currentTarget) onClose();
  };

  const navigateTo = (path: any) => {
    fetchDirectory(path);
  };

  const navigateUp = () => {
    if (parentPath) fetchDirectory(parentPath);
  };

  const handleSelect = () => {
    onSelect(currentPath);
    onClose();
  };

  // Build breadcrumb segments from currentPath
  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg p-6 relative">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Browse Server</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Breadcrumb path */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 mb-3 text-sm text-gray-300 font-mono overflow-x-auto whitespace-nowrap">
          <button
            onClick={() => navigateTo('/')}
            className="hover:text-emerald-400 transition-colors"
          >
            /
          </button>
          {pathSegments.map((segment: any, i: any) => {
            const segmentPath = '/' + pathSegments.slice(0, i + 1).join('/');
            return (
              <span key={segmentPath}>
                <button
                  onClick={() => navigateTo(segmentPath)}
                  className="hover:text-emerald-400 transition-colors"
                >
                  {segment}
                </button>
                {i < pathSegments.length - 1 && <span className="text-gray-600">/</span>}
              </span>
            );
          })}
        </div>

        {/* Actions bar */}
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={navigateUp}
            disabled={!parentPath}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-800 disabled:text-gray-600 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:cursor-not-allowed"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
            Parent
          </button>
          <button
            onClick={handleSelect}
            className="ml-auto px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg text-sm transition-colors"
          >
            Select This Folder
          </button>
        </div>

        {/* Directory listing */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <svg
                className="animate-spin h-5 w-5 text-emerald-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
          )}

          {error && !loading && <div className="px-4 py-3 text-sm text-red-400">{error}</div>}

          {!loading && !error && entries.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-500">No subdirectories</div>
          )}

          {!loading &&
            !error &&
            entries.map((entry: any) => (
              <button
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors text-left"
              >
                <FolderIcon />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
