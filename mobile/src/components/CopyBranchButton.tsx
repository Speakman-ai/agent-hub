import React, { useEffect, useRef, useState } from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { Copy, Check } from 'lucide-react-native';
import { copyToClipboard } from '../utils/clipboard';
import { colors } from '../theme/colors';

interface Props {
  branch: string;
  size?: number;
}

// Icon button that copies a branch name so the user can `git checkout` it locally.
export default function CopyBranchButton({ branch, size = 13 }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!branch) return null;

  const onPress = async () => {
    const ok = await copyToClipboard(branch);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      testID="copy-branch-button"
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied branch name' : `Copy branch name ${branch}`}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={styles.button}
    >
      {copied ? (
        <Check size={size} color={colors.emerald400} />
      ) : (
        <Copy size={size} color={colors.gray400} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 4, paddingVertical: 2 },
});
