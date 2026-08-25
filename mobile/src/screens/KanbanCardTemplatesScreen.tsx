import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  blankCardTemplateInput,
  cardTemplateApiBody,
  normalizeCardTemplate,
  type KanbanCardTemplate,
  type KanbanCardTemplateInput,
} from '@shared/utils/kanbanCardTemplates';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

type Props = { route: any; navigation: any };

function TemplateDialog({
  visible,
  template,
  epics,
  saving,
  error,
  onClose,
  onSave,
}: {
  visible: boolean;
  template: KanbanCardTemplate | null;
  epics: any[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: KanbanCardTemplateInput) => void;
}) {
  const [form, setForm] = useState<KanbanCardTemplateInput>(() => blankCardTemplateInput());

  useEffect(() => {
    if (!visible) return;
    setForm(
      template
        ? {
            name: template.name,
            title: template.title,
            description: template.description,
            priority: template.priority,
            labels: template.labels,
            epicId: template.epicId,
          }
        : blankCardTemplateInput(),
    );
  }, [template, visible]);

  const update = (patch: Partial<KanbanCardTemplateInput>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.dialog}>
          <View style={styles.dialogHeader}>
            <Text style={styles.dialogTitle}>{template ? 'Edit template' : 'New template'}</Text>
            <TouchableOpacity onPress={onClose} disabled={saving} accessibilityLabel="Close">
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.dialogScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={form.name}
              onChangeText={(name) => update({ name })}
              placeholder="Bug report"
              placeholderTextColor={colors.gray600}
              testID="template-name"
            />
            <Text style={styles.label}>Default title</Text>
            <TextInput
              style={styles.input}
              value={form.title}
              onChangeText={(title) => update({ title })}
              placeholder="Card title when applied"
              placeholderTextColor={colors.gray600}
              testID="template-title"
            />
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={form.description}
              onChangeText={(description) => update({ description })}
              placeholder="Problem, acceptance criteria, context…"
              placeholderTextColor={colors.gray600}
              multiline
              testID="template-description"
            />
            <Text style={styles.label}>Priority</Text>
            <View style={styles.choiceRow}>
              {PRIORITIES.map((priority) => (
                <TouchableOpacity
                  key={priority}
                  style={[styles.choice, form.priority === priority && styles.choiceSelected]}
                  onPress={() => update({ priority })}
                  testID={`template-priority-${priority}`}
                >
                  <Text
                    style={[
                      styles.choiceText,
                      form.priority === priority && styles.choiceTextSelected,
                    ]}
                  >
                    {priority}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Labels</Text>
            <TextInput
              style={styles.input}
              value={form.labels}
              onChangeText={(labels) => update({ labels })}
              placeholder="bug, feature"
              placeholderTextColor={colors.gray600}
              testID="template-labels"
            />
            <Text style={styles.label}>Epic</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.choiceRow}
            >
              <TouchableOpacity
                style={[styles.choice, !form.epicId && styles.choiceSelected]}
                onPress={() => update({ epicId: '' })}
              >
                <Text style={[styles.choiceText, !form.epicId && styles.choiceTextSelected]}>
                  None
                </Text>
              </TouchableOpacity>
              {epics.map((epic) => (
                <TouchableOpacity
                  key={epic.id}
                  style={[styles.choice, form.epicId === epic.id && styles.choiceSelected]}
                  onPress={() => update({ epicId: epic.id })}
                >
                  <Text
                    style={[
                      styles.choiceText,
                      form.epicId === epic.id && styles.choiceTextSelected,
                    ]}
                    numberOfLines={1}
                  >
                    {epic.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
          <View style={styles.dialogActions}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={saving}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveButton, (!form.name.trim() || saving) && styles.disabledButton]}
              onPress={() => onSave(form)}
              disabled={!form.name.trim() || saving}
              testID="template-save"
            >
              {saving ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Text style={styles.saveText}>{template ? 'Save changes' : 'Create template'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function KanbanCardTemplatesScreen({ route, navigation }: Props) {
  const { projectId, project } = route.params || {};
  const [templates, setTemplates] = useState<KanbanCardTemplate[]>([]);
  const [epics, setEpics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    mode: 'create' | 'edit';
    template?: KanbanCardTemplate;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const returnToBoard = () => {
    // Kanban refreshes on focus, so this follows the same path as Android
    // back/gesture navigation when the existing board screen is revealed.
    navigation.navigate('Kanban', {
      projectId,
      project,
    });
  };

  const fetchTemplates = useCallback(async () => {
    if (!projectId) return;
    try {
      const rows = await api.getCardTemplates(projectId);
      setTemplates(Array.isArray(rows) ? rows.map(normalizeCardTemplate) : []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchTemplates();
    api
      .getEpics(projectId)
      .then((rows: any) => setEpics(Array.isArray(rows) ? rows : []))
      .catch(() => setEpics([]));
  }, [fetchTemplates, projectId]);

  const saveTemplate = async (input: KanbanCardTemplateInput) => {
    setSaving(true);
    setDialogError(null);
    try {
      const body = cardTemplateApiBody(input);
      if (dialog?.mode === 'edit' && dialog.template) {
        await api.updateCardTemplate(projectId, dialog.template.id, body);
      } else {
        await api.createCardTemplate(projectId, body);
      }
      setDialog(null);
      await fetchTemplates();
    } catch (err: any) {
      setDialogError(err?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = (template: KanbanCardTemplate) => {
    if (deletingId === template.id) {
      setDeletingId(null);
      void api
        .deleteCardTemplate(projectId, template.id)
        .then(fetchTemplates)
        .catch((err: any) => setError(err?.message || 'Failed to delete template'));
      return;
    }
    setDeletingId(template.id);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={colors.blue500} />
        <Text style={styles.loadingText}>Loading templates…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={returnToBoard} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.titleBlock}>
          <Text style={styles.topBarTitle} numberOfLines={1}>
            Card templates
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {project?.name || 'Project'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.newButton}
          onPress={() => {
            setDialogError(null);
            setDialog({ mode: 'create' });
          }}
          testID="templates-new"
        >
          <Text style={styles.newButtonText}>+ New</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
        <Text style={styles.helpText}>
          Templates pre-fill new cards with a title, description, priority, labels, and epic.
        </Text>
        {templates.length === 0 ? (
          <View style={styles.empty} testID="templates-empty">
            <Text style={styles.emptyTitle}>No templates yet.</Text>
            <TouchableOpacity
              style={styles.saveButton}
              onPress={() => {
                setDialogError(null);
                setDialog({ mode: 'create' });
              }}
            >
              <Text style={styles.saveText}>Create your first template</Text>
            </TouchableOpacity>
          </View>
        ) : (
          templates.map((template) => (
            <View
              key={template.id}
              style={styles.templateRow}
              testID={`template-row-${template.id}`}
            >
              <View style={styles.templateInfo}>
                <Text style={styles.templateName} numberOfLines={1}>
                  {template.name}
                </Text>
                {template.title ? (
                  <Text style={styles.templateTitle} numberOfLines={1}>
                    Title: {template.title}
                  </Text>
                ) : null}
                <View style={styles.metaRow}>
                  <Text style={styles.meta}>{template.priority}</Text>
                  {template.labels ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {template.labels}
                    </Text>
                  ) : null}
                  {template.epicId ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      Epic:{' '}
                      {epics.find((epic) => epic.id === template.epicId)?.name || template.epicId}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.rowActions}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() =>
                    navigation.navigate('Kanban', { projectId, project, pendingTemplate: template })
                  }
                  testID={`template-use-${template.id}`}
                >
                  <Text style={styles.smallButtonText}>Use</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => {
                    setDialogError(null);
                    setDialog({ mode: 'edit', template });
                  }}
                  testID={`template-edit-${template.id}`}
                >
                  <Text style={styles.iconText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.iconButton, deletingId === template.id && styles.deleteConfirm]}
                  onPress={() => deleteTemplate(template)}
                  testID={`template-delete-${template.id}`}
                >
                  <Text style={styles.deleteText}>
                    {deletingId === template.id ? 'Confirm' : 'Delete'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </ScrollView>
      <TemplateDialog
        visible={dialog != null}
        template={dialog?.mode === 'edit' ? dialog.template || null : null}
        epics={epics}
        saving={saving}
        error={dialogError}
        onClose={() => {
          if (!saving) {
            setDialog(null);
            setDialogError(null);
          }
        }}
        onSave={saveTemplate}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  loadingText: { color: colors.gray500, fontSize: 13, textAlign: 'center', marginTop: 10 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  backButton: { paddingHorizontal: 4, paddingVertical: 2 },
  backText: { color: colors.gray300, fontSize: 32, lineHeight: 30 },
  titleBlock: { flex: 1 },
  topBarTitle: { color: colors.white, fontSize: 16, fontWeight: '600' },
  subtitle: { color: colors.gray500, fontSize: 11, marginTop: 2 },
  newButton: {
    backgroundColor: colors.blue600,
    borderRadius: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  newButtonText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  content: { padding: 12, paddingBottom: 32 },
  helpText: { color: colors.gray500, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  errorBanner: {
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  empty: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
  },
  emptyTitle: { color: colors.gray400, fontSize: 14, marginBottom: 14 },
  templateRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  templateInfo: { flex: 1, minWidth: 0 },
  templateName: { color: colors.gray100, fontSize: 14, fontWeight: '600' },
  templateTitle: { color: colors.gray500, fontSize: 12, marginTop: 3 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  meta: {
    color: colors.gray400,
    backgroundColor: colors.gray800,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    fontSize: 10,
    maxWidth: 150,
  },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  smallButton: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  smallButtonText: { color: colors.gray200, fontSize: 11, fontWeight: '600' },
  iconButton: { paddingHorizontal: 5, paddingVertical: 7 },
  iconText: { color: colors.gray500, fontSize: 11 },
  deleteText: { color: colors.red400, fontSize: 11 },
  deleteConfirm: { backgroundColor: colors.red900_50, borderRadius: 5 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    padding: 16,
  },
  dialog: {
    maxHeight: '90%',
    backgroundColor: colors.gray900,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.gray700,
    overflow: 'hidden',
  },
  dialogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  dialogTitle: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  closeText: { color: colors.gray400, fontSize: 26, lineHeight: 24 },
  dialogScroll: { paddingHorizontal: 16, paddingVertical: 4 },
  label: {
    color: colors.gray400,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 13,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  input: {
    color: colors.white,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
  },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 2 },
  choice: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray950,
    paddingHorizontal: 9,
    paddingVertical: 7,
    maxWidth: 180,
  },
  choiceSelected: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  choiceText: { color: colors.gray400, fontSize: 11 },
  choiceTextSelected: { color: colors.white },
  error: { color: colors.red400, fontSize: 12, marginTop: 12 },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  cancelButton: { paddingHorizontal: 12, paddingVertical: 9 },
  cancelText: { color: colors.gray400, fontSize: 12 },
  saveButton: {
    backgroundColor: colors.blue600,
    borderRadius: 7,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  disabledButton: { backgroundColor: colors.gray700 },
  saveText: { color: colors.white, fontSize: 12, fontWeight: '600' },
});
