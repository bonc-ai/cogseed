/** Design preview snapshots. No persistence or backend execution. */
export interface SidebarTask {
  /** Stable task identity, distinct across spaces; do not derive from a mutable title. */
  id: string;
  title: string;
  pinned?: boolean;
  spaceId?: string;
  auto?: boolean;
  channel?: string;
  time?: string;
  absoluteTime?: string;
  running?: number;
  queued?: number;
  plan?: { done: number; total: number; active?: number; failed?: number; blocked?: number };
}
export interface SidebarTasksProps {
  /** Live snapshots reconcile by stable id; local menu edits survive source updates. */
  items?: SidebarTask[];
  recent?: Partial<SidebarTask>[];
  pinned?: Partial<SidebarTask>[];
  spaces?: { id?: string; name: string; tasks?: (string | Partial<SidebarTask>)[] }[];
  initialFolded?: Record<string, boolean>;
  initialMenuId?: string;
  selectedId?: string | null;
  onOpen?: (task: SidebarTask) => void;
  onDeleteActive?: () => void;
}
export declare function SidebarTasks(props: SidebarTasksProps): JSX.Element;
