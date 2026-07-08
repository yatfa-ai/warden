import { Button } from '@/components/ui/button';
import { OctagonXIcon, WifiIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';

export interface ErrorStateProps {
  error: string | Error | unknown;
  onRetry?: () => void;
  title?: string;
  variant?: 'network' | 'timeout' | 'api' | 'general';
  className?: string;
}

const VARIANT_CONFIG = {
  network: {
    icon: WifiIcon,
    title: 'Connection Error',
    description: 'Unable to reach the server. Please check your connection.',
  },
  timeout: {
    icon: Loader2Icon,
    title: 'Request Timeout',
    description: 'The request took too long to complete. Please try again.',
  },
  api: {
    icon: OctagonXIcon,
    title: 'Server Error',
    description: 'Something went wrong on the server. Please try again.',
  },
  general: {
    icon: OctagonXIcon,
    title: 'Error',
    description: 'An unexpected error occurred.',
  },
};

export function ErrorState({
  error,
  onRetry,
  title,
  variant = 'general',
  className = '',
}: ErrorStateProps) {
  const config = VARIANT_CONFIG[variant];
  const Icon = config.icon;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const displayTitle = title || config.title;

  return (
    <div className={`flex flex-col items-center justify-center p-6 gap-3 text-center ${className}`}>
      <div className="rounded-full bg-destructive/10 p-3">
        <Icon className="size-6 text-destructive" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-sm font-semibold text-destructive">{displayTitle}</div>
        <div className="text-xs text-muted-foreground">{config.description}</div>
        {errorMessage && (
          <div className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
            {errorMessage}
          </div>
        )}
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="gap-1.5"
        >
          <RefreshCwIcon className="size-3" />
          Retry
        </Button>
      )}
    </div>
  );
}
