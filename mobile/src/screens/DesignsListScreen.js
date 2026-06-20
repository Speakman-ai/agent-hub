import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { resolveDesignRedirect, isDesignMigrated } from '../utils/designRedirect';
import { useApp } from '../context/AppContext';

export default function DesignsListScreen({ navigation }) {
  const { setActiveAgentId, setActiveSessionId } = useApp();
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getDesigns();
      setDesigns(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Failed to load designs');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const design = await api.createDesign({ name: trimmed });
      setShowNew(false);
      setNewName('');
      await load();
      if (design?.id) {
        navigation.navigate('DesignView', { designId: design.id, design });
      }
    } catch (err) {
      Alert.alert('Create failed', err.message || 'Could not create design');
    } finally {
      setCreating(false);
    }
  };

  // Open a design: migrated designs redirect to their design-mode session
  // (resolving the owning agent from the session row); others open the
  // standalone read-only canvas as before.
  const openDesign = async (d) => {
    const redirect = resolveDesignRedirect(d);
    if (!redirect) {
      navigation.navigate('DesignView', { designId: d.id, design: d });
      return;
    }
    try {
      const session = await api.getSession(redirect.sessionId);
      if (session?.agent_id) setActiveAgentId(session.agent_id);
      setActiveSessionId(redirect.sessionId);
      navigation.navigate('Chat');
    } catch (err) {
      Alert.alert('Open failed', err.message || 'Could not open the migrated design session');
    }
  };

  const handleDelete = (id) => {
    Alert.alert('Delete design', 'Delete this design? The artifact directory will be wiped.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeletingId(id);
          try {
            await api.deleteDesign(id);
            await load();
          } catch (err) {
            Alert.alert('Delete failed', err.message || 'Could not delete design');
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  const headerRight = (
    <TouchableOpacity style={styles.newBtn} onPress={() => setShowNew(true)}>
      <Text style={styles.newBtnText}>+ New</Text>
    </TouchableOpacity>
  );

  const renderItem = ({ item: d }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => openDesign(d)}
      onLongPress={() => handleDelete(d.id)}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {d.name}
        </Text>
        {isDesignMigrated(d) ? <Text style={styles.migratedBadge}>Migrated</Text> : null}
        {deletingId === d.id ? (
          <ActivityIndicator size="small" color={colors.gray500} />
        ) : null}
      </View>
      {d.linkedProjects?.length > 0 && (
        <View style={styles.linkedRow}>
          {d.linkedProjects.slice(0, 3).map((p) => (
            <Text key={p.id} style={[styles.linkedTag, { color: p.color || colors.gray400 }]}>
              {p.name}
            </Text>
          ))}
        </View>
      )}
      <Text style={styles.cardMeta}>
        {d.updated_at ? `Updated ${relativeTime(d.updated_at)}` : 'New'}
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ProjectScreenHeader title="Designs" right={headerRight} />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading && designs.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.blue600} />
        </View>
      ) : (
        <FlatList
          data={designs}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={1}
          contentContainerStyle={designs.length === 0 ? styles.center : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.gray400}
            />
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No designs yet. Tap + New to start chatting with the Design Studio agent.
            </Text>
          }
        />
      )}

      <Modal visible={showNew} transparent animationType="fade" onRequestClose={() => setShowNew(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New Design</Text>
            <TextInput
              style={styles.modalInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="Design name"
              placeholderTextColor={colors.gray600}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowNew(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, creating && { opacity: 0.6 }]}
                onPress={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Text style={styles.modalCreateText}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  list: { padding: 12 },
  emptyText: { color: colors.gray500, fontSize: 14, textAlign: 'center' },
  newBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 'auto',
  },
  newBtnText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  errorBox: {
    margin: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.red900_50,
    borderWidth: 1,
    borderColor: colors.red600,
  },
  errorText: { color: colors.red400, fontSize: 13 },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 14,
    marginBottom: 10,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.white },
  migratedBadge: {
    fontSize: 10,
    color: '#6ee7b7',
    backgroundColor: 'rgba(6,78,59,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  linkedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  linkedTag: { fontSize: 10, backgroundColor: colors.gray800, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cardMeta: { fontSize: 11, color: colors.gray600, marginTop: 8 },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.black60,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.gray900,
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  modalTitle: { fontSize: 16, fontWeight: '600', color: colors.white, marginBottom: 12 },
  modalInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    color: colors.white,
    fontSize: 14,
    marginBottom: 16,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalCancel: { paddingVertical: 10, paddingHorizontal: 14 },
  modalCancelText: { color: colors.gray400, fontSize: 14 },
  modalCreate: {
    backgroundColor: colors.blue600,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  modalCreateText: { color: colors.white, fontSize: 14, fontWeight: '600' },
});
