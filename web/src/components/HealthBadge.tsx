import { Badge } from '@/components/ui/badge';
import { getHealthColor, getHealthBgColor, formatHealthState } from '@/lib/healthUtils';
import type { HealthStateValue } from '@/lib/healthUtils';

interface HealthBadgeProps {
  state: HealthStateValue;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function HealthBadge({ state, showLabel = true, size = 'md', className = '' }: HealthBadgeProps) {
  const textColor = getHealthColor(state);
  const bgColor = getHealthBgColor(state);
  const label = formatHealthState(state);

  const sizeClasses = {
    sm: 'text-[10px] px-1.5 py-0.5',
    md: 'text-xs px-2 py-1',
    lg: 'text-sm px-2.5 py-1.5'
  };

  const dotSizes = {
    sm: 'size-1',
    md: 'size-1.5',
    lg: 'size-2'
  };

  return (
    <Badge className={`${sizeClasses[size]} ${className}`} variant="outline">
      <span className={`inline-flex items-center gap-1.5`}>
        <span className={`${dotSizes[size]} rounded-full ${bgColor}`} aria-hidden="true" />
        {showLabel && (
          <span className={textColor}>
            {label}
          </span>
        )}
      </span>
    </Badge>
  );
}
