import React, { useState, useRef, useEffect, useCallback } from 'react';

export default function MessageInput({ onSend, onCancel, disabled, isProcessing, queueLength = 0, agentColor, skills }) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState([]); // [{id, name, dataUrl}]
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Slash-command autocomplete state
  const [slashQuery, setSlashQuery] = useState(null);   // null = closed, string = filter
  const [slashIndex, setSlashIndex] = useState(0);       // highlighted item
  const [slashStart, setSlashStart] = useState(null);    // cursor pos of the '/'
  const popupRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [value]);

  // Focus on mount and when not disabled
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  // ── Slash-command autocomplete helpers ────────────────────────

  const filteredSkills = (skills || []).filter((s) =>
    slashQuery === null
      ? false
      : (s.name || s.id || '').toLowerCase().includes(slashQuery.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(slashQuery.toLowerCase())
  );

  // Reset index when query changes
  useEffect(() => { setSlashIndex(0); }, [slashQuery]);

  // Keep highlighted item scrolled into view
  useEffect(() => {
    if (popupRef.current && slashQuery !== null) {
      const active = popupRef.current.querySelector('[data-active="true"]');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }, [slashIndex, slashQuery]);

  const closeSlash = useCallback(() => {
    setSlashQuery(null);
    setSlashStart(null);
    setSlashIndex(0);
  }, []);

  const insertSkill = useCallback((skillId) => {
    if (slashStart === null) return;
    const before = value.slice(0, slashStart);
    const cursorPos = textareaRef.current?.selectionStart || value.length;
    const after = value.slice(cursorPos);
    const newValue = `${before}/${skillId} ${after}`;
    setValue(newValue);
    closeSlash();
    requestAnimationFrame(() => {
      const pos = before.length + skillId.length + 2; // / + name + space
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  }, [value, slashStart, closeSlash]);

  // ── Image helpers (unchanged) ─────────────────────────────────

  // Resize image using canvas to keep uploads reasonable
  const resizeImage = useCallback((dataUrl, maxDim = 2000) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxDim && img.height <= maxDim) {
          resolve(dataUrl);
          return;
        }
        const scale = maxDim / Math.max(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }, []);

  const addImageFiles = useCallback(async (files) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newImages = [];
    for (const file of imageFiles) {
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      const resized = await resizeImage(dataUrl);
      newImages.push({
        id: crypto.randomUUID(),
        name: file.name,
        dataUrl: resized,
      });
    }
    setImages((prev) => [...prev, ...newImages]);
  }, [resizeImage]);

  const removeImage = useCallback((id) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // ── Input handlers ────────────────────────────────────────────

  const handleInputChange = (e) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart;
    setValue(val);

    // Detect / trigger at start of input or after a newline
    const textBeforeCursor = val.slice(0, cursor);
    const slashMatch = textBeforeCursor.match(/(^|\n)\/([a-zA-Z0-9_.-]*)$/);
    if (slashMatch && skills?.length > 0) {
      const query = slashMatch[2];
      const slashPos = textBeforeCursor.length - slashMatch[0].length + slashMatch[1].length;
      setSlashQuery(query);
      setSlashStart(slashPos);
    } else {
      closeSlash();
    }
  };

  const handleSubmit = ({ interrupt = false } = {}) => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    // During processing: default is interrupt, shift+enter queues
    const shouldInterrupt = isProcessing && interrupt;
    onSend(trimmed || '(image attached)', images, { interrupt: shouldInterrupt });
    setValue('');
    setImages([]);
    closeSlash();
  };


  const handleKeyDown = (e) => {
    // Slash-command autocomplete navigation
    if (slashQuery !== null && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertSkill(filteredSkills[slashIndex].id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // During processing: Enter = interrupt (stop + send), messages are queued by default
      handleSubmit({ interrupt: isProcessing });
    }
    if (e.key === 'Escape' && isProcessing) {
      onCancel?.();
    }
  };

  // Handle paste for screenshots
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
    addImageFiles(files);
  }, [addImageFiles]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files) {
      addImageFiles(e.dataTransfer.files);
    }
  }, [addImageFiles]);

  const handleFileSelect = useCallback((e) => {
    if (e.target.files) {
      addImageFiles(e.target.files);
      e.target.value = '';
    }
  }, [addImageFiles]);

  return (
    <div
      className={`border-t border-gray-800 p-3 md:p-4 safe-bottom transition-colors ${
        dragOver ? 'bg-blue-900/20 border-blue-500' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-1">
          {images.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={img.dataUrl}
                alt={img.name}
                className="h-16 w-16 object-cover rounded-lg border border-gray-700"
              />
              <button
                onClick={() => removeImage(img.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 rounded-full flex items-center justify-center text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 md:gap-3 mx-auto relative">
        {/* Slash-command autocomplete popup */}
        {slashQuery !== null && filteredSkills.length > 0 && (
          <div
            ref={popupRef}
            className="absolute bottom-full mb-1 left-0 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-10 max-h-64 overflow-y-auto"
          >
            <div className="px-3 py-1.5 text-[11px] text-gray-500 border-b border-gray-700 flex items-center gap-1.5">
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Skills
              <span className="ml-auto text-gray-600">
                <kbd className="text-[10px]">&uarr;&darr;</kbd> navigate
                <span className="mx-1">&middot;</span>
                <kbd className="text-[10px]">Tab</kbd> select
              </span>
            </div>
            {filteredSkills.map((skill, i) => (
              <button
                key={skill.id}
                data-active={i === slashIndex}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent textarea blur
                  insertSkill(skill.id);
                }}
                onMouseEnter={() => setSlashIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm transition-colors ${
                  i === slashIndex
                    ? 'bg-blue-600/25 text-white'
                    : 'text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                <span className="text-gray-500 font-mono flex-shrink-0 text-xs mt-0.5">/</span>
                <div className="min-w-0">
                  <span className="font-medium">{skill.name || skill.id}</span>
                  {skill.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                      {skill.description}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Image attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled && !isProcessing}
          className="px-2 py-3 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-30"
          title="Attach image (or paste/drop)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setTimeout(closeSlash, 150)}
          placeholder={
            disabled
              ? 'Waiting...'
              : window.innerWidth < 640 ? 'Message...' : 'Type a message... (paste or drop images)'
          }
          disabled={disabled && !isProcessing}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-gray-600 disabled:opacity-50 transition-colors"
        />
        {isProcessing && (
          <button
            onClick={onCancel}
            className="px-3 py-3 rounded-xl font-medium text-white bg-red-600 hover:bg-red-500 transition-all active:scale-95"
            title="Cancel (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        {isProcessing && value.trim() ? (
          /* During processing with text: show Interrupt button (Enter) */
          <button
            onClick={() => handleSubmit({ interrupt: true })}
            disabled={disabled}
            className="px-3 py-3 rounded-xl font-medium text-white bg-amber-600 hover:bg-amber-500 transition-all active:scale-95 flex items-center gap-1.5"
            title="Interrupt agent and send this message (Enter)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {queueLength > 0 && (
              <span className="text-xs bg-white/20 rounded-full px-1.5">{queueLength}</span>
            )}
          </button>
        ) : (
          <button
            onClick={() => handleSubmit()}
            disabled={disabled || (!value.trim() && images.length === 0)}
            className="px-4 py-3 rounded-xl font-medium text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 active:scale-95"
            style={{
              backgroundColor: disabled ? '#4b5563' : agentColor || '#4F46E5',
            }}
            title={isProcessing ? 'Send (will be queued)' : 'Send'}
          >
            {isProcessing ? (
              <div className="flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
                {queueLength > 0 && (
                  <span className="text-xs bg-white/20 rounded-full px-1.5">{queueLength}</span>
                )}
              </div>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-900/30 rounded-lg pointer-events-none z-10">
          <div className="text-blue-300 font-medium text-lg">Drop image here</div>
        </div>
      )}
    </div>
  );
}
