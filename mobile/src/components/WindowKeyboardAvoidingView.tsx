import React, { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * KeyboardAvoidingView that works when it is not at the top of the screen.
 *
 * RN's KeyboardAvoidingView compares its onLayout frame (relative to its
 * parent) with the keyboard's screen Y, so `keyboardVerticalOffset` must be
 * the parent's distance from the top of the window. Screens nested under the
 * Hub header and tab strip sit far below y=0, and a guessed constant leaves
 * the composer under the keyboard. This measures that distance instead.
 */
export default function WindowKeyboardAvoidingView({
  style,
  testID,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
}) {
  const wrapperRef = useRef<View>(null);
  const [offset, setOffset] = useState(0);

  const measure = useCallback(() => {
    wrapperRef.current?.measureInWindow?.((_x, y) => {
      if (Number.isFinite(y)) setOffset(Math.max(0, Math.round(y)));
    });
  }, []);

  return (
    <View ref={wrapperRef} style={{ flex: 1, minHeight: 0 }} onLayout={measure} collapsable={false}>
      <KeyboardAvoidingView
        style={style}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={offset}
        testID={testID}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
