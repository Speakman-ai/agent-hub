import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { splitDetailsSegments } from '@shared/utils/voiceNoteMarkdown';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';

/**
 * Note markdown with `<details>` blocks (dictated-note transcripts) rendered
 * as collapsed sections. The markdown renderer drops raw HTML, so the blocks
 * are split out and drawn natively.
 */
export default function NoteMarkdown({
  content,
  style,
  rules,
}: {
  content: string;
  style?: any;
  rules?: any;
}) {
  const segments = splitDetailsSegments(content);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'details' ? (
          <CollapsibleSection key={i} title={seg.summary}>
            <Markdown style={style} rules={rules}>
              {seg.body}
            </Markdown>
          </CollapsibleSection>
        ) : (
          <Markdown key={i} style={style} rules={rules}>
            {seg.text}
          </Markdown>
        ),
      )}
    </>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={styles.header}
      >
        <AppIcon
          name={open ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={colors.gray400}
        />
        <Text style={styles.title}>{title}</Text>
      </TouchableOpacity>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginVertical: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 12, fontWeight: '500', color: colors.gray400 },
  body: { marginTop: 4 },
});
