import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

/** Web keeps Ionicons — font glyphs load reliably in the browser. */
export default function AppIcon({ name, size = 20, color, style, ...rest }) {
  return (
    <Ionicons name={name} size={size} color={color} style={style} {...rest} />
  );
}
