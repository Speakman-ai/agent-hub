import { z } from '../registry.js';

export const ProjectIconSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => !/[\r\n\t]/.test(value), 'Use a single-line emoji or symbol')
  .nullable()
  .optional()
  .openapi({
    description:
      'Emoji or symbol replacing the project color marker (up to 32 UTF-16 code units). Null or empty restores the colored marker.',
    example: '🚀',
  });
