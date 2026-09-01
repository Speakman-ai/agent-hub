import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { parseWikiRagIndicator } from '@shared/utils/wikiRagIndicator';

/**
 * Mobile parity for the web "Consulted wiki" chip. Rendered under an assistant
 * bubble when the automatic wiki-RAG path ran that turn. `consulted` shows a
 * tappable "Consulted wiki · N pages" that expands the page list; `no_match`
 * shows a subtle "Wiki checked · no strong match". Renders nothing when the
 * message carries no wiki-RAG metadata.
 */
function WikiConsultedChip({ metadata }: { metadata: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const indicator = parseWikiRagIndicator(metadata);
  if (!indicator) return null;

  if (indicator.status === 'no_match') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.noMatch}>📖 Wiki checked · no strong match</Text>
      </View>
    );
  }

  const count = indicator.retrieved || indicator.pages.length;
  const canExpand = indicator.pages.length > 0;
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        disabled={!canExpand}
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`Consulted wiki, ${count} ${count === 1 ? 'page' : 'pages'}`}
      >
        <View style={styles.chip}>
          <Text style={styles.chipText}>
            📖 Consulted wiki · {count} {count === 1 ? 'page' : 'pages'}
            {canExpand ? (expanded ? ' ▾' : ' ▸') : ''}
          </Text>
        </View>
      </TouchableOpacity>
      {expanded && canExpand && (
        <View style={styles.list}>
          {indicator.pages.map((p) => (
            <Text key={p.slug} style={styles.pageRow} numberOfLines={1}>
              <Text style={styles.pageTitle}>{p.title}</Text>
              {p.category ? <Text style={styles.pageCat}> · {p.category}</Text> : null}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 6 },
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.emerald800_50,
    backgroundColor: colors.emerald900_40,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipText: { color: colors.emerald300, fontSize: 11 },
  noMatch: { color: colors.gray500, fontSize: 11 },
  list: { marginTop: 4, paddingLeft: 2 },
  pageRow: { fontSize: 11, marginBottom: 1 },
  pageTitle: { color: colors.gray300 },
  pageCat: { color: colors.gray600 },
});

export default WikiConsultedChip;
