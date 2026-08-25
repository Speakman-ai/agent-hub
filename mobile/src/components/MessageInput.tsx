import React, { useState, useRef, useCallback, useEffect } from 'react';
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
  ActionSheetIOS,
  ActivityIndicator,
} from 'react-native';
import AppIcon from './AppIcon';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { colors } from '../theme/colors';
import { useVoiceTranscription } from '../hooks/useVoiceTranscription';
// Map a picked asset / document → attachment shape used by handleSend
// and ChatMessage. Keeps the kind ('image' | 'video' | 'file') explicit
// so the upload branch can route to base64 vs. binary endpoints without
// re-sniffing MIME types.
function makeAttachmentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function guessMimeFromName(name: any, fallback: any) {
  if (!name) return fallback;
  const ext = name.toLowerCase().split('.').pop();
  const map: Record<string, any> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
  };
  return map[ext] || fallback;
}
export default function MessageInput({
  onSend,
  onCancel,
  disabled,
  isProcessing,
  agentColor,
  skills,
  queueLength,
  askMode,
  consultMode = askMode,
  consultHint = null,
  readOnly,
  toolbarStart,
}: any) {
  const [value, setValue] = useState('');
  // Attachments: [{id, uri, name, kind, dataUrl?, mimeType?, sizeBytes?}]
  // kind ∈ 'image' | 'video' | 'file'
  const [images, setImages] = useState<any[]>([]);
  const inputRef = useRef<any>(null);
  // Slash-command autocomplete state
  const [slashQuery, setSlashQuery] = useState<any>(null); // null = closed, string = filter
  const [slashStart, setSlashStart] = useState<any>(null); // position of the '/'
  const cursorRef = useRef(0);
  // Filtered skills for autocomplete
  const filteredSkills = (skills || []).filter((s: any) =>
    slashQuery === null
      ? false
      : (s.name || s.id || '').toLowerCase().includes(slashQuery.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(slashQuery.toLowerCase()),
  );
  const closeSlash = useCallback(() => {
    setSlashQuery(null);
    setSlashStart(null);
  }, []);
  const insertSkill = useCallback(
    (skillId: any) => {
      if (slashStart === null) return;
      const before = value.slice(0, slashStart);
      const cursor = cursorRef.current;
      const after = value.slice(Math.max(cursor, slashStart));
      const newValue = `${before}/${skillId} ${after}`;
      setValue(newValue);
      closeSlash();
    },
    [value, slashStart, closeSlash],
  );
  const handleSelectionChange = useCallback((e: any) => {
    cursorRef.current = e.nativeEvent.selection.start;
  }, []);
  const reportTranscribeError = useCallback((msg: any) => {
    Alert.alert('Voice input', msg);
  }, []);
  const { isRecording, isTranscribing, micDisabled, handleMicClick } = useVoiceTranscription({
    value,
    setValue,
    cursorRef,
    disabled,
    isProcessing,
    onError: reportTranscribeError,
  });
  const handleChangeText = useCallback(
    (val: any) => {
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
    },
    [skills, closeSlash],
  );
  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.8,
        base64: true,
      });
      if (!result.canceled && result.assets) {
        const newImages = result.assets.map((asset: any) => ({
          id: makeAttachmentId(),
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}.jpg`,
          kind: 'image',
          dataUrl: `data:image/jpeg;base64,${asset.base64}`,
        }));
        setImages((prev: any) => [...prev, ...newImages]);
      }
    } catch (err: any) {
      Alert.alert('Error', 'Failed to pick image');
    }
  };
  const pickVideo = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: true,
        // No base64 for videos — they're too large; we upload the raw URI
        // via FileSystem.uploadAsync in api.uploadFile.
        quality: 0.8,
      });
      if (!result.canceled && result.assets) {
        const newVideos = result.assets.map((asset: any) => {
          const name = asset.fileName || `video-${Date.now()}.mp4`;
          return {
            id: makeAttachmentId(),
            uri: asset.uri,
            name,
            kind: 'video',
            mimeType: asset.mimeType || guessMimeFromName(name, 'video/mp4'),
            sizeBytes: asset.fileSize || null,
          };
        });
        setImages((prev: any) => [...prev, ...newVideos]);
      }
    } catch (err: any) {
      Alert.alert('Error', 'Failed to pick video');
    }
  };
  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const assets = result.assets || [];
      const newFiles = assets.map((asset: any) => ({
        id: makeAttachmentId(),
        uri: asset.uri,
        name: asset.name || `file-${Date.now()}`,
        kind: 'file',
        mimeType: asset.mimeType || 'application/octet-stream',
        sizeBytes: asset.size || null,
      }));
      if (newFiles.length > 0) {
        setImages((prev: any) => [...prev, ...newFiles]);
      }
    } catch (err: any) {
      Alert.alert('Error', 'Failed to pick file');
    }
  };
  // Show native chooser (iOS action sheet / Android Alert) for which kind
  // of attachment to add. Keeps the single paperclip affordance instead of
  // cluttering the composer with three separate buttons.
  const openAttachMenu = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Photo', 'Video', 'File'],
          cancelButtonIndex: 0,
        },
        (i: any) => {
          if (i === 1) pickImage();
          else if (i === 2) pickVideo();
          else if (i === 3) pickFile();
        },
      );
    } else {
      Alert.alert(
        'Attach',
        undefined,
        [
          { text: 'Photo', onPress: pickImage },
          { text: 'Video', onPress: pickVideo },
          { text: 'File', onPress: pickFile },
          { text: 'Cancel', style: 'cancel' },
        ],
        { cancelable: true },
      );
    }
  }, []);
  const removeImage = (id: any) => {
    setImages((prev: any) => prev.filter((img: any) => img.id !== id));
  };
  const handleSubmit = () => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed || '(attachment)', images);
    setValue('');
    setImages([]);
    closeSlash();
  };
  // Read-only sessions (reviewer threads) — render only a banner. The
  // composer, send button, and keyboard handling are all suppressed
  // because the thread is a shared artifact and only the server-side
  // spawn writes to it.
  if (readOnly) {
    return (
      <View style={styles.container}>
        <View style={styles.askModeBanner}>
          <AppIcon
            name="information-circle"
            size={14}
            color={colors.blue400}
            style={{ marginRight: 4 }}
          />
          <Text style={styles.askModeBannerText}>
            Reviewer thread, read-only. Shared with everyone in the org.
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      {/* Ask mode indicator — mirrors the web client's banner so the user
              has an unmissable cue that the session is read-only. */}
      {consultMode && (
        <View style={styles.askModeBanner}>
          <AppIcon
            name="information-circle"
            size={14}
            color={colors.blue400}
            style={{ marginRight: 4 }}
          />
          <Text style={styles.askModeBannerText}>
            {consultHint || 'Consult mode — Hub project updates only, no code ship or Finalize'}
          </Text>
        </View>
      )}

      {/* Slash-command autocomplete popup */}
      {slashQuery !== null && filteredSkills.length > 0 && (
        <View style={styles.slashPopup}>
          <View style={styles.slashHeader}>
            <AppIcon name="flash" size={12} color={colors.gray500} />
            <Text style={styles.slashHeaderText}>Skills</Text>
          </View>
          <ScrollView style={styles.slashList} keyboardShouldPersistTaps="always">
            {filteredSkills.map((skill: any) => (
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

      {/* Attachment previews */}
      {images.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.imagePreviewRow}
          contentContainerStyle={styles.imagePreviewContent}
        >
          {images.map((item: any) => (
            <View key={item.id} style={styles.imagePreviewItem}>
              {item.kind === 'image' ? (
                <Image source={{ uri: item.uri }} style={styles.imagePreview} />
              ) : item.kind === 'video' ? (
                <View style={[styles.imagePreview, styles.videoPreview]}>
                  <AppIcon name="videocam" size={22} color={colors.gray300} />
                  <Text style={styles.mediaBadge}>VIDEO</Text>
                </View>
              ) : (
                <View style={[styles.imagePreview, styles.filePreview]}>
                  <AppIcon name="document-outline" size={20} color={colors.gray300} />
                  <Text style={styles.fileName} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.removeImageBtn}
                onPress={() => removeImage(item.id)}
                accessibilityLabel="Remove attachment"
                accessibilityRole="button"
              >
                <AppIcon name="close-circle" size={18} color={colors.red600} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {toolbarStart ? <View style={styles.toolbarStart}>{toolbarStart}</View> : null}

      <View style={styles.inner}>
        {/* Attachment menu (image / video / file) */}
        <TouchableOpacity
          style={styles.imageButton}
          onPress={openAttachMenu}
          disabled={disabled && !isProcessing}
          activeOpacity={0.7}
          accessibilityLabel="Add attachment"
          accessibilityRole="button"
        >
          <AppIcon
            name="attach"
            size={22}
            color={disabled && !isProcessing ? colors.gray600 : colors.gray400}
          />
        </TouchableOpacity>

        {/* Voice input — mirrors web MessageInput mic (attach | mic | composer | send). */}
        <TouchableOpacity
          style={styles.micButton}
          onPress={handleMicClick}
          disabled={micDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={
            isTranscribing
              ? 'Transcribing voice input'
              : isRecording
                ? 'Stop recording'
                : 'Voice input'
          }
          accessibilityState={{
            disabled: !!micDisabled,
            selected: !!isRecording,
          }}
        >
          {isTranscribing ? (
            <ActivityIndicator size={20} color={colors.gray500} />
          ) : (
            <AppIcon
              name={isRecording ? 'stop' : 'mic-outline'}
              size={22}
              color={micDisabled ? colors.gray600 : isRecording ? colors.red400 : colors.gray400}
            />
          )}
        </TouchableOpacity>

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          placeholder={
            disabled ? 'Waiting...' : consultMode ? 'Consult on Agent Hub…' : 'Message...'
          }
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
          <TouchableOpacity style={styles.cancelButton} onPress={onCancel} activeOpacity={0.7}>
            <AppIcon name="close-circle" size={22} color={colors.white} />
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
            <AppIcon name="send" size={18} color={colors.white} />
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
  // Ask mode banner — shown above the composer when the session is read-only
  askModeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
    backgroundColor: colors.blue900_40,
    borderWidth: 1,
    borderColor: colors.blue400,
    borderRadius: 8,
  },
  askModeBannerText: {
    fontSize: 12,
    color: colors.blue400,
    flex: 1,
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
  // Image / attachment preview styles
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
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  videoPreview: {
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePreview: {
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  mediaBadge: {
    color: colors.gray400,
    fontSize: 9,
    fontWeight: '700',
    marginTop: 2,
  },
  fileName: {
    color: colors.gray300,
    fontSize: 9,
    marginTop: 2,
    maxWidth: 56,
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
  toolbarStart: {
    marginBottom: 8,
  },
  imageButton: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButton: {
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
