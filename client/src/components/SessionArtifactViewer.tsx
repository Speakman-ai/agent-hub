import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { artifactRenderKind } from '@shared/utils/artifactView';
import { fetchArtifactBlob } from '../utils/artifactContent';
import { MarkdownContent, markdownComponentsCompact } from './MarkdownRenderer';

function formatTextArtifact(text: string, contentType: any, filename: any) {
  const ct = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (
    ct !== 'application/json' &&
    !String(filename || '')
      .toLowerCase()
      .endsWith('.json')
  ) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function SessionArtifactViewerBody({
  artifact,
  kind,
  objectUrl,
  text,
  loading,
  error,
  onRenderError,
}: any) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-400">
        <Loader2 size={18} className="animate-spin" />
        Loading document…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="flex items-center gap-2 p-4 text-sm text-red-200"
        data-testid="session-artifact-viewer-error"
      >
        <AlertCircle size={16} />
        {error}
      </div>
    );
  }
  if (kind === 'pdf' && objectUrl) {
    return (
      <iframe
        src={objectUrl}
        title={artifact.filename || 'Artifact document'}
        className="h-full w-full border-0 bg-white"
        data-testid="session-artifact-viewer-pdf"
      />
    );
  }
  if (kind === 'image' && objectUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-gray-950 p-4">
        <img
          src={objectUrl}
          alt={artifact.filename || 'Artifact image'}
          className="max-h-full max-w-full object-contain"
          data-testid="session-artifact-viewer-image"
          onError={() =>
            onRenderError?.(
              objectUrl,
              'Could not display this image. Download the file to inspect it.',
            )
          }
        />
      </div>
    );
  }
  if (kind === 'markdown') {
    return (
      <article
        className="prose prose-invert prose-sm h-full max-w-none overflow-auto p-6 text-gray-200"
        data-testid="session-artifact-viewer-markdown"
      >
        <MarkdownContent
          content={text || ''}
          components={markdownComponentsCompact}
          rehypePlugins={[]}
        />
      </article>
    );
  }
  return (
    <pre
      className="h-full overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-5 text-gray-200"
      data-testid="session-artifact-viewer-text"
    >
      {text || ''}
    </pre>
  );
}

export default function SessionArtifactViewer({ sessionId, artifact }: any) {
  const kind = artifactRenderKind(artifact?.contentType, artifact?.filename);
  const [state, setState] = useState<any>({ loading: true, objectUrl: '', text: '', error: '' });
  const activeObjectUrl = useRef('');

  const handleRenderError = useCallback((failedObjectUrl: string, message: string) => {
    if (!failedObjectUrl || activeObjectUrl.current !== failedObjectUrl) return;
    URL.revokeObjectURL(failedObjectUrl);
    activeObjectUrl.current = '';
    setState((prev: any) => {
      if (prev.objectUrl !== failedObjectUrl) return prev;
      return {
        ...prev,
        loading: false,
        objectUrl: '',
        error: message || 'Failed to display artifact.',
      };
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let nextObjectUrl = '';
    setState({ loading: true, objectUrl: '', text: '', error: '' });

    if (!sessionId || !artifact?.id || !kind) {
      setState({
        loading: false,
        objectUrl: '',
        text: '',
        error: 'This file cannot be previewed.',
      });
      return () => undefined;
    }

    fetchArtifactBlob(sessionId, artifact.id)
      .then(async (blob) => {
        if (kind === 'pdf' || kind === 'image') {
          if (disposed) return;
          nextObjectUrl = URL.createObjectURL(blob);
          activeObjectUrl.current = nextObjectUrl;
          setState({ loading: false, objectUrl: nextObjectUrl, text: '', error: '' });
          return;
        }
        const raw = await blob.text();
        if (!disposed) {
          setState({
            loading: false,
            objectUrl: '',
            text: formatTextArtifact(raw, artifact.contentType, artifact.filename),
            error: '',
          });
        }
      })
      .catch((err: any) => {
        if (!disposed) {
          setState({
            loading: false,
            objectUrl: '',
            text: '',
            error: err?.message || 'Failed to open artifact',
          });
        }
      });

    return () => {
      disposed = true;
      if (nextObjectUrl && activeObjectUrl.current === nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
        activeObjectUrl.current = '';
      }
    };
  }, [artifact?.contentType, artifact?.filename, artifact?.id, kind, sessionId]);

  return (
    <SessionArtifactViewerBody
      artifact={artifact}
      kind={kind}
      {...state}
      onRenderError={handleRenderError}
    />
  );
}
