import React, { useState, useRef, useEffect } from 'react';

export default function MessageInput({ onSend, onCancel, disabled, isProcessing, agentColor }) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);

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

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape' && isProcessing) {
      onCancel?.();
    }
  };

  return (
    <div className="border-t border-gray-800 p-3 md:p-4 safe-bottom">
      <div className="flex items-end gap-2 md:gap-3 max-w-4xl mx-auto">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? 'Waiting...'
              : window.innerWidth < 640 ? 'Message...' : 'Type a message... (Shift+Enter for newline)'
          }
          disabled={disabled && !isProcessing}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-gray-600 disabled:opacity-50 transition-colors"
        />
        {isProcessing ? (
          <button
            onClick={onCancel}
            className="px-4 py-3 rounded-xl font-medium text-white bg-red-600 hover:bg-red-500 transition-all active:scale-95"
            title="Cancel (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
            className="px-4 py-3 rounded-xl font-medium text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 active:scale-95"
            style={{
              backgroundColor: disabled ? '#4b5563' : agentColor || '#4F46E5',
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
