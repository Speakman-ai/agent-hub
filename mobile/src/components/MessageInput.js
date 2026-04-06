import React, { useState, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

export default function MessageInput({ onSend, onCancel, disabled, isProcessing, agentColor }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  return (
    <View style={styles.container}>
      <View style={styles.inner}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={setValue}
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
              { backgroundColor: disabled || !value.trim() ? colors.gray600 : (agentColor || '#4F46E5') },
            ]}
            onPress={handleSubmit}
            disabled={disabled || !value.trim()}
            activeOpacity={0.7}
          >
            <Ionicons name="send" size={18} color={colors.white} />
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
  inner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
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
});
