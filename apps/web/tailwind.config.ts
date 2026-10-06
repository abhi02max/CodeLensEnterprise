import type { Config } from 'tailwindcss';

const color = (role: string) => `rgb(var(--cl-${role}) / <alpha-value>)`;
const state = (role: string) => ({
  text: color(`${role}-text`),
  bg: color(`${role}-bg`),
  border: color(`${role}-border`),
});

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: color('canvas'),
        surface: {
          DEFAULT: color('surface'),
          subtle: color('surface-subtle'),
          muted: color('surface-muted'),
          raised: color('surface-raised'),
          selected: color('selected'),
          border: color('border'),
        },
        content: {
          primary: color('text-primary'),
          secondary: color('text-secondary'),
          muted: color('text-muted'),
          disabled: color('text-disabled'),
          inverse: color('text-inverse'),
        },
        structure: {
          DEFAULT: color('border'),
          strong: color('border-strong'),
          divider: color('divider'),
        },
        interactive: { DEFAULT: color('interactive'), hover: color('interactive-hover') },
        selected: {
          DEFAULT: color('selected'),
          hover: color('selected-hover'),
          text: color('selected-text'),
        },
        focus: color('focus'),
        state: {
          success: {
            ...state('success'),
            solid: color('success-solid'),
            hover: color('success-hover'),
          },
          warning: state('warning'),
          danger: {
            ...state('danger'),
            solid: color('danger-solid'),
            hover: color('danger-hover'),
          },
          info: state('info'),
          unavailable: state('unavailable'),
          uncertain: state('uncertain'),
        },
        severity: {
          critical: state('critical'),
          high: state('high'),
          medium: state('medium'),
          low: state('low'),
        },
        diff: {
          'add-bg': color('diff-add-bg'),
          'add-text': color('diff-add-text'),
          'delete-bg': color('diff-delete-bg'),
          'delete-text': color('diff-delete-text'),
          modified: color('diff-modified'),
          selected: color('diff-selected'),
          'line-number': color('diff-line-number'),
          border: color('diff-border'),
        },
        // Compatibility aliases; risk remains a separate domain from execution status.
        risk: {
          low: color('success-solid'),
          medium: color('medium-text'),
          high: color('high-text'),
          critical: color('danger-solid'),
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
        page: ['1.5rem', { lineHeight: '1.875rem' }],
        section: ['1.125rem', { lineHeight: '1.625rem' }],
        panel: ['0.875rem', { lineHeight: '1.25rem' }],
        body: ['0.875rem', { lineHeight: '1.375rem' }],
        compact: ['0.8125rem', { lineHeight: '1.25rem' }],
        metadata: ['0.75rem', { lineHeight: '1.125rem' }],
        label: ['0.8125rem', { lineHeight: '1.125rem' }],
        code: ['0.8125rem', { lineHeight: '1.25rem' }],
      },
      spacing: {
        'control-x': 'var(--cl-space-3)',
        'section-x': 'var(--cl-space-4)',
        'section-y': 'var(--cl-space-3)',
        'row-compact': 'var(--cl-row-compact)',
        'row-comfortable': 'var(--cl-row-comfortable)',
      },
      borderRadius: {
        control: 'var(--cl-radius-control)',
        overlay: 'var(--cl-radius-overlay)',
        frame: 'var(--cl-radius-frame)',
      },
    },
  },
  plugins: [],
};

export default config;
