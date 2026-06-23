import React from 'react';
import { resolveAppLucideIcon } from '../utils/appIconLucide';
/**
 * Native app chrome icons — Lucide SVG (no font loading; Expo Go safe).
 */
export default function AppIcon({ name, size = 20, color, style, strokeWidth = 2, ...rest }: any) {
    const Icon = resolveAppLucideIcon(name);
    if (!Icon) {
        if (__DEV__) {
            console.warn(`[AppIcon] no Lucide mapping for "${name}"`);
        }
        return null;
    }
    return (<Icon size={size} color={color} strokeWidth={strokeWidth} style={style} {...rest}/>);
}
