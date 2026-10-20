import { z } from '../registry.js';

export const ProjectIconSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => !/[\r\n\t]/.test(value), 'Use a single-line icon name')
  .nullable()
  .optional()
  .openapi({
    description:
      'Stored project icon name (up to 32 characters). Create uses Folder when this is omitted or empty. The app always shows a folder icon beside the project name.',
    example: 'Folder',
  });
