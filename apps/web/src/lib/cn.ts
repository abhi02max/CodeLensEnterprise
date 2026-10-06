import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const merge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ['control-x', 'section-x', 'section-y', 'row-compact', 'row-comfortable'],
      borderRadius: ['control', 'overlay', 'frame'],
    },
    classGroups: {
      'min-h': ['min-h-row-compact', 'min-h-row-comfortable'],
      'font-size': [
        { text: ['page', 'section', 'panel', 'body', 'compact', 'metadata', 'label', 'code'] },
      ],
    },
  },
});

/** Conditional classes with later Tailwind utilities winning over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
