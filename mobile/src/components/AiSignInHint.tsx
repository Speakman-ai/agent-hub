import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';

export default function AiSignInHint({
  target,
  onDismiss,
}: {
  target: 'Settings' | 'Account';
  onDismiss: () => void;
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduceMotion(value);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(offset, { toValue: 5, duration: 450, useNativeDriver: true }),
        Animated.timing(offset, { toValue: 0, duration: 450, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
      offset.setValue(0);
    };
  }, [reduceMotion, offset]);
  return (
    <View style={{ padding: 12, borderRadius: 8, backgroundColor: colors.gray800 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: colors.emerald400, flex: 1, fontSize: 13 }}
        >
          {target === 'Settings'
            ? 'Open Settings to connect your AI account.'
            : 'Choose Account to sign in with your AI credentials.'}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Dismiss AI sign-in guide"
          onPress={onDismiss}
          style={{ padding: 8 }}
        >
          <Text style={{ color: colors.gray300 }}>×</Text>
        </TouchableOpacity>
      </View>
      <Animated.Text
        accessible={false}
        style={{ color: colors.emerald400, fontSize: 24, transform: [{ translateY: offset }] }}
      >
        ↓
      </Animated.Text>
    </View>
  );
}
