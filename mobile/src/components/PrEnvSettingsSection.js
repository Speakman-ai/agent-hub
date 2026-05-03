import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  buildEnabledTogglePayload,
  formatPortRange,
  formatValidateRows,
  maskedDisplay,
} from '../utils/prEnvPayload';

/**
 * Mobile MVP for PR environment settings.
 *
 * Mirrors the web `PrEnvironmentsSection` (Tier 1) UX shape but limits the
 * mobile surface to: view masked state, toggle the `enabled` flag, and run
 * the 4-check validate flow. Editing Tier 1 fields and Tier 2 credentials
 * stays on web — the read-only rows show "Edit on web" hints. Backend
 * contract lives in `server/routes/pr-env-settings.ts`.
 */
export default function PrEnvSettingsSection() {
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [validateError, setValidateError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.getPrEnvSettings();
      setServer(data);
    } catch (e) {
      setLoadError(e?.message || 'Failed to load PR-env settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (next) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updatePrEnvSettings(buildEnabledTogglePayload(next));
      setServer(updated);
      // Any save invalidates the prior validate result — config may have changed.
      setValidateResult(null);
    } catch (e) {
      setSaveError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidateError(null);
    setValidateResult(null);
    try {
      const result = await api.validatePrEnvSettings({});
      setValidateResult(result);
    } catch (e) {
      setValidateError(e?.message || 'Validation failed');
    } finally {
      setValidating(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator size="small" color={colors.gray400} />
        <Text style={styles.loadingText}>Loading PR environment settings…</Text>
      </View>
    );
  }

  if (loadError) {
    return (
      <View>
        <Text style={styles.sectionTitle}>PR Environments</Text>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Failed to load</Text>
          <Text style={styles.errorMessage}>{loadError}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const enabled = !!server?.enabled;
  const rows = formatValidateRows(validateResult);

  return (
    <View>
      <Text style={styles.sectionTitle}>PR Environments</Text>
      <Text style={styles.sectionDesc}>
        Per-PR preview environments. Tier 1 (general) and Tier 2 (credentials) editing stay on web —
        this screen is for viewing masked state, toggling the feature flag, and running the
        validate flow.
      </Text>

      {/* Inherited credentials notice */}
      <View style={styles.infoBox} testID="prenv-inherited-creds-notice">
        <Text style={styles.infoTitle}>Credentials come from infrastructure</Text>
        <Text style={styles.infoText}>
          GitHub App credentials are inherited from the registered Reviewer App, and Route 53 access
          is provided by the EC2 instance role (IMDSv2). Both are managed by Terraform and not
          editable here.
        </Text>
      </View>

      {/* Enabled toggle */}
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.cardTitle}>Feature enabled</Text>
            <Text style={styles.cardDesc}>
              When on, PR webhooks trigger preview environment builds using the configured
              credentials.
            </Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={handleToggle}
            disabled={loading || saving}
            trackColor={{ false: colors.gray700, true: colors.blue600 }}
            thumbColor={colors.white}
            testID="prenv-enabled-switch"
          />
        </View>
        {saving && (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={colors.gray400} />
            <Text style={styles.statusText}>Saving…</Text>
          </View>
        )}
        {saveError && <Text style={styles.statusError}>{saveError}</Text>}
      </View>

      {/* Read-only Tier 1 rows */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>General</Text>
          <Text style={styles.editOnWebHint}>Edit on web</Text>
        </View>
        <ReadOnlyRow label="Repo" value={maskedDisplay(server?.repoFullName)} />
        <ReadOnlyRow label="Preview host" value={maskedDisplay(server?.previewHost)} />
        <ReadOnlyRow label="Preview base URL" value={maskedDisplay(server?.previewBaseUrl)} />
        <ReadOnlyRow
          label="Port range"
          value={formatPortRange(server?.portRangeMin, server?.portRangeMax)}
        />
        <ReadOnlyRow
          label="Cert renewal"
          value={server?.certRenewalLive ? 'Live (production)' : 'Staging'}
        />
      </View>

      {/* Validate */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Validate configuration</Text>
        </View>
        <Text style={styles.cardDesc}>
          Runs the 4 environment checks: Docker, nginx sites dirs, GitHub App access, and Route 53
          hosted zone.
        </Text>
        <TouchableOpacity
          style={[styles.validateBtn, validating && styles.validateBtnDisabled]}
          onPress={handleValidate}
          disabled={validating}
          testID="prenv-validate-btn"
        >
          {validating ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.validateBtnText}>Validate now</Text>
          )}
        </TouchableOpacity>

        {validateError && (
          <View style={styles.validateErrorBox} testID="prenv-validate-error">
            <Text style={styles.statusError}>{validateError}</Text>
          </View>
        )}

        {validateResult && (
          <View style={styles.validateResults} testID="prenv-validate-results">
            <Text
              style={[
                styles.validateSummary,
                validateResult.ok ? styles.validateSummaryOk : styles.validateSummaryFail,
              ]}
            >
              {validateResult.ok ? 'All checks passed.' : 'One or more checks failed.'}
            </Text>
            {rows.map((row) => (
              <ValidateCheckRow key={row.name} row={row} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function ReadOnlyRow({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ValidateCheckRow({ row }) {
  return (
    <View
      style={[
        styles.checkRow,
        row.pass ? styles.checkRowPass : styles.checkRowFail,
      ]}
      testID={`prenv-check-${row.name}`}
    >
      <Text style={[styles.checkIcon, row.pass ? styles.checkIconPass : styles.checkIconFail]}>
        {row.pass ? '✓' : '✕'}
      </Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.checkLabel}>{row.label}</Text>
        <Text style={styles.checkMessage}>{row.message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    color: colors.gray500,
    marginBottom: 16,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 13,
    color: colors.gray400,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.red400,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 10,
  },
  retryBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  retryBtnText: {
    fontSize: 12,
    color: colors.gray300,
    fontWeight: '500',
  },
  infoBox: {
    backgroundColor: 'rgba(37, 99, 235, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.3)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.blue400,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 12,
    color: colors.gray300,
    lineHeight: 17,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
  cardDesc: {
    fontSize: 12,
    color: colors.gray500,
    lineHeight: 16,
    marginTop: 4,
  },
  editOnWebHint: {
    fontSize: 11,
    color: colors.gray500,
    fontStyle: 'italic',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  statusText: {
    fontSize: 12,
    color: colors.gray400,
  },
  statusError: {
    fontSize: 12,
    color: colors.red400,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
  },
  rowLabel: {
    fontSize: 12,
    color: colors.gray400,
    width: 130,
  },
  rowValue: {
    flex: 1,
    fontSize: 12,
    color: colors.gray100,
    fontFamily: 'monospace',
  },
  validateBtn: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  validateBtnDisabled: {
    opacity: 0.6,
  },
  validateBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  validateErrorBox: {
    marginTop: 10,
  },
  validateResults: {
    marginTop: 12,
    gap: 8,
  },
  validateSummary: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  validateSummaryOk: {
    color: colors.emerald400,
  },
  validateSummaryFail: {
    color: '#fbbf24',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
  },
  checkRowPass: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.25)',
  },
  checkRowFail: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.25)',
  },
  checkIcon: {
    fontSize: 14,
    fontWeight: '700',
    width: 14,
    textAlign: 'center',
    marginTop: 1,
  },
  checkIconPass: {
    color: colors.emerald400,
  },
  checkIconFail: {
    color: colors.red400,
  },
  checkLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.gray100,
  },
  checkMessage: {
    fontSize: 11,
    color: colors.gray300,
    marginTop: 2,
    lineHeight: 15,
  },
});
