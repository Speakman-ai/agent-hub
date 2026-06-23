import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, ScrollView, StyleSheet, Pressable, } from 'react-native';
import { colors } from '../theme/colors';
export default function AgentSwitcher({ visible, agents, onSelect, onClose }: any) {
    const [query, setQuery] = useState('');
    const inputRef = useRef<any>(null);
    useEffect(() => {
        if (visible) {
            setQuery('');
            // Small delay to ensure modal is rendered before focusing
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [visible]);
    const filtered = agents.filter((a: any) => a.name.toLowerCase().includes(query.toLowerCase()));
    return (<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <View style={styles.container} onStartShouldSetResponder={() => true}>
          <View style={styles.searchContainer}>
            <TextInput ref={inputRef} value={query} onChangeText={setQuery} placeholder="Switch agent... (type to filter)" placeholderTextColor={colors.gray500} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => {
            if (filtered.length > 0) {
                onSelect(filtered[0].id);
                onClose();
            }
        }}/>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {filtered.map((agent: any) => (<TouchableOpacity key={agent.id} style={styles.agentItem} onPress={() => {
                onSelect(agent.id);
                onClose();
            }}>
                <View style={[styles.agentDot, { backgroundColor: agent.color }]}/>
                <View style={styles.agentInfo}>
                  <Text style={styles.agentName}>{agent.name}</Text>
                  <Text style={styles.agentEngine}>{agent.engine}</Text>
                </View>
              </TouchableOpacity>))}
            {filtered.length === 0 && (<Text style={styles.emptyText}>No agents found</Text>)}
          </ScrollView>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Tap to select</Text>
          </View>
        </View>
      </Pressable>
    </Modal>);
}
const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: colors.black60,
        justifyContent: 'flex-start',
        alignItems: 'center',
        paddingTop: '20%',
    },
    container: {
        width: '90%',
        maxWidth: 400,
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 15,
    },
    searchContainer: {
        padding: 16,
    },
    searchInput: {
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
        color: colors.gray100,
        fontSize: 15,
    },
    list: {
        maxHeight: 256,
        paddingBottom: 8,
    },
    agentItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 24,
        paddingVertical: 12,
    },
    agentDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
    },
    agentInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    agentName: {
        fontSize: 14,
        fontWeight: '500',
        color: colors.gray200,
    },
    agentEngine: {
        fontSize: 12,
        color: colors.gray500,
    },
    emptyText: {
        fontSize: 14,
        color: colors.gray500,
        paddingHorizontal: 24,
        paddingVertical: 12,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
    },
    footerText: {
        fontSize: 11,
        color: colors.gray600,
    },
});
