// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { isWorkflowProject } from './project-mode';
describe('isWorkflowProject', () => {
  it('is false when mode is missing or dev', () => {
    expect(isWorkflowProject(null)).toBe(false);
    expect(isWorkflowProject(undefined)).toBe(false);
    expect(isWorkflowProject({})).toBe(false);
    expect(isWorkflowProject({ mode: 'dev' })).toBe(false);
  });
  it('is true for workflow', () => {
    expect(isWorkflowProject({ mode: 'workflow' })).toBe(true);
  });
});
