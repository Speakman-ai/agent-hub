import React, { useState, useEffect } from 'react';
import { formatElapsed } from '../utils/time.js';

export default function ThinkingIndicator({ agentColor }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex justify-start mb-4">
      <div className="bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: agentColor }}
          />
          <span className="text-xs text-gray-500 font-medium">Assistant</span>
        </div>
        <div className="flex items-center gap-2 py-1">
          <div className="flex items-center gap-1.5">
            <span className="thinking-dot w-2 h-2 bg-gray-400 rounded-full" />
            <span className="thinking-dot w-2 h-2 bg-gray-400 rounded-full" />
            <span className="thinking-dot w-2 h-2 bg-gray-400 rounded-full" />
          </div>
          <span className="text-xs text-gray-500 ml-1">
            Thinking... {formatElapsed(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
}
