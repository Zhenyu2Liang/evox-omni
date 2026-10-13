export type ToolName = import('./tool-catalog').CatalogToolName;
export type ToolCategory =
  | 'account' | 'transaction' | 'contact' | 'transfer' | 'card' | 'subscription'
  | 'investment' | 'task' | 'budget' | 'planner' | 'security';
export interface ToolDescriptor { name: ToolName; category: ToolCategory; description: string; }
