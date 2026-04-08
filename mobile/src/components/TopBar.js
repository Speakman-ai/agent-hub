import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { SidebarContext } from '../context/SidebarContext';

const ENGINE_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', color: '#8B5CF6' },
  { id: 'cursor-agent', label: 'Cursor Agent', color: '#10B981' },
];

const ENGINE_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-6', label: 'Opus', short: 'Opus' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet', short: 'Sonnet' },
  ],
  'cursor-agent': [
    { id: 'gpt-5.3-codex-high', label: 'Codex 5.3 High', short: 'C5.3-H' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3', short: 'C5.3' },
    { id: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low', short: 'C5.3-L' },
    { id: 'gpt-5.3-codex-fast', label: 'Codex 5.3 Fast', short: 'C5.3-F' },
    { id: 'gpt-5.2-codex-high', label: 'Codex 5.2 High', short: 'C5.2-H' },
    { id: 'gpt-5.2-codex', label: 'Codex 5.2', short: 'C5.2' },
    { id: 'gpt-5.1-codex-max-high', label: 'Codex 5.1 Max High', short: 'C5.1MH' },
    { id: 'composer-2', label: 'Composer 2', short: 'Comp2' },
    { id: 'composer-2-fast', label: 'Composer 2 Fast', short: 'Comp2F' },
    { id: 'auto', label: 'Auto', short: 'Auto' },
  ],
};

export default function TopBar() {
  const {
    activeAgent,
    connected,
    reconnecting,
    sessionEngine,
    sessionModel,
    handleEngineChange,
    handleModelChange,
    handleNewSession,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const [showPicker, setShowPicker] = useState(false);

  const currentEngine = ENGINE_OPTIONS.find((e) => e.id === sessionEngine) || ENGINE_OPTIONS[0];
  const engineModels = ENGINE_MODELS[sessionEngine] || ENGINE_MODELS['claude-code'];
  const currentModel = engineModels.find((m) => m.id === sessionModel) || engineModels[0];

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={openSidebar}
        >
          <Ionicons name="menu" size={24} color={colors.gray400} />
        </TouchableOpacity>
        {activeAgent && (
          <View style={styles.agentInfo}>
            <View style={[styles.agentDot, { backgroundColor: activeAgent.color }]} />
            <Text style={styles.agentName} numberOfLines={1}>
              {activeAgent.name}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.right}>
        {/* Engine + Model button */}
        {activeAgent && (
          <TouchableOpacity
            style={styles.engineButton}
            onPress={() => setShowPicker(true)}
          >
            <View style={[styles.engineDotSmall, { backgroundColor: currentEngine.color }]} />
            <Text style={styles.engineLabel}>{currentModel.short}</Text>
            <Ionicons name="chevron-down" size={12} color={colors.gray500} />
          </TouchableOpacity>
        )}

        {/* Connection status */}
        <View
          style={[
            styles.statusBadge,
            connected
              ? styles.statusConnected
              : reconnecting
              ? styles.statusReconnecting
              : styles.statusDisconnected,
          ]}
        >
          <Text
            style={[
              styles.statusDot,
              connected
                ? styles.statusDotConnected
                : reconnecting
                ? styles.statusDotReconnecting
                : styles.statusDotDisconnected,
            ]}
          >
            ●
          </Text>
        </View>

        {/* New session */}
        <TouchableOpacity
          style={styles.newButton}
          onPress={handleNewSession}
          disabled={!activeAgent}
        >
          <Ionicons name="add" size={20} color={colors.white} />
        </TouchableOpacity>
      </View>

      {/* Engine/Model Picker Modal */}
      <Modal
        visible={showPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowPicker(false)}>
          <View style={styles.pickerContainer}>
            {/* Engine section */}
            <Text style={styles.pickerSectionLabel}>ENGINE</Text>
            {ENGINE_OPTIONS.map((eng) => (
              <TouchableOpacity
                key={eng.id}
                style={styles.pickerItem}
                onPress={() => {
                  handleEngineChange(eng.id);
                  setShowPicker(false);
                }}
              >
                <View style={styles.pickerItemRow}>
                  <View style={[styles.engineDotSmall, { backgroundColor: eng.color }]} />
                  <Text style={styles.pickerItemLabel}>{eng.label}</Text>
                </View>
                {eng.id === sessionEngine && (
                  <Text style={styles.pickerCheck}>✓</Text>
                )}
              </TouchableOpacity>
            ))}

            <View style={styles.pickerDivider} />

            {/* Model section */}
            <Text style={styles.pickerSectionLabel}>MODEL</Text>
            {engineModels.map((m) => (
              <TouchableOpacity
                key={m.id}
                style={styles.pickerItem}
                onPress={() => {
                  handleModelChange(m.id);
                  setShowPicker(false);
                }}
              >
                <Text
                  style={[
                    styles.pickerItemLabel,
                    m.id === sessionModel && styles.pickerItemLabelActive,
                  ]}
                >
                  {m.label}
                </Text>
                {m.id === sessionModel && (
                  <Text style={styles.pickerCheck}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900 + '80',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  menuButton: {
    padding: 8,
    marginRight: 4,
  },
  agentInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  agentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  agentName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  engineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  engineDotSmall: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  engineLabel: {
    fontSize: 12,
    color: colors.gray300,
  },
  statusBadge: {
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusConnected: {
    backgroundColor: colors.emerald900_50,
  },
  statusReconnecting: {
    backgroundColor: colors.yellow900_50,
  },
  statusDisconnected: {
    backgroundColor: colors.red900_50,
  },
  statusDot: {
    fontSize: 10,
  },
  statusDotConnected: {
    color: colors.emerald400,
  },
  statusDotReconnecting: {
    color: colors.yellow400,
  },
  statusDotDisconnected: {
    color: colors.red400,
  },
  newButton: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    padding: 6,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.black50,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 16,
  },
  pickerContainer: {
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
  pickerSectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.gray500,
    letterSpacing: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pickerItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
  },
  pickerItemLabel: {
    fontSize: 14,
    color: colors.gray400,
  },
  pickerItemLabelActive: {
    color: colors.white,
  },
  pickerCheck: {
    fontSize: 12,
    color: colors.emerald400,
  },
  pickerDivider: {
    height: 1,
    backgroundColor: colors.gray700,
    marginVertical: 4,
  },
});
