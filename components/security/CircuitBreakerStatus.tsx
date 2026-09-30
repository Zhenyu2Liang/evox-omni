export interface CircuitBreakerStatusProps {
  tripped: boolean;
  failureCount?: number;
  maxAttempts?: number;
  className?: string;
}

export function CircuitBreakerStatus(_props: CircuitBreakerStatusProps) {
  return null;
}
