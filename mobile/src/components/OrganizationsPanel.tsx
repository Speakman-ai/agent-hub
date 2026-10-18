import React, { useState, useEffect, useMemo, useSyncExternalStore } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { createUseOrganizations } from '@shared/hooks/useOrganizations';
import type {
  OrganizationRole,
  OrganizationState,
  OrganizationController,
} from '@shared/utils/organizations';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { getApiBaseUrl } from '../utils/config';
import { getActiveOrg } from '../utils/orgs';
import { getAuthRecord } from '../utils/auth';
import { colors } from '../theme/colors';

const useOrganizations = createUseOrganizations({ useEffect, useMemo, useSyncExternalStore });
const scope = () =>
  JSON.stringify([getApiBaseUrl(), getActiveOrg()?.id, getAuthRecord()?.user?.id]);
const toggle = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
const roles: OrganizationRole[] = ['Owner', 'Admin', 'Member'];
type Props = { state: OrganizationState; controller: OrganizationController };
function Button({
  children,
  onPress,
  disabled = false,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.text}>{children}</Text>
    </TouchableOpacity>
  );
}
function Choice({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}
function RoleChoices({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OrganizationRole;
  onChange: (role: OrganizationRole) => void;
}) {
  return (
    <View style={styles.row}>
      {roles.map((role) => (
        <TouchableOpacity
          key={role}
          accessibilityRole="radio"
          accessibilityLabel={`${label}: ${role}`}
          accessibilityState={{ selected: value === role }}
          style={[styles.button, value === role && styles.selected]}
          onPress={() => onChange(role)}
        >
          <Text style={styles.text}>{role}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
export default function OrganizationsPanel({ projectId }: { projectId?: string }) {
  const { lastOrganizationEvent } = useApp();
  const { state, controller } = useOrganizations(api.organizations, scope, lastOrganizationEvent);
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Organizations</Text>
      <Text style={styles.help}>
        Organizations group projects within this Server. Projects can belong to several
        organizations or remain independent. Linking never grants project access.
      </Text>
      <Button disabled={state.busy} onPress={() => void controller.load()}>
        Refresh organizations
      </Button>
      {!!state.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error} Refresh to retry. Check your Server sign-in and organization permissions if
          access is denied.
        </Text>
      )}
      {state.busy && <Text style={styles.text}>Loading organizations…</Text>}
      {state.ready &&
        !state.busy &&
        (projectId ? (
          <ProjectOrganizations
            key={projectId}
            projectId={projectId}
            state={state}
            controller={controller}
          />
        ) : (
          <Manager state={state} controller={controller} />
        ))}
    </View>
  );
}
function ProjectOrganizations({ projectId, state, controller }: Props & { projectId: string }) {
  const [ids, setIds] = useState(() =>
    state.organizations
      .filter((o) => state.links[o.id]?.some((p) => p.id === projectId))
      .map((o) => o.id),
  );
  const accessible = state.projects.some((p) => p.id === projectId);
  return (
    <View style={styles.section}>
      {!state.organizations.length && (
        <Text style={styles.help}>
          No organizations available. Create one explicitly from Organizations in the sidebar.
        </Text>
      )}
      {!accessible && (
        <Text style={styles.help}>
          This project cannot be linked. Check project access or choose a regular project.
        </Text>
      )}
      {state.organizations.map((o) => (
        <View key={o.id}>
          <Choice
            label={o.name}
            value={ids.includes(o.id)}
            disabled={!o.canManage || !accessible}
            onChange={() => setIds(toggle(ids, o.id))}
          />
          {!o.canManage && (
            <Text style={styles.help}>Ask an Owner or Admin to change membership.</Text>
          )}
        </View>
      ))}
      <Button
        disabled={!accessible || !state.organizations.some((o) => o.canManage)}
        onPress={() => void controller.saveProjectOrganizations(projectId, ids)}
      >
        Save organization links
      </Button>
      <Text style={styles.help}>
        Clearing links leaves this project in the normal project list.
      </Text>
    </View>
  );
}
function Manager({ state, controller }: Props) {
  const [newName, setNewName] = useState('');
  const selected = state.organizations.find((o) => o.id === state.selectedId);
  return (
    <View style={styles.section}>
      <TextInput
        style={styles.input}
        accessibilityLabel="New organization name"
        placeholder="New organization name"
        placeholderTextColor={colors.gray500}
        maxLength={200}
        value={newName}
        onChangeText={setNewName}
      />
      <Button disabled={!newName.trim()} onPress={() => void controller.create(newName)}>
        Create organization
      </Button>
      {!state.organizations.length && (
        <Text style={styles.help}>
          No organizations yet. Create one to start grouping projects. Your existing projects stay
          independent.
        </Text>
      )}
      {state.organizations.map((o) => (
        <Button key={o.id} onPress={() => void controller.load(o.id)}>
          {o.name}
        </Button>
      ))}
      {selected ? (
        <Details key={selected.id} state={state} controller={controller} />
      ) : (
        state.organizations.length > 0 && (
          <Text style={styles.help}>Select an organization to view projects and members.</Text>
        )
      )}
    </View>
  );
}
function Details({ state, controller }: Props) {
  const organization = state.organizations.find((o) => o.id === state.selectedId)!;
  const [name, setName] = useState(organization.name);
  const [ids, setIds] = useState(() => (state.links[organization.id] || []).map((p) => p.id));
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<OrganizationRole>('Member');
  const [archive, setArchive] = useState(false);
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{organization.name}</Text>
      {!organization.canManage && (
        <Text style={styles.help}>
          Read only. Ask an organization Owner or Admin to edit projects or members.
        </Text>
      )}
      {organization.canManage && (
        <>
          <TextInput
            style={styles.input}
            accessibilityLabel="Organization name"
            maxLength={200}
            value={name}
            onChangeText={setName}
          />
          <Button
            disabled={!name.trim() || name.trim() === organization.name}
            onPress={() => void controller.rename(name)}
          >
            Save name
          </Button>
        </>
      )}
      <Text style={styles.heading}>Linked projects</Text>
      {!ids.length && (
        <Text style={styles.help}>
          No linked projects. Projects remain independent until attached.
        </Text>
      )}
      {(organization.canManage ? state.projects : state.links[organization.id] || []).map((p) => (
        <Choice
          key={p.id}
          label={p.name}
          disabled={!organization.canManage}
          value={ids.includes(p.id)}
          onChange={() => setIds(toggle(ids, p.id))}
        />
      ))}
      {organization.canManage && (
        <>
          {!state.projects.length && (
            <Text style={styles.help}>
              No accessible projects to attach. Create a project or ask its owner for access.
            </Text>
          )}
          <Button onPress={() => void controller.saveProjects(ids)}>Save project links</Button>
        </>
      )}
      <Text style={styles.heading}>Members</Text>
      {state.members.map((member) => (
        <View style={styles.section} key={member.userId}>
          <Text style={styles.text}>
            {member.username}: {member.role}
          </Text>
          {organization.canManage && (
            <>
              <RoleChoices
                label={`Role for ${member.username}`}
                value={member.role}
                onChange={(role) => void controller.member(member.userId, role)}
              />
              <Button
                onPress={() => void controller.member(member.userId, null)}
              >{`Remove ${member.username}`}</Button>
            </>
          )}
        </View>
      ))}
      {organization.canManage && (
        <>
          <Text style={styles.help}>
            Keep at least one Owner. Organization membership does not grant access to private or
            restricted projects.
          </Text>
          <Text style={styles.text}>Choose a Server member</Text>
          {state.candidates
            .filter((c) => !state.members.some((m) => m.userId === c.userId))
            .map((c) => (
              <Choice
                key={c.userId}
                label={c.username}
                value={userId === c.userId}
                onChange={() => setUserId(c.userId)}
              />
            ))}
          <RoleChoices label="New member role" value={role} onChange={setRole} />
          <Button disabled={!userId} onPress={() => void controller.member(userId, role)}>
            Add member
          </Button>
          {!archive ? (
            <Button onPress={() => setArchive(true)}>Archive organization</Button>
          ) : (
            <>
              <Text style={styles.help}>
                Archive {organization.name}? Members lose organization access. Projects and their
                other organization links are preserved.
              </Text>
              <Button onPress={() => void controller.archive()}>Confirm archive</Button>
              <Button onPress={() => setArchive(false)}>Cancel archive</Button>
            </>
          )}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  heading: { color: colors.white, fontSize: 18, fontWeight: '600' },
  text: { color: colors.gray200, fontSize: 14 },
  help: { color: colors.gray400, fontSize: 14 },
  error: { color: colors.red400 },
  button: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
  },
  selected: { backgroundColor: colors.gray700 },
  input: {
    color: colors.white,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
  },
});
