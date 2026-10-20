import { describe, it, expect, beforeEach } from 'vitest';
import {
  SIDEBAR_ORG_SECTIONS_KEY,
  SIDEBAR_SELECTED_ORG_KEY,
  activeOrganizationSection,
  groupProjectsByOrganization,
  readCollapsedOrgSections,
  readSelectedOrganization,
  writeCollapsedOrgSections,
  writeSelectedOrganization,
} from './sidebarOrgSections';

const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
const organizations = [
  { id: 'org-a', name: 'Acme' },
  { id: 'org-b', name: 'Beta' },
];

describe('groupProjectsByOrganization', () => {
  it('returns null when there are no organizations', () => {
    expect(groupProjectsByOrganization(projects, [], {})).toBeNull();
  });

  it('nests linked projects under each organization and keeps sidebar order', () => {
    const sections = groupProjectsByOrganization(projects, organizations, {
      'org-a': [{ id: 'p3' }, { id: 'p1' }, { id: 'missing' }],
      'org-b': [{ id: 'p1' }],
    });
    expect(sections).toEqual([
      { id: 'org-a', name: 'Acme', projectIds: ['p1', 'p3'] },
      { id: 'org-b', name: 'Beta', projectIds: ['p1'] },
      { id: 'independent', name: 'Independent', projectIds: ['p2'] },
    ]);
  });

  it('uses the stored organization and falls back to the first option', () => {
    const sections = groupProjectsByOrganization(projects, organizations, {
      'org-a': [{ id: 'p1' }],
      'org-b': [{ id: 'p2' }],
    })!;
    expect(activeOrganizationSection(sections, 'org-b')?.id).toBe('org-b');
    expect(activeOrganizationSection(sections, 'missing')?.id).toBe('org-a');
    expect(activeOrganizationSection(null, 'org-a')).toBeNull();
  });

  it('omits Independent when every project is linked', () => {
    const sections = groupProjectsByOrganization(projects, [organizations[0]], {
      'org-a': [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    });
    expect(sections?.map((section) => section.id)).toEqual(['org-a']);
  });
});

describe('collapsed organization sections', () => {
  beforeEach(() => localStorage.clear());

  it('persists only collapsed ids and reads them back', () => {
    writeCollapsedOrgSections({ 'org-a': true, 'org-b': false });
    expect(JSON.parse(localStorage.getItem(SIDEBAR_ORG_SECTIONS_KEY) || '{}')).toEqual({
      'org-a': true,
    });
    expect(readCollapsedOrgSections()).toEqual({ 'org-a': true });
    writeCollapsedOrgSections({});
    expect(localStorage.getItem(SIDEBAR_ORG_SECTIONS_KEY)).toBeNull();
  });

  it('ignores malformed storage', () => {
    localStorage.setItem(SIDEBAR_ORG_SECTIONS_KEY, '{');
    expect(readCollapsedOrgSections()).toEqual({});
  });

  it('remembers the selected organization', () => {
    writeSelectedOrganization('org-b');
    expect(localStorage.getItem(SIDEBAR_SELECTED_ORG_KEY)).toBe('org-b');
    expect(readSelectedOrganization()).toBe('org-b');
    writeSelectedOrganization(null);
    expect(localStorage.getItem(SIDEBAR_SELECTED_ORG_KEY)).toBeNull();
  });
});
