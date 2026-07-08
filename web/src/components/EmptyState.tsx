import { Button } from '@/components/ui/button';
import { InboxIcon, SearchIcon, FileTextIcon, FolderOpenIcon } from 'lucide-react';

export interface EmptyStateProps {
  type?: 'no-results' | 'no-data' | 'no-search-matches' | 'no-tabs' | 'nothing-here';
  message?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

const TYPE_CONFIG = {
  'no-results': {
    icon: SearchIcon,
    title: 'No results found',
    description: 'Try adjusting your search or filter criteria',
  },
  'no-data': {
    icon: InboxIcon,
    title: 'No data',
    description: 'There are no items to display',
  },
  'no-search-matches': {
    icon: SearchIcon,
    title: 'No matches found',
    description: 'Your search did not match any items',
  },
  'no-tabs': {
    icon: FileTextIcon,
    title: 'No active tabs',
    description: 'Browse hosts below to start',
  },
  'nothing-here': {
    icon: FolderOpenIcon,
    title: 'Nothing here',
    description: 'Start a new chat or resume a session',
  },
};

export function EmptyState({
  type = 'no-data',
  message,
  action,
  className = '',
}: EmptyStateProps) {
  const config = TYPE_CONFIG[type];
  const Icon = config.icon;

  return (
    <div className={`flex flex-col items-center justify-center p-4 gap-2 text-center ${className}`}>
      <div className="rounded-full bg-muted/50 p-2.5">
        <Icon className="size-5 text-muted-foreground/40" />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="text-xs text-muted-foreground">{config.title}</div>
        <div className="text-[10px] text-muted-foreground/60">{message || config.description}</div>
      </div>
      {action && (
        <Button
          variant="outline"
          size="sm"
          onClick={action.onClick}
          className="gap-1.5 text-xs"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
