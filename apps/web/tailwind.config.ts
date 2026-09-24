import type { Config } from 'tailwindcss';

/**
 * Restrained palette on purpose.
 *
 * This is a tool people keep open next to an editor all day, so the neutral scale carries the
 * layout and colour is reserved for one job: risk and severity. If buttons, links and headings
 * were also coloured, a CRITICAL badge would have to compete for attention with chrome, and the
 * one thing the product exists to communicate would stop standing out.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Slate-based neutrals, referenced by name so a later theme swap is one file.
        surface: {
          DEFAULT: '#ffffff',
          subtle: '#f8fafc',
          muted: '#f1f5f9',
          border: '#e2e8f0',
        },
        risk: {
          low: '#15803d',
          medium: '#a16207',
          high: '#c2410c',
          critical: '#b91c1c',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      fontSize: {
        // Denser than Tailwind's defaults. An enterprise review screen has a lot to show and
        // scrolling past it is worse than reading it slightly smaller.
        xs: ['0.75rem', { lineHeight: '1.1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.625rem' }],
      },
    },
  },
  plugins: [],
};

export default config;
