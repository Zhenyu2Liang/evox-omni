export type RiskLevel = 'GREEN' | 'YELLOW' | 'RED';
export type PermissionTier = RiskLevel;
export interface TransferPolicy { dailyLimit: number; countTowardDaily: boolean; }
