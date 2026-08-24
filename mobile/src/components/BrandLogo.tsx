import { Image, StyleSheet } from 'react-native';

const LOGO = require('../../assets/logo.png');
const MARK = require('../../assets/logo-mark.png');

export default function BrandLogo({
  variant = 'full',
  size = 'md',
  accessibilityLabel = 'Agent Hub',
}: {
  variant?: 'full' | 'mark';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  accessibilityLabel?: string;
}) {
  const height = size === 'xs' ? 16 : size === 'sm' ? 24 : size === 'lg' ? 40 : 28;
  if (variant === 'mark') {
    return (
      <Image
        source={MARK}
        style={{ width: height, height }}
        resizeMode="contain"
        accessibilityLabel={accessibilityLabel}
        testID="brand-logo-mark"
      />
    );
  }
  return (
    <Image
      source={LOGO}
      style={[styles.lockup, { height, width: height * 4.05 }]}
      resizeMode="contain"
      accessibilityLabel={accessibilityLabel}
      testID="brand-logo"
    />
  );
}

const styles = StyleSheet.create({
  lockup: {
    maxWidth: '100%',
  },
});
