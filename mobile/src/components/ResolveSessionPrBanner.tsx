import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { colors } from '../theme/colors';
import { parseNativePrUrl } from '../utils/prFormatting';
/**
 * Mobile counterpart to `client/src/components/ResolveSessionPrBanner.tsx`.
 *
 * `prUrl` is either a github.com URL or an Agent Hub-native route
 * (`/projects/<id>/pulls/<n>`). Native PRs open the in-app Pull Requests
 * screen — `Linking.openURL` on a relative route would fail, and the mirrored
 * github.com repo has a different PR numbering.
 */
export default function ResolveSessionPrBanner({ prUrl, prNumber, branchLabel, sessionId, onDismiss, onOpenPrDetail, }: any) {
    const nativeTarget = parseNativePrUrl(prUrl);
    const canOpenNative = Boolean(nativeTarget) && typeof onOpenPrDetail === 'function';
    const hostLabel = nativeTarget ? 'Agent Hub' : 'GitHub';
    const openPr = () => {
        if (nativeTarget && canOpenNative) {
            onOpenPrDetail(nativeTarget.projectId, nativeTarget.number);
            return;
        }
        if (!prUrl || nativeTarget)
            return;
        Linking.openURL(prUrl).catch((err: any) => {
            console.warn('[ResolveSessionPrBanner] openURL failed:', err?.message || err);
        });
    };
    return (<View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.icon} accessible={false}>
            PR
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>
              Existing PR{prNumber ? ` #${prNumber}` : ''}
              {branchLabel ? (<Text style={styles.branch}> ({branchLabel})</Text>) : null}
            </Text>
            <Text style={styles.sub}>
              {prUrl
            ? `Open on ${hostLabel} — this session is not creating a new PR.`
            : 'Set the project repository in settings to link this PR.'}
            </Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => onDismiss?.(sessionId)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Text style={styles.dismiss}>✕</Text>
        </TouchableOpacity>
      </View>
      {prUrl && (canOpenNative || !nativeTarget) ? (<TouchableOpacity onPress={openPr} style={styles.linkBtn} accessibilityRole="link" accessibilityLabel={`Open pull request on ${hostLabel}`} testID="resolve-pr-banner-link">
          <Text style={styles.linkText}>Open PR on {hostLabel}</Text>
        </TouchableOpacity>) : null}
    </View>);
}
const styles = StyleSheet.create({
    container: {
        marginHorizontal: 12,
        marginBottom: 12,
        padding: 14,
        borderRadius: 12,
        backgroundColor: colors.gray800,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.gray700,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        flex: 1,
        minWidth: 0,
    },
    icon: {
        fontSize: 16,
        marginTop: 2,
    },
    title: {
        color: colors.gray200,
        fontSize: 15,
        fontWeight: '600',
    },
    branch: {
        color: colors.gray500,
        fontWeight: '400',
        fontSize: 13,
    },
    sub: {
        marginTop: 4,
        color: colors.gray500,
        fontSize: 12,
        lineHeight: 16,
    },
    dismiss: {
        color: colors.gray500,
        fontSize: 16,
        paddingHorizontal: 4,
    },
    linkBtn: {
        marginTop: 12,
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    linkText: {
        color: colors.blue400,
        fontSize: 15,
        fontWeight: '600',
    },
});
