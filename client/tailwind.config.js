import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gray: {
          850: '#1a1d27',
        },
        gh: {
          canvas: '#030712',
          subtle: '#111827',
          inset: '#030712',
          overlay: '#1f2937',
          border: '#374151',
          borderMuted: '#1f2937',
          fg: '#f3f4f6',
          muted: '#9ca3af',
          accent: '#38bdf8',
          success: '#34d399',
          successEmphasis: '#059669',
          done: '#a78bfa',
          danger: '#f87171',
          attention: '#fbbf24',
          orange: '#38bdf8',
        },
      },
    },
  },
  plugins: [typography],
};
