import { useEffect, useRef } from 'react';
import { getFeatureUsageSampler, type FeatureName } from '@/lib/featureUsageTelemetry';
import { observeCollapsed } from '@/lib/recordOnExpand';

/**
 * Record a feature-usage capability when a panel EXPANDS (collapsed
 * true -> false), however the flip happened — header button, Alt+S/Alt+O,
 * deep link. The previous-value ref starts at the MOUNT value, so a panel
 * restored collapsed from persisted UI state records nothing at startup, and
 * collapsing records nothing. (WARDEN-1494)
 */
export function useRecordOnExpand(collapsed: boolean, name: FeatureName): void {
  const prev = useRef(collapsed);
  useEffect(() => {
    prev.current = observeCollapsed(prev.current, collapsed, () => {
      getFeatureUsageSampler().sampler.recordFeatureUse(name);
    });
  }, [collapsed, name]);
}
