const AVAILABLE_RESULTS_NOTE =
  'Other analysis results remain available when their respective tools complete.';

export function aiSkippedByOrganization(): string {
  return 'This organization has disabled external model calls, so no diff content is sent ' +
    `to a provider. ${AVAILABLE_RESULTS_NOTE}`;
}

export function aiSkippedWithoutKey(provider: string): string {
  return `No API key is configured for ${provider}. Set the corresponding ` +
    `environment variable to enable AI review. ${AVAILABLE_RESULTS_NOTE}`;
}
