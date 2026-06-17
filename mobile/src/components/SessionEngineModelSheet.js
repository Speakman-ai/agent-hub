import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet, Alert } from 'react-native';
import { colors } from '../theme/colors';
import { engineOptionsFromConfig, modelsForEngine } from '../utils/engineOptions';

/**
 * Per-session engine / model picker sheet, anchored under the chat
 * header. Extracted from TopBar's previously-inline modal so the chat header
 * stays slim and so engine/model failures surface as Alerts instead of
 * unhandled promise rejections (the context handlers persist via
 * api.setSessionEngine / api.setSessionModel and throw on server errors).
 *
 * Props:
 *  - visible / onClose       — modal control
 *  - modelConfig             — GET /config/models payload (engineValidModels)
 *  - engine / model          — current session values
 *  - onSelectEngine(engineId) — async; persists engine (+ default model)
 *  - onSelectModel(modelId)   — async; persists model
 */
export default function SessionEngineModelSheet({
  visible,
  onClose,
  modelConfig,
  engine,
  model,
  onSelectEngine,
  onSelectModel,
}) {
  const engineOptions = engineOptionsFromConfig(modelConfig);
  const engineModels = modelsForEngine(engine, modelConfig);

  // Close immediately (handlers already update local state optimistically in
  // AppContext), then surface any persistence failure via Alert.
  const run = (label, fn, value) => {
    onClose?.();
    Promise.resolve()
      .then(() => fn?.(value))
      .catch((err) => {
        Alert.alert(`${label} change failed`, err?.message || 'Unknown error');
      });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <View style={styles.container}>
          {/* Engine section */}
          <Text style={styles.sectionLabel}>ENGINE</Text>
          {engineOptions.map((eng) => (
            <TouchableOpacity
              key={eng.id}
              style={styles.item}
              accessibilityRole="button"
              accessibilityLabel={`Use engine ${eng.label}`}
              onPress={() => run('Engine', onSelectEngine, eng.id)}
            >
              <View style={styles.itemRow}>
                <View style={[styles.engineDot, { backgroundColor: eng.color }]} />
                <Text style={styles.itemLabel}>{eng.label}</Text>
              </View>
              {eng.id === engine && <Text style={styles.check}>✓</Text>}
            </TouchableOpacity>
          ))}

          <View style={styles.divider} />

          {/* Model section */}
          <Text style={styles.sectionLabel}>MODEL</Text>
          {engineModels.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={styles.item}
              accessibilityRole="button"
              accessibilityLabel={`Use model ${m.label}`}
              onPress={() => run('Model', onSelectModel, m.id)}
            >
              <Text style={[styles.itemLabel, m.id === model && styles.itemLabelActive]}>
                {m.label}
              </Text>
              {m.id === model && <Text style={styles.check}>✓</Text>}
            </TouchableOpacity>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.black50,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 16,
  },
  container: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    minWidth: 220,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
  },
  engineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  itemLabel: {
    fontSize: 14,
    color: colors.gray400,
  },
  itemLabelActive: {
    color: colors.white,
  },
  check: {
    fontSize: 12,
    color: colors.emerald400,
  },
  divider: {
    height: 1,
    backgroundColor: colors.gray700,
    marginVertical: 4,
  },
});
