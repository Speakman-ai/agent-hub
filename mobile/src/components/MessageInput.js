import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Image,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { colors } from '../theme/colors';

export default function MessageInput({ onSend, onCancel, disabled, isProcessing, agentColor, skills, queueLength }) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState([]); // [{id, uri, name, base64}]
  const inputRef = useRef(null);

  // Slash-command autocomplete state
  const [slashQuery, setSlashQuery] = useState(null);   // null = closed, string = filter
  const [slashStart, setSlashStart] = useState(null);    // position of the '/'
  const cursorRef = useRef(0);

  // Filtered skills for autocomplete
  const filteredSkills = (skills || []).filter((s) =>
    slashQuery === null
      ? false
      : (s.name || s.id || '').toLowerCase().includes(slashQuery.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(slashQuery.toLowerCase())
  );

  const closeSlash = useCallback(() => {
    setSlashQuery(null);
    setSlashStart(null);
  }, []);

  const insertSkill = useCallback((skillId) => {
    if (slashStart === null) return;
    const before = value.slice(0, slashStart);
    const cursor = cursorRef.current;
    const after = value.slice(Math.max(cursor, slashStart));
    const newValue = `${before}/${skillId} ${after}`;
    setValue(newValue);
    closeSlash();
  }, [value, slashStart, closeSlash]);

  const handleSelectionChange = useCallback((e) => {
    cursorRef.current = e.nativeEvent.selection.start;
  }, []);

  const handleChangeText = useCallback((val) => {
    setValue(val);
    // Use a small delay so cursorRef has updated from onSelectionChange
    setTimeout(() => {
      const cursor = Math.min(cursorRef.current + 1, val.length);
      const textBeforeCursor = val.slice(0, cursor);
      const slashMatch = textBeforeCursor.match(/(^|\n)\/([a-zA-Z0-9_.-]*)$/);
      if (slashMatch && skills?.length > 0) {
        const query = slashMatch[2];
        const slashPos = textBeforeCursor.length - slashMatch[0].length + slashMatch[1].length;
        setSlashQuery(query);
        setSlashStart(slashPos);
      } else {
        closeSlash();
      }
    }, 0);
  }, [skills, closeSlash]);

  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets) {
        const newImages = result.assets.map((asset) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}.jpg`,
          dataUrl: `data:image/jpeg;base64,${asset.base64}`,
        }));
        setImages((prev) => [...prev, ...newImages]);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to pick image');
    }
  };

  const removeImage = (id) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed || '(image attached)', images);
    setValue('');
    setImages([]);
    closeSlash();
  };

  return (
    <View style={styles.container}>
      {/* Slash-command autocomplete popup */}
      {slashQuery !== null && filteredSkills.length > 0 && (
        <View style={styles.slashPopup}>
          <View style={styles.slashHeader}>
            <Ionicons name="flash" size={12} color={colors.gray500} />
            <Text style={styles.slashHeaderText}>Skills</Text>
          </View>
          <ScrollView style={styles.slashList} keyboardShouldPersistTaps="always">
            {filteredSkills.map((skill) => (
              <TouchableOpacity
                key={skill.id}
                onPress={() => insertSkill(skill.id)}
                style={styles.slashItem}
                activeOpacity={0.7}
              >
                <Text style={styles.slashSlash}>/</Text>
                <View style={styles.slashItemContent}>
                  <Text style={styles.slashItemName}>{skill.name || skill.id}</Text>
                  {skill.description ? (
                    <Text style={styles.slashItemDesc} numberOfLines={1}>
                      {skill.description}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Image previews */}
      {images.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.imagePreviewRow}
          contentContainerStyle={styles.imagePreviewContent}
        >
          {images.map((img) => (
            <View key={img.id} style={styles.imagePreviewItem}>
              <Image source={{ uri: img.uri }} style={styles.imagePreview} />
              <TouchableOpacity
                style={styles.removeImageBtn}
                onPress={() => removeImage(img.id)}
              >
                <Ionicons name="close-circle" size={18} color={colors.red600} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inner}>
        {/* Image picker button */}
        <TouchableOpacity
          style={styles.imageButton}
          onPress={pickImage}
          disabled={disabled && !isProcessing}
          activeOpacity={0.7}
        >
          <Ionicons
            name="image-outline"
            size={22}
            color={disabled && !isProcessing ? colors.gray600 : colors.gray400}
          />
        </TouchableOpacity>

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          placeholder={disabled ? 'Waiting...' : 'Message...'}
          placeholderTextColor={colors.gray500}
          editable={!disabled || isProcessing}
          multiline
          maxLength={10000}
          style={[styles.input, disabled && !isProcessing && styles.inputDisabled]}
          onSubmitEditing={handleSubmit}
          blurOnSubmit={false}
          returnKeyType="send"
        />
        {isProcessing ? (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={onCancel}
            activeOpacity={0.7}
          >
            <Ionicons name="close-circle" size={22} color={colors.white} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendButton,
              {
                backgroundColor:
                  disabled || (!value.trim() && images.length === 0)
                    ? colors.gray600
                    : agentColor || '#4F46E5',
              },
            ]}
            onPress={handleSubmit}
            disabled={disabled || (!value.trim() && images.length === 0)}
            activeOpacity={0.7}
          >
            <Ionicons name="send" size={18} color={colors.white} />
            {isProcessing && queueLength > 0 && (
              <View style={styles.queueBadge}>
                <Text style={styles.queueBadgeText}>{queueLength}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 8 : 8,
    backgroundColor: colors.gray950,
  },
  // Slash-command autocomplete styles
  slashPopup: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    marginBottom: 8,
    overflow: 'hidden',
    maxHeight: 200,
  },
  slashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray700,
  },
  slashHeaderText: {
    fontSize: 11,
    color: colors.gray500,
  },
  slashList: {
    maxHeight: 170,
  },
  slashItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  slashSlash: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    color: colors.gray500,
    marginTop: 1,
  },
  slashItemContent: {
    flex: 1,
  },
  slashItemName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray100,
  },
  slashItemDesc: {
    fontSize: 12,
    color: colors.gray500,
    marginTop: 2,
  },
  // Image styles
  imagePreviewRow: {
    marginBottom: 8,
  },
  imagePreviewContent: {
    gap: 8,
  },
  imagePreviewItem: {
    position: 'relative',
  },
  imagePreview: {
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  removeImageBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: colors.gray900,
    borderRadius: 9,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  imageButton: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 12 : 8,
    paddingBottom: Platform.OS === 'ios' ? 12 : 8,
    color: colors.gray100,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: colors.red600,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: colors.red600,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  queueBadgeText: {
    color: colors.white,
    fontSize: 9,
    fontWeight: 'bold',
  },
});
