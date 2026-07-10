// Health utility functions for frontend

export const HealthState = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  IDLE: 'idle',
  UNKNOWN: 'unknown'
} as const;

export type HealthStateValue = typeof HealthState[keyof typeof HealthState];

/**
 * Get color class for a health state
 */
export function getHealthColor(state: HealthStateValue): string {
  switch (state) {
    case HealthState.HEALTHY:
      return 'text-green-400';
    case HealthState.WARNING:
      return 'text-yellow-400';
    case HealthState.CRITICAL:
      return 'text-red-400';
    case HealthState.IDLE:
      return 'text-gray-400';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Get background color class for a health state
 */
export function getHealthBgColor(state: HealthStateValue): string {
  switch (state) {
    case HealthState.HEALTHY:
      return 'bg-green-500';
    case HealthState.WARNING:
      return 'bg-yellow-500';
    case HealthState.CRITICAL:
      return 'bg-red-500';
    case HealthState.IDLE:
      return 'bg-gray-500';
    default:
      return 'bg-muted-foreground';
  }
}

/**
 * Format health state for display
 */
export function formatHealthState(state: HealthStateValue): string {
  switch (state) {
    case HealthState.HEALTHY:
      return 'Healthy';
    case HealthState.WARNING:
      return 'Warning';
    case HealthState.CRITICAL:
      return 'Critical';
    case HealthState.IDLE:
      return 'Idle';
    default:
      return 'Unknown';
  }
}

/**
 * Get health state icon/indicator — a non-color cue used alongside color so
 * state survives grayscale / color-vision deficiency (WCAG 1.4.1).
 * Each glyph is distinct (healthy `✓` vs critical `✕`, unlike the old `●`/`●`).
 */
export function getHealthIcon(state: HealthStateValue): string {
  switch (state) {
    case HealthState.HEALTHY:
      return '✓';
    case HealthState.WARNING:
      return '◐';
    case HealthState.CRITICAL:
      return '✕';
    case HealthState.IDLE:
      return '○';
    default:
      return '·';
  }
}
