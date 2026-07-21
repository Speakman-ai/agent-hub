import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

/** Human label for a PR's relation to the epic's feature branch. */
export function relationLabel(relation: string): string {
  return relation === 'integration' ? 'Ships branch' : 'Targets branch';
}

export function stateLabel(pr: any): { label: string; color: string } {
  if (pr?.merged) return { label: 'Merged', color: colors.purple400 };
  if (pr?.state === 'closed') return { label: 'Closed', color: colors.red400 };
  return { label: 'Open', color: colors.emerald400 };
}

function isExternalUrl(url: any): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Lists the pull requests tied to an epic's feature branch (targets +
 * integration). Renders nothing until loaded and nothing when empty, so it
 * only appears when there is something to show.
 */
export default function EpicPullsSection({ projectId, epicId, onOpenPull }: any) {
  const [pulls, setPulls] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!projectId || !epicId || typeof api.getEpicPulls !== 'function') {
      setPulls([]);
      setLoaded(true);
      return () => {
        alive = false;
      };
    }
    setLoaded(false);
    api
      .getEpicPulls(projectId, epicId)
      .then((data: any) => {
        if (alive) {
          setPulls(Array.isArray(data?.pulls) ? data.pulls : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) {
          setPulls([]);
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, epicId]);

  if (!loaded) return null;
  return <EpicPullsSectionContent pulls={pulls} onOpenPull={onOpenPull} />;
}

/**
 * Pure presentational body — no data fetching. Renders nothing when there are
 * no PRs. Split out so it can be unit-rendered without a native runtime.
 */
export function EpicPullsSectionContent({ pulls, onOpenPull }: any) {
  const list: any[] = Array.isArray(pulls) ? pulls : [];
  if (list.length === 0) return null;

  const openPr = (pr: any) => {
    if (isExternalUrl(pr.html_url)) {
      Linking.openURL(pr.html_url).catch(() => undefined);
    } else if (typeof onOpenPull === 'function') {
      onOpenPull(pr.number);
    }
  };

  return (
    <View style={styles.section} testID="epic-pulls-section">
      <Text style={styles.heading}>Pull requests</Text>
      <Text style={styles.subheading}>
        {list.length} pull request{list.length === 1 ? '' : 's'} on this feature branch.
      </Text>
      {list.map((pr: any) => {
        const st = stateLabel(pr);
        return (
          <TouchableOpacity
            key={pr.number}
            style={styles.row}
            onPress={() => openPr(pr)}
            testID={`epic-pull-${pr.number}`}
          >
            <Text style={styles.prNumber}>#{pr.number}</Text>
            <Text style={styles.prTitle} numberOfLines={1}>
              {pr.title}
            </Text>
            <View style={styles.relationBadge}>
              <Text style={styles.relationText}>{relationLabel(pr.relation)}</Text>
            </View>
            <Text style={[styles.stateText, { color: st.color }]}>{st.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 12,
  },
  heading: { color: colors.gray100, fontSize: 14, fontWeight: '600' },
  subheading: { color: colors.gray500, fontSize: 12, marginTop: 2, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  prNumber: { color: colors.gray400, fontSize: 12, fontVariant: ['tabular-nums'] },
  prTitle: { color: colors.gray200, fontSize: 13, flex: 1 },
  relationBadge: {
    backgroundColor: 'rgba(99,102,241,0.12)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  relationText: { color: colors.indigo300, fontSize: 11, fontWeight: '500' },
  stateText: { fontSize: 11, fontWeight: '600' },
});
