import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { colors } from '../theme/colors';
import { formatElapsed } from '../utils/time';
export default function ThinkingIndicator({ agentColor, statusText }: any) {
  const [elapsed, setElapsed] = useState(0);
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((prev: any) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const animateDot = (dot: any, delay: any) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.3,
            duration: 400,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
          Animated.delay(600 - delay),
        ]),
      );
    };
    const anim1 = animateDot(dot1, 0);
    const anim2 = animateDot(dot2, 200);
    const anim3 = animateDot(dot3, 400);
    anim1.start();
    anim2.start();
    anim3.start();
    return () => {
      anim1.stop();
      anim2.stop();
      anim3.stop();
    };
  }, []);
  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <View style={styles.header}>
          <View style={[styles.headerDot, { backgroundColor: agentColor }]} />
          <Text style={styles.headerLabel}>Assistant</Text>
        </View>
        <View style={styles.dotsRow}>
          <View style={styles.dots}>
            <Animated.View style={[styles.dot, { opacity: dot1 }]} />
            <Animated.View style={[styles.dot, { opacity: dot2 }]} />
            <Animated.View style={[styles.dot, { opacity: dot3 }]} />
          </View>
          <Text style={styles.elapsedText}>
            {statusText || 'Thinking...'} {formatElapsed(elapsed)}
          </Text>
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  bubble: {
    backgroundColor: colors.gray800,
    borderRadius: 16,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  headerLabel: {
    fontSize: 11,
    color: colors.gray500,
    fontWeight: '500',
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.gray400,
  },
  elapsedText: {
    fontSize: 11,
    color: colors.gray500,
    marginLeft: 4,
  },
});
